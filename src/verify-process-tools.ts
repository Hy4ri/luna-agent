// Scripted model, real native runtime tools and OS processes. No external services.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime, type Runtime } from "./runtime.js";
import { createApp } from "./server.js";
import { Children } from "./delegate.js";

const dir = mkdtempSync(join(tmpdir(), "luna-process-tools-"));
const work = join(dir, "work"); mkdirSync(work);
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
type Conv = NonNullable<Awaited<ReturnType<Runtime["harness"]["conversation"]>>>;
const requests = new Map<string, { tool: string; args: any; result?: any }>();
const completionTurns = new Map<string, number>();
function messageText(content: any): string { return typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""); }
faux.setResponses(Array.from({ length: 1500 }, () => (c: any) => {
  const user = messageText(c.messages.findLast((msg: any) => msg.role === "user")?.content);
  if (user.startsWith("Background process ")) {
    const id = /^Background process ([a-f0-9-]+) finished:/.exec(user)?.[1];
    if (id) completionTurns.set(id, (completionTurns.get(id) ?? 0) + 1);
    return fauxAssistantMessage("Process completion accepted.");
  }
  const request = requests.get(user);
  if (!request) return fauxAssistantMessage("Test input accepted.");
  const last = c.messages.at(-1);
  if (last?.role === "toolResult") { request.result = last; return fauxAssistantMessage("Tool result accepted."); }
  return fauxAssistantMessage([fauxToolCall(request.tool, request.args)], { stopReason: "toolUse" });
}));
async function until(check: () => boolean | Promise<boolean>, label = "condition") {
  const deadline = Date.now() + 12000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 15)); }
}
function prepare(tool: string, args: any) {
  const key = `invoke:${randomUUID()}`, request = { tool, args, result: undefined as any }; requests.set(key, request);
  return { key, request };
}
async function invoke(conv: Conv, tool: string, args: any) {
  const { key, request } = prepare(tool, args);
  const result = await (await conv.submit({ type: "input", content: key }, context)).wait(context);
  assert.equal(result.status, "done"); assert.ok(request.result, `Missing ${tool} tool result`);
  const body = messageText(request.result.content);
  return { error: !!request.result.isError, text: body, data: () => JSON.parse(body) };
}
async function call(conv: Conv, tool: string, args: any) { const r = await invoke(conv, tool, args); assert.equal(r.error, false, r.text); return r.data(); }
async function finished(conv: Conv, id: string) { await until(() => completionTurns.has(id), `completion ${id}`); await conv.waitForIdle(context); assert.equal(completionTurns.get(id), 1); }
function alive(pid: number) {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; }
  catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}
const cfg = parseConfig({ dataDir: join(dir, "data"), cwd: work, extensions: ["coding"], processes: { enabled: true, retentionHours: 168, maxOutputBytes: 2048 }, cron: { notifyUrl: "http://notification.invalid/process" } }, dir, {});
const notifications: { body: string; title: string }[] = [];
const fetchMock: typeof fetch = async (_url, opts) => { notifications.push({ body: String(opts?.body), title: new Headers(opts?.headers).get("Title") ?? "" }); return new Response("ok"); };
let rt: Runtime | undefined;
const releases: string[] = [];
try {
  assert.deepEqual(parseConfig({}, dir, {}).processes, { enabled: false, retentionHours: 168, maxOutputBytes: 1048576 });
  for (const processes of [{ maxOutputBytes: 1023 }, { retentionHours: 0 }, { enabled: "yes" }, { extra: true }]) assert.throws(() => parseConfig({ processes }, dir, {}), /invalid luna config/);
  const disabled = await startRuntime(parseConfig({ dataDir: join(dir, "disabled"), extensions: ["coding"] }, dir, {}), { models, model });
  try {
    const conv = await disabled.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    assert.ok((await conv.agent(context)).tools.some(t => t.name === "process_start"));
    const marker = join(work, "disabled-must-not-run");
    const denied = await invoke(conv, "process_start", { command: `touch '${marker}'` }); assert.ok(denied.error); assert.match(denied.text, /disabled/i); assert.equal(existsSync(marker), false);
  } finally { await disabled.close(); }
  rt = await startRuntime(cfg, { models, model, fetch: fetchMock });
  const owner = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: work } }, context);
  const foreign = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const release = join(work, "release"), ready = join(work, "ready"), end = join(work, "finished"); releases.push(release);
  const job = await call(owner, "process_start", { command: `printf 'stdout-start\\n'; printf 'stderr-start\\n' >&2; pwd; touch '${ready}'; while [ ! -f '${release}' ]; do sleep 0.03; done; printf 'final-output\\n'; touch '${end}'` });
  assert.equal(job.running, true); assert.equal(job.status, "running"); assert.equal(existsSync(end), false, "Receipt must not wait for command completion");
  await until(() => existsSync(ready));
  let live: any;
  await until(async () => { live = await call(owner, "process_manage", { action: "read", id: job.id }); return live.output.includes("stderr-start"); });
  assert.equal(live.running, true); assert.ok(live.output.includes("stdout-start")); assert.ok(live.output.includes(realpathSync(work)));
  // Web UI view: the session payload and process endpoints honor the same ownership as the tools.
  const app = createApp({ harness: rt.harness, models });
  const http = async (path: string, method = "GET") => { const r = await app.request(path, { method }); return { status: r.status, body: await r.json() as any }; };
  const session = (await http(`/v1/sessions/${owner.id}`)).body;
  assert.ok(session.processes.some((p: any) => p.id === job.id && p.running && p.command.includes("stdout-start")));
  assert.deepEqual((await http(`/v1/sessions/${foreign.id}`)).body.processes, []);
  const view = await http(`/v1/sessions/${owner.id}/processes/${job.id}`); assert.equal(view.status, 200); assert.ok(view.body.output.includes("stderr-start")); assert.equal(view.body.running, true);
  assert.equal((await http(`/v1/sessions/${foreign.id}/processes/${job.id}`)).status, 404);
  assert.equal((await http(`/v1/sessions/${foreign.id}/processes/${job.id}/stop`, "POST")).status, 404);
  assert.equal((await call(owner, "process_manage", { action: "read", id: job.id })).running, true, "Foreign HTTP stop must not stop the process");
  await rt.harness.commit(async tx => { (await tx.doc(Children, owner.id)).children.push({ id: foreign.id as number, spawnKey: "fixture", task: "Fixture subagent" }); }, context);
  assert.deepEqual((await http(`/v1/sessions/${owner.id}`)).body.children.map((c: any) => [c.id, c.task, c.status]), [[foreign.id, "Fixture subagent", "ready"]]);
  const httpStop = await call(owner, "process_start", { command: "sleep 30" });
  assert.equal((await http(`/v1/sessions/${owner.id}/processes/${httpStop.id}/stop`, "POST")).status, 200);
  await finished(owner, httpStop.id);
  assert.equal((await http(`/v1/sessions/${owner.id}/processes/${httpStop.id}`)).body.status, "stopped");
  console.log("OK web session activity: owned process list/output/stop, foreign 404, subagent status");
  const rows = await call(owner, "process_manage", { action: "list" }); assert.ok(rows.some((p: any) => p.id === job.id && p.running));
  assert.equal((await call(owner, "process_manage", { action: "wait", id: job.id, timeoutSec: 0.02 })).running, true);
  const unknown = await invoke(foreign, "process_manage", { action: "read", id: "unknown" });
  for (const action of ["read", "wait", "stop"]) { const r = await invoke(foreign, "process_manage", { action, id: job.id, timeoutSec: 0 }); assert.ok(r.error); assert.equal(r.text, unknown.text); }
  assert.deepEqual(await call(foreign, "process_manage", { action: "list" }), []);
  // Abort a live wait through the durable runtime. The separately admitted OS command must survive.
  const waiting = prepare("process_manage", { action: "wait", id: job.id, timeoutSec: 60 });
  const submission = await owner.submit({ type: "input", content: waiting.key }, context);
  await until(async () => (await rt!.harness.snapshot(LiveDoc, owner.id, context))?.tools?.some(t => t.name === "process_manage" && t.status === "running") ?? false);
  await owner.abort(context); assert.equal((await submission.wait(context)).status, "unanswered");
  assert.equal((await call(owner, "process_manage", { action: "read", id: job.id })).running, true);
  for (const args of [{ action: "read", id: job.id, offset: 0.2 }, { action: "read", id: job.id, limit: 1.2 }, { action: "wait", id: job.id, timeoutSec: -1 }]) assert.ok((await invoke(owner, "process_manage", args)).error);
  for (const args of [{ command: "   " }, { command: `touch '${end}'`, timeoutSec: 0 }, { command: "true", extra: true }]) assert.ok((await invoke(owner, "process_start", args)).error);
  assert.equal(existsSync(end), false);
  writeFileSync(release, "go"); await finished(owner, job.id);
  const final = await call(owner, "process_manage", { action: "read", id: job.id });
  assert.equal(final.status, "complete"); assert.equal(final.exitCode, 0); assert.ok(final.output.includes("final-output")); assert.equal(existsSync(end), true);
  const entries = (await owner.entries({ order: "ascending" }, 500, undefined, context)).items;
  assert.equal(entries.filter(e => e.kind === "pi.user" && e.model?.some(msg => msg.role === "user" && messageText(msg.content).startsWith(`Background process ${job.id} finished:`))).length, 1);
  assert.equal((await foreign.entries({ order: "ascending" }, 500, undefined, context)).items.some(e => e.model?.some(msg => msg.role === "user" && messageText(msg.content).includes(`Background process ${job.id} finished:`))), false);
  assert.ok(notifications.some(n => n.title.includes(String(owner.id)))); assert.ok(notifications.every(n => !n.body.includes("stdout-start") && !n.body.includes("final-output")));
  console.log("OK native immediate admission, live stdout/stderr, wait timeout/abort, validation, ownership, automatic owner resume and status-only notification");
  const failed = await call(owner, "process_start", { command: "printf 'failure-output'; exit 42" }); await finished(owner, failed.id);
  const failure = await call(owner, "process_manage", { action: "wait", id: failed.id }); assert.equal(failure.status, "failed"); assert.equal(failure.exitCode, 42); assert.equal(failure.output, "failure-output");
  const spawnError = await call(owner, "process_start", { command: "true", cwd: "nonexistent-working-directory" }); await finished(owner, spawnError.id);
  assert.equal((await call(owner, "process_manage", { action: "read", id: spawnError.id })).status, "failed");
  const timeout = await call(owner, "process_start", { command: "sleep 30", timeoutSec: 0.03 }); await finished(owner, timeout.id);
  assert.match((await call(owner, "process_manage", { action: "read", id: timeout.id })).error, /timeout/);
  const leaderFile = join(work, "leader"), childFile = join(work, "child"), stopRelease = join(work, "stop-release"), escapedMarker = join(work, "must-not-execute"); releases.push(stopRelease);
  const group = await call(owner, "process_start", { command: `echo $$ > '${leaderFile}'; (echo $BASHPID > '${childFile}'; while [ ! -f '${stopRelease}' ]; do sleep 0.03; done; touch '${escapedMarker}') & wait` });
  await until(() => existsSync(childFile));
  const leader = Number(readFileSync(leaderFile, "utf8")), child = Number(readFileSync(childFile, "utf8")); assert.ok(alive(leader)); assert.ok(alive(child));
  const stopped = await call(owner, "process_manage", { action: "stop", id: group.id, timeoutSec: 5 }); assert.equal(stopped.status, "stopped");
  await finished(owner, group.id); await until(() => !alive(leader) && !alive(child), "process group death"); writeFileSync(stopRelease, "go"); assert.equal(existsSync(escapedMarker), false);
  const again = await call(owner, "process_manage", { action: "stop", id: failed.id }); assert.equal(again.status, "failed"); assert.equal(again.exitCode, 42);
  const big = await call(owner, "process_start", { command: `node -e 'process.stdout.write("😀".repeat(900)+"OUTPUT-END")'` }); await finished(owner, big.id);
  const tail = await call(owner, "process_manage", { action: "read", id: big.id, offset: 0 }); assert.equal(tail.truncated, true); assert.ok(Buffer.byteLength(tail.output) <= 2048); assert.ok(tail.output.endsWith("OUTPUT-END")); assert.ok(!tail.output.includes("�"));
  const oneCharacter = await call(owner, "process_manage", { action: "read", id: big.id, offset: 0, limit: 1 });
  assert.equal(oneCharacter.output, "😀", "Pages must not split a surrogate pair");
  let pages = "", offset = 0;
  do { const page = await call(owner, "process_manage", { action: "read", id: big.id, offset, limit: 127 }); pages += page.output; offset = page.nextOffset; } while (offset !== undefined);
  assert.equal(pages, tail.output);
  const processDir = join(cfg.dataDir, "processes");
  assert.equal(statSync(processDir).mode & 0o777, 0o700);
  for (const file of readdirSync(processDir).filter(f => f.endsWith(".json"))) { const path = join(processDir, file); assert.equal(statSync(path).mode & 0o777, 0o600); assert.ok(Buffer.byteLength(JSON.parse(readFileSync(path, "utf8")).output) <= 2048); }
  console.log("OK exact nonzero exit, spawn error, command timeout, real group termination, UTF-8 retention and output paging");
  // Deleting and recreating the reserved root must not transfer ownership.
  const root = await rt.harness.root(context, { agent: { model } }); assert.equal(root.id, ROOT_CONVERSATION_ID);
  const rootRelease = join(work, "root-release"); releases.push(rootRelease);
  const rootJob = await call(root, "process_start", { command: `while [ ! -f '${rootRelease}' ]; do sleep 0.03; done; printf old-root-secret` });
  await root.waitForIdle(context); await rt.conversations.delete(Number(root.id));
  const replacement = await rt.harness.root(context, { agent: { model } });
  assert.ok((await invoke(replacement, "process_manage", { action: "read", id: rootJob.id })).error);
  writeFileSync(rootRelease, "go");
  await until(() => JSON.parse(readFileSync(join(processDir, rootJob.id + ".json"), "utf8")).delivered === true);
  assert.equal(completionTurns.has(rootJob.id), false);
  const shutdown = await call(owner, "process_start", { command: "printf shutdown-output; sleep 30" });
  await until(async () => (await call(owner, "process_manage", { action: "read", id: shutdown.id })).output.includes("shutdown-output"));
  await rt.close(); rt = undefined;
  // Restart interruption fixture: no command is launched, only prior durable state is edited.
  const fixture = JSON.parse(readFileSync(join(processDir, spawnError.id + ".json"), "utf8")), interruptedId = randomUUID();
  fixture.id = interruptedId; fixture.command = `touch '${join(work, "must-not-replay")}'`;
  fixture.status = "running"; fixture.exitCode = null; fixture.delivered = false; delete fixture.finishedAt;
  writeFileSync(join(processDir, interruptedId + ".json"), JSON.stringify(fixture), { mode: 0o600 });
  rt = await startRuntime(cfg, { models, model, fetch: fetchMock });
  const restored = await rt.harness.conversation(owner.id, context); assert.ok(restored);
  await finished(restored, shutdown.id); await finished(restored, interruptedId);
  const saved = await call(restored, "process_manage", { action: "read", id: job.id }); assert.equal(saved.status, "complete"); assert.equal(saved.exitCode, 0); assert.equal(saved.output, final.output);
  assert.equal(existsSync(join(work, "must-not-replay")), false);
  const interrupted = await call(restored, "process_manage", { action: "read", id: interruptedId }); assert.equal(interrupted.status, "interrupted"); assert.equal(interrupted.exitCode, null); assert.match(interrupted.error, /may still run/);
  const stoppedOnClose = await call(restored, "process_manage", { action: "read", id: shutdown.id }); assert.equal(stoppedOnClose.status, "stopped"); assert.ok(stoppedOnClose.output.includes("shutdown-output"));
  const restoredForeign = await rt.harness.conversation(foreign.id, context); assert.ok(restoredForeign); assert.ok((await invoke(restoredForeign, "process_manage", { action: "read", id: job.id })).error);
  await rt.close(); rt = undefined;
  // Simulate a crash between durable submission receipt and marking a delivery complete.
  const duplicatePath = join(processDir, job.id + ".json"), duplicate = JSON.parse(readFileSync(duplicatePath, "utf8"));
  duplicate.delivered = false; writeFileSync(duplicatePath, JSON.stringify(duplicate), { mode: 0o600 });
  const expiredId = randomUUID(), pendingId = randomUUID();
  for (const [id, delivered] of [[expiredId, true], [pendingId, false]] as const)
    writeFileSync(join(processDir, id + ".json"), JSON.stringify({ ...duplicate, id, delivered, finishedAt: Date.now() - 169 * 3600000 }), { mode: 0o600 });
  writeFileSync(join(processDir, "corrupt.json"), "not JSON", { mode: 0o600 });
  const logs: string[] = [];
  rt = await startRuntime(cfg, { models, model, fetch: fetchMock, log: msg => logs.push(msg) });
  assert.equal(existsSync(join(processDir, expiredId + ".json")), false, "Expired delivered output must be removed");
  assert.equal(existsSync(join(processDir, pendingId + ".json")), true, "Pending delivery must survive initial retention pruning");
  assert.ok(logs.some(msg => msg.includes("Cannot load process record corrupt.json")));
  const finalOwner = await rt.harness.conversation(owner.id, context); assert.ok(finalOwner);
  await finished(finalOwner, pendingId);
  assert.equal(completionTurns.get(job.id), 1, "Replayed delivery request must not duplicate the owner turn");
  assert.equal(completionTurns.get(shutdown.id), 1, "Successful delivery must not repeat on restart");
  await call(finalOwner, "process_manage", { action: "list" });
  assert.equal(existsSync(join(processDir, pendingId + ".json")), false, "Expired output can be removed after delivery succeeds");
  await rt.close(); rt = undefined;
  rt = await startRuntime({ ...cfg, processes: { ...cfg.processes, maxOutputBytes: 131072 } }, { models, model, fetch: fetchMock, log: msg => logs.push(msg) });
  const encodedOwner = await rt.harness.conversation(owner.id, context); assert.ok(encodedOwner);
  const escaped = await call(encodedOwner, "process_start", { command: `node -e 'process.stdout.write(String.fromCharCode(0).repeat(60000)+"ESCAPED-END")'` });
  await finished(encodedOwner, escaped.id);
  const encoded = await invoke(encodedOwner, "process_manage", { action: "read", id: escaped.id }); assert.equal(encoded.error, false);
  assert.ok(Buffer.byteLength(encoded.text) <= 40000); assert.ok(encoded.data().output.endsWith("ESCAPED-END"), "Size-limited default reads must still return the newest tail");
  const encodedPage = await call(encodedOwner, "process_manage", { action: "read", id: escaped.id, offset: 0, limit: 40000 }); assert.ok(encodedPage.nextOffset > 0); assert.ok(encodedPage.nextOffset < 40000);
  console.log("PROCESS_TOOLS_OK: real runtime lifecycle, root ownership, resume/dedup, shutdown/restart, retention, interrupted-state fixture and encoded-output bounds");
} finally { for (const file of releases) writeFileSync(file, "go"); await rt?.close(); rmSync(dir, { recursive: true, force: true }); }
