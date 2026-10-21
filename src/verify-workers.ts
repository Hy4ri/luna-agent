// Multi-machine execution: a real daemon HTTP server, a worker in a separate OS process, and a scripted model that
// drives the real bash/read/write/edit/process tools. Proves routing, isolation, offline and disconnect semantics.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket from "ws";
import { serve } from "@hono/node-server";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime, type Runtime } from "./runtime.js";
import { createApp } from "./server.js";
import { CONNECT_PATH, isWorkerEnv } from "./worker-protocol.js";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { materializeVideo } from "./video-source.js";
import { confinedRead } from "./confined-read.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "luna-workers-")));
const mainCwd = join(dir, "main"), workerCwd = join(dir, "worker");
mkdirSync(mainCwd); mkdirSync(workerCwd);
const faux = fauxProvider();
const aux = fauxProvider({ api: "anthropic-messages", provider: "aux", models: [{ id: "vision", input: ["text", "image"] }] });
aux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("blue image")));
const models = createModels(); models.setProvider(faux.provider); models.setProvider(aux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
type Conv = NonNullable<Awaited<ReturnType<Runtime["harness"]["conversation"]>>>;
const deliveries: string[] = [];
const requests = new Map<string, { tool: string; args: any; result?: any; system?: string; answer?: string }>();
const text = (content: any): string => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
faux.setResponses(Array.from({ length: 500 }, () => (c: any) => {
  const user = text(c.messages.findLast((msg: any) => msg.role === "user")?.content);
  if (user.startsWith("Background process ")) deliveries.push(user);
  const request = requests.get(user);
  if (!request) return fauxAssistantMessage("ok");
  // Sections arrive as system messages; later ones replace or (null) remove a section by name.
  let machine: string | null = null;
  for (const msg of c.messages) if (msg.role === "system" && msg.sections && "machine" in msg.sections) machine = msg.sections.machine;
  request.system = machine ?? "";
  const last = c.messages.at(-1);
  if (last?.role === "toolResult") { request.result = last; return fauxAssistantMessage(request.answer ?? "done"); }
  return fauxAssistantMessage([fauxToolCall(request.tool, request.args)], { stopReason: "toolUse" });
}));
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 25)); }
}
function start(conv: Conv, tool: string, args: any) {
  const key = `invoke:${randomUUID()}`, request = { tool, args } as { tool: string; args: any; result?: any; system?: string; answer?: string };
  requests.set(key, request);
  const done = conv.submit({ type: "input", content: key }, context).then(s => s.wait(context));
  return { request, done };
}
async function invoke(conv: Conv, tool: string, args: any) {
  const { request, done } = start(conv, tool, args);
  assert.equal((await done).status, "done");
  assert.ok(request.result, `missing ${tool} result`);
  return { error: !!request.result.isError, text: text(request.result.content), content: request.result.content as any[], system: request.system ?? "" };
}
async function ok(conv: Conv, tool: string, args: any) { const r = await invoke(conv, tool, args); assert.equal(r.error, false, r.text); return r; }

const cfg = parseConfig({ dataDir: join(dir, "data"), cwd: mainCwd, extensions: ["coding", "ask-user", "delegate"], subagents: { cwd: mainCwd }, processes: { enabled: true, retentionHours: 168, maxOutputBytes: 65536 }, auxiliary: { vision: { provider: "aux", model: "vision" } }, image_gen: { provider: "img-fake" } }, dir, {});
let rt: Runtime | undefined, server: Server | undefined, worker: ChildProcess | undefined;
const workerLog: string[] = [];
const orphanTag = `luna-orphan-${randomUUID()}`;
function startWorkerProcess(url: string, token: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LUNA_URL: url, LUNA_WORKER_TOKEN: token, LUNA_WORKER_CWD: workerCwd, LUNA_TEST_SIDE: "worker-side" },
  });
  child.stdout!.on("data", d => workerLog.push(String(d))); child.stderr!.on("data", d => workerLog.push(String(d)));
  return child;
}
const exited = (child: ChildProcess) => new Promise<void>(r => { if (child.exitCode !== null || child.signalCode !== null) r(); else child.once("exit", () => r()); });

try {
  const imageFake: import("./image-gen.js").ImageGenProvider = {
    name: "img-fake", is_available: () => true, capabilities: () => ({ edit: true }),
    async generate(request) {
      const sharp = (await import("sharp")).default;
      const out = join(mainCwd, request.prompt === "clash" ? "clash.png" : "generated.png");
      await sharp({ create: { width: 16, height: 16, channels: 3, background: "green" } }).png().toFile(out);
      return { success: true, image: out, model: "f", prompt: request.prompt, aspect_ratio: request.aspect_ratio, provider: "img-fake", modality: "text-to-image" as const };
    },
  };
  rt = await startRuntime(cfg, { models, model, imageGenProviders: new Map([["img-fake", imageFake]]) });
  const token = "main-token";
  const app = createApp({ harness: rt.harness, token, agent: { model }, models: rt.models, conversations: rt.conversations, workers: rt.workers, sideCommands: rt.sideCommands });
  server = await new Promise<Server>(resolve => { const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s as Server)); });
  rt.workers.attach(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };

  // Registry: token shown once, stored hashed; names validated; HTTP API stays behind the main token.
  assert.equal((await fetch(base + "/v1/workers")).status, 401);
  assert.equal((await api("POST", "/v1/workers", { name: "main" })).status, 400);
  assert.equal((await api("POST", "/v1/workers", { name: "" })).status, 400);
  const created = await api("POST", "/v1/workers", { name: "desk" });
  assert.equal(created.status, 201); assert.match(created.body.token, /^lw_/);
  assert.equal((await api("POST", "/v1/workers", { name: "DESK" })).status, 409);
  const workerId = created.body.worker.id as number;
  const raw = readFileSync(join(cfg.dataDir, "workers.db"));
  assert.equal(raw.includes(Buffer.from(created.body.token)), false, "plain worker token must not be stored");
  let list = (await api("GET", "/v1/workers")).body.workers;
  assert.equal(list.length, 1); assert.equal(list[0].online, false); assert.equal("token" in list[0], false);

  // Wrong worker token and the main API token are both refused at the WebSocket upgrade.
  for (const bad of ["lw_wrong", token]) {
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(base.replace("http", "ws") + CONNECT_PATH, { headers: { authorization: `Bearer ${bad}` } });
      ws.on("unexpected-response", (_q, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on("open", () => { resolve(101); ws.close(); });
      ws.on("error", () => {});
    });
    assert.equal(status, 401, `token ${bad} must be refused`);
  }

  // A session that targets an offline worker fails fast and runs nothing on main.
  assert.equal((await api("POST", "/v1/sessions", { worker: 999 })).status, 400);
  const sid = (await api("POST", "/v1/sessions", { worker: workerId })).body.id;
  const conv = (await rt.harness.conversation(sid, context))!;
  const offline = await invoke(conv, "bash", { command: `touch '${join(mainCwd, "must-not-exist")}'` });
  assert.ok(offline.error); assert.match(offline.text, /offline\. Nothing ran/);
  assert.equal(existsSync(join(mainCwd, "must-not-exist")), false);
  assert.match(offline.system, /run on execution machine "desk"/);
  assert.deepEqual((await api("GET", `/v1/sessions/${sid}`)).body.machine, { id: workerId, name: "desk", online: false });

  // Worker comes online: separate process, own environment, own default directory.
  worker = startWorkerProcess(base, created.body.token);
  await until(async () => (await api("GET", "/v1/workers")).body.workers[0].online, "worker online");
  list = (await api("GET", "/v1/workers")).body.workers;
  assert.equal(list[0].capabilities.cwd, workerCwd); assert.equal(list[0].capabilities.platform, process.platform);
  // A second process with the same token cannot replace the live worker.
  const duplicateCode = await new Promise<number>(resolve => {
    const ws = new WebSocket(base.replace("http", "ws") + CONNECT_PATH, { headers: { authorization: `Bearer ${created.body.token}` } });
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", protocol: 1, capabilities: list[0].capabilities })));
    ws.on("close", code => resolve(code)); ws.on("error", () => {});
  });
  assert.equal(duplicateCode, 4009);
  assert.equal(rt.workers.view(workerId)?.online, true);
  const where = await ok(conv, "bash", { command: "printf '%s|%s|%s' \"$LUNA_TEST_SIDE\" \"$(pwd)\" \"$PPID\"" });
  const [side, pwd, ppid] = where.text.trim().split("|");
  assert.equal(side, "worker-side"); assert.equal(pwd, workerCwd);
  assert.notEqual(Number(ppid), process.pid, "command must not be a child of the main daemon");
  assert.match(where.system, /hostname .*default directory/);

  // File tools: write, edit, read (binary reader handles), all on the worker's file system.
  const file = join(workerCwd, "notes.txt");
  await ok(conv, "write", { path: "notes.txt", content: Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") });
  assert.ok(existsSync(file)); assert.equal(existsSync(join(mainCwd, "notes.txt")), false);
  await ok(conv, "edit", { path: "notes.txt", edits: [{ oldText: "line 2500\n", newText: "line 2500 edited\n" }] });
  assert.match(readFileSync(file, "utf8"), /line 2500 edited\n/);
  const read = await ok(conv, "read", { path: "notes.txt", offset: 2499, limit: 2 });
  assert.match(read.text, /line 2499\nline 2500 edited/); assert.match(read.text, /500 more lines/);
  const missing = await invoke(conv, "read", { path: "nope.txt" });
  assert.ok(missing.error); assert.match(missing.text, /not.?found|ENOENT|no such file/i);
  writeFileSync(join(workerCwd, "bin.dat"), Buffer.from([0, 1, 2, 255, 254]));
  const bin = await ok(conv, "bash", { command: "od -An -tu1 bin.dat" });
  assert.match(bin.text, /0\s+1\s+2\s+255\s+254/);

  // Fresh and forked children keep the worker target. A main-host subagent default cwd must not leak across hosts.
  for (const fork of [false, true]) {
    const delegated = await ok(conv, "delegate_task", { action: "spawn", task: "worker child", fork });
    const childId = Number(/spawned child (\d+)/.exec(delegated.text)?.[1]);
    assert.ok(childId);
    const child = (await rt.harness.conversation(childId as never, context))!;
    await child.waitForIdle(context);
    const childWhere = await ok(child, "bash", { command: "pwd; echo $LUNA_TEST_SIDE" });
    assert.match(childWhere.text, /worker-side/); assert.ok(childWhere.text.includes(workerCwd));
    assert.equal((await api("GET", `/v1/sessions/${childId}/machine`)).body.machine.id, workerId);
  }

  const bgKey = `invoke:${randomUUID()}`;
  requests.set(bgKey, { tool: "bash", args: { command: "pwd; echo bg-worker > bg-child.txt" } });
  const bg = await api("POST", `/v1/sessions/${sid}/messages`, { content: `/bg ${bgKey}` });
  assert.equal(bg.status, 202);
  await until(async () => {
    const jobs = (await api("GET", `/v1/sessions/${sid}/side-jobs`)).body.jobs;
    return jobs.some((j: { id: string; status: string }) => j.id === bg.body.job.id && j.status === "complete");
  }, "background child finishes on worker");
  assert.equal(readFileSync(join(workerCwd, "bg-child.txt"), "utf8").trim(), "bg-worker");
  assert.equal(existsSync(join(mainCwd, "bg-child.txt")), false);

  // Vision tools read local images from the worker environment, never falling back to main.
  const workerImg = join(workerCwd, "worker-img.png");
  const sharp = (await import("sharp")).default;
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toFile(workerImg);
  assert.equal(existsSync(join(mainCwd, "worker-img.png")), false);
  const vision = await ok(conv, "vision_analyze", { image_url: "worker-img.png", question: "what color?" });
  assert.equal(vision.error, false);
  const missingImg = await invoke(conv, "vision_analyze", { image_url: "nonexistent.png", question: "what color?" });
  assert.ok(missingImg.error);
  assert.match(missingImg.text, /Image read failed on worker/);

  // Image generation stages the output file on the worker so the worker session can access it.
  const generatedRes = await ok(conv, "image_generate", { prompt: "generate logo" });
  const generated = JSON.parse(generatedRes.text);
  assert.equal(generated.success, true);
  assert.ok(generated.image.includes(workerCwd), `Expected worker path, got ${generated.image}`);
  assert.ok(existsSync(generated.image), "Generated image must exist on the worker");
  assert.ok(generatedRes.content.some(b => b.type === "image"), "Preview must load from the staged worker path");
  assert.ok(!/preview delivery failed/.test(generatedRes.text));
  // A staging failure is a distinct delivery error; the main artifact is kept and nothing regenerates.
  mkdirSync(join(workerCwd, "clash.png"));
  const clash = await invoke(conv, "image_generate", { prompt: "clash" });
  assert.equal(clash.error, true);
  const clashData = JSON.parse(clash.text);
  assert.equal(clashData.error_type, "worker_delivery_failed");
  assert.equal(clashData.image, join(mainCwd, "clash.png"));
  assert.ok(existsSync(join(mainCwd, "clash.png")));

  // Worker image editing checks working-directory confinement
  const escapeImg = join(dir, "outside.png");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "yellow" } }).png().toFile(escapeImg);
  const outsideEdit = await invoke(conv, "image_generate", { prompt: "edit logo", image_url: escapeImg });
  assert.equal(outsideEdit.error, true);
  assert.match(outsideEdit.text, /outside the conversation working directory/);
  assert.equal(JSON.parse(outsideEdit.text).success, false);

  // Video path protections apply to worker sessions too
  const blockedVideo = join(workerCwd, "blocked.mp4");
  writeFileSync(blockedVideo, Buffer.from("fake video content"));
  // Check/read race: the policy is checked on the opened descriptor, and the bytes come from it.
  {
    const raceRoot = join(workerCwd, "race"), outsideDir = join(dir, "race-outside");
    mkdirSync(raceRoot, { recursive: true }); mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.png"), "OUTSIDE");
    const policy = { root: raceRoot, maxBytes: 1024 };
    // Inside at open, swapped to an outside link before the check: the read still returns the opened inside file.
    writeFileSync(join(raceRoot, "a.png"), "INSIDE");
    const swapOut = async () => { renameSync(join(raceRoot, "a.png"), join(raceRoot, "a-moved.png")); symlinkSync(join(outsideDir, "secret.png"), join(raceRoot, "a.png")); };
    assert.equal(Buffer.from(await confinedRead("a.png", policy, { cwd: raceRoot, afterOpen: swapOut })).toString(), "INSIDE");
    // Outside at open, swapped to an inside file before the check: refused, because the opened file is outside.
    symlinkSync(join(outsideDir, "secret.png"), join(raceRoot, "b.png"));
    const swapIn = async () => { rmSync(join(raceRoot, "b.png")); writeFileSync(join(raceRoot, "b.png"), "INSIDE"); };
    await assert.rejects(confinedRead("b.png", policy, { cwd: raceRoot, afterOpen: swapIn }), /outside the conversation working directory/);
    // A parent directory swapped for a link after open does not redirect the read either.
    mkdirSync(join(raceRoot, "sub")); writeFileSync(join(raceRoot, "sub", "c.png"), "INSIDE");
    mkdirSync(join(outsideDir, "sub")); writeFileSync(join(outsideDir, "sub", "c.png"), "OUTSIDE");
    const swapParent = async () => { renameSync(join(raceRoot, "sub"), join(raceRoot, "sub-moved")); symlinkSync(join(outsideDir, "sub"), join(raceRoot, "sub")); };
    assert.equal(Buffer.from(await confinedRead("sub/c.png", policy, { cwd: raceRoot, afterOpen: swapParent })).toString(), "INSIDE");
    // Blocked paths and credential components are checked on the opened file too.
    writeFileSync(join(raceRoot, "blocked.mp4"), "BLOCKED");
    symlinkSync(join(raceRoot, "blocked.mp4"), join(raceRoot, "d.mp4"));
    const swapBlocked = async () => { rmSync(join(raceRoot, "d.mp4")); writeFileSync(join(raceRoot, "d.mp4"), "OTHER"); };
    await assert.rejects(confinedRead("d.mp4", { blocked: ["blocked.mp4"], maxBytes: 1024 }, { cwd: raceRoot, afterOpen: swapBlocked }), /Read blocked/);
    mkdirSync(join(raceRoot, ".ssh")); writeFileSync(join(raceRoot, ".ssh", "id.mp4"), "KEY");
    symlinkSync(join(raceRoot, ".ssh", "id.mp4"), join(raceRoot, "e.mp4"));
    const swapCred = async () => { rmSync(join(raceRoot, "e.mp4")); writeFileSync(join(raceRoot, "e.mp4"), "OTHER"); };
    await assert.rejects(confinedRead("e.mp4", { credentials: true, maxBytes: 1024 }, { cwd: raceRoot, afterOpen: swapCred }), /Read blocked/);
    // A file deleted after open is refused, never read blind.
    writeFileSync(join(raceRoot, "f.png"), "GONE");
    await assert.rejects(confinedRead("f.png", policy, { cwd: raceRoot, afterOpen: async () => rmSync(join(raceRoot, "f.png")) }), /changed while it was opened/);
    writeFileSync(join(raceRoot, "big.png"), "12345");
    await assert.rejects(confinedRead("big.png", { maxBytes: 4 }, { cwd: raceRoot }), /exceeds/);
  }
  // Local sessions must keep the local media guards: only a worker env takes the remote media branches.
  assert.equal(isWorkerEnv(new NodeExecutionEnv({ cwd: mainCwd })), false);
  assert.equal(isWorkerEnv(rt.workers.env(workerId, workerCwd)), true);
  // The video tool checks the API before reading, so exercise the source policy directly through the worker env.
  const remote = rt.workers.env(workerId, workerCwd);
  const videoOpts = { signal: new AbortController().signal, cwd: workerCwd, env: remote, dataDir: cfg.dataDir, blocked_paths: ["blocked.mp4"], blocked_hosts: [] };
  const rejects = (name: string) => assert.rejects(materializeVideo(name, videoOpts), /Read blocked/, name);
  await rejects("blocked.mp4");
  // A symlink cannot rename a blocked file or a credential directory on the worker.
  symlinkSync(blockedVideo, join(workerCwd, "alias.mp4"));
  await rejects("alias.mp4");
  mkdirSync(join(workerCwd, ".ssh"), { recursive: true });
  writeFileSync(join(workerCwd, ".ssh", "key.mp4"), "secret");
  symlinkSync(join(workerCwd, ".ssh", "key.mp4"), join(workerCwd, "key.mp4"));
  await rejects("key.mp4");
  writeFileSync(join(workerCwd, "fine.mp4"), "video bytes");
  assert.equal(Buffer.from((await materializeVideo("fine.mp4", videoOpts)).data, "base64").toString(), "video bytes");

  // Streaming exit codes and background processes on the worker.
  const failing = await invoke(conv, "bash", { command: "echo out; echo err >&2; exit 3" });
  assert.ok(failing.error); assert.match(failing.text, /out/); assert.match(failing.text, /err/); assert.match(failing.text, /3/);
  const job = JSON.parse((await ok(conv, "process_start", { command: "sleep 0.3; printf bg-done; touch bg-marker" })).text);
  const waited = JSON.parse((await ok(conv, "process_manage", { action: "wait", id: job.id, timeoutSec: 10 })).text);
  assert.equal(waited.status, "complete"); assert.match(waited.output, /bg-done/);
  assert.ok(existsSync(join(workerCwd, "bg-marker")));
  await until(() => deliveries.some(d => d.includes(job.id) && d.includes("bg-done")), "background completion delivered");
  await conv.waitForIdle(context);

  // The main interface answers a question while the session remains assigned to the worker.
  const asking = start(conv, "ask_user_question", { questions: [{ header: "Test", question: "Continue?", options: [
    { label: "Yes", description: "Continue the test" }, { label: "No", description: "Stop the test" },
  ] }] });
  let questionnaire: any;
  await until(async () => {
    questionnaire = (await api("GET", `/v1/sessions/${sid}?limit=1`)).body.questions[0];
    return !!questionnaire;
  }, "main sees remote-session question");
  assert.equal((await api("GET", `/v1/sessions/${sid}/machine`)).body.machine.id, workerId);
  const answered = await api("POST", `/v1/sessions/${sid}/questions/${questionnaire.callId}`, {
    answers: [{ questionIndex: 0, kind: "option", answer: "Yes" }], cancelled: false,
  });
  assert.equal(answered.status, 200);
  assert.equal((await asking.done).status, "done");
  assert.equal((await api("GET", `/v1/sessions/${sid}/machine`)).body.machine.id, workerId);

  // Abort stops the command on the worker: the marker after the sleep never appears.
  const abortMarker = join(workerCwd, "after-abort");
  const aborting = start(conv, "bash", { command: `echo started; sleep 3; touch '${abortMarker}'` });
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await api("POST", `/v1/sessions/${sid}/abort`, {})).status, 200);
  assert.equal((await api("GET", `/v1/sessions/${sid}/machine`)).body.machine.id, workerId);
  await aborting.done.catch(() => {});
  await new Promise(r => setTimeout(r, 3500));
  assert.equal(existsSync(abortMarker), false, "aborted command must be killed on the worker");

  const reader = await rt.workers.env(workerId, workerCwd).openBinaryReader("notes.txt", undefined, context);
  assert.ok(reader.ok);

  // Graceful worker stop mid-command: the command is killed on the worker and the call fails without a rerun.
  const stopMarker = join(workerCwd, "after-stop");
  const stopping = start(conv, "bash", { command: `sleep 2; touch '${stopMarker}'` });
  await new Promise(r => setTimeout(r, 500));
  worker.kill("SIGTERM"); await exited(worker);
  assert.equal((await stopping.done).status, "done");
  assert.ok(stopping.request.result.isError); assert.match(text(stopping.request.result.content), /disconnected\. The command was not rerun/);
  await until(async () => !(await api("GET", "/v1/workers")).body.workers[0].online, "worker offline");
  const after = await invoke(conv, "bash", { command: "true" });
  assert.ok(after.error); assert.match(after.text, /offline\. Nothing ran/);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(existsSync(stopMarker), false, "a stopped worker must kill its running command");

  // Crash (SIGKILL): the link drop is detected and reported as unknown state. The orphan cannot be killed by a dead process.
  worker = startWorkerProcess(base, created.body.token);
  await until(async () => (await api("GET", "/v1/workers")).body.workers[0].online, "worker back online");
  const lost = start(conv, "bash", { command: `sleep 30 # ${orphanTag}` });
  await new Promise(r => setTimeout(r, 500));
  worker.kill("SIGKILL"); await exited(worker);
  assert.equal((await lost.done).status, "done");
  assert.match(text(lost.request.result.content), /disconnected\. The command was not rerun\. Its state on the worker is unknown/);

  // Reconnect: a new worker process serves the same session again.
  worker = startWorkerProcess(base, created.body.token);
  await until(async () => (await api("GET", "/v1/workers")).body.workers[0].online, "worker online after crash");
  assert.match((await ok(conv, "bash", { command: "echo $LUNA_TEST_SIDE" })).text, /worker-side/);

  const stale = await reader.value.read(0, 8, context);
  assert.equal(stale.ok, false, "old reader must not address a reused handle on a new connection");
  if (!stale.ok) assert.match(stale.error.message, /Reader connection was lost/);
  await reader.value.close(context);

  // Explicit artifacts stream from the worker. Keep their source after execution moves to main.
  const artifact = start(conv, "bash", { command: "printf worker-artifact > artifact.txt" });
  artifact.request.answer = "MEDIA:artifact.txt";
  await artifact.done;
  const page = await conv.entries({ order: "descending" }, 10, undefined, context);
  const artifactEntry = page.items.find(e => JSON.stringify(e.model).includes("MEDIA:artifact.txt"));
  assert.ok(artifactEntry);
  const artifactPath = `/v1/sessions/${sid}/entries/${artifactEntry.id}/media/0`;
  const download = () => fetch(base + artifactPath, { headers: { authorization: `Bearer ${token}` } });
  const downloadBefore = await download(); assert.equal(downloadBefore.status, 200); assert.equal(await downloadBefore.text(), "worker-artifact");

  // Move to main: same session now runs locally in the main cwd; moving back works; a running session refuses to move.
  assert.equal((await api("PUT", `/v1/sessions/${sid}/machine`, { worker: 12345 })).status, 400);
  const moved = await api("PUT", `/v1/sessions/${sid}/machine`, { worker: null, cwd: mainCwd });
  assert.equal(moved.status, 200); assert.equal(moved.body.machine, null);
  const downloadAfter = await download(); assert.equal(downloadAfter.status, 200); assert.equal(await downloadAfter.text(), "worker-artifact", "old media stays on its original worker");
  const local = await ok(conv, "bash", { command: "printf '%s|%s' \"${LUNA_TEST_SIDE:-none}\" \"$(pwd)\"" });
  assert.equal(local.text.trim(), `none|${mainCwd}`);
  assert.equal(local.system, "", "machine section is removed on main");
  const busy = start(conv, "bash", { command: "sleep 1" });
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await api("PUT", `/v1/sessions/${sid}/machine`, { worker: workerId })).status, 409);
  await busy.done;
  assert.equal((await api("PUT", `/v1/sessions/${sid}/machine`, { worker: workerId })).status, 200);
  assert.equal((await ok(conv, "bash", { command: "pwd" })).text.trim(), workerCwd, "omitted cwd becomes the worker default");

  // Removing a worker closes its link; the worker process stops reconnecting with a refused token.
  assert.equal((await api("DELETE", `/v1/workers/${workerId}`)).status, 200);
  const gone = await invoke(conv, "bash", { command: "true" });
  assert.ok(gone.error); assert.match(gone.text, /no longer exists\. Nothing ran/);
  await until(() => worker!.exitCode !== null, "worker exits after its token is revoked");
  assert.equal(worker.exitCode, 1);
  assert.equal((await api("GET", "/v1/workers")).body.workers.length, 0);

  console.log("WORKERS_OK");
} catch (error) {
  console.error(workerLog.join(""));
  throw error;
} finally {
  worker?.kill("SIGKILL");
  spawn("pkill", ["-f", orphanTag], { stdio: "ignore" });
  server?.close();
  await rt?.close();
  rmSync(dir, { recursive: true, force: true });
}
