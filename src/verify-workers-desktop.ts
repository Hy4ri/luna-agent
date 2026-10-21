// Opt-in real desktop gate. No provider calls, installs, or persistent services.
// LUNA_TEST_DESKTOP=m57@192.168.1.11 LUNA_TEST_MAIN_URL=http://192.168.1.57 pnpm run verify:workers:desktop
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";
const desktop = process.env.LUNA_TEST_DESKTOP, mainUrl = process.env.LUNA_TEST_MAIN_URL;
if (!desktop || !mainUrl) throw new Error("LUNA_TEST_DESKTOP and LUNA_TEST_MAIN_URL are required");
const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "luna-desktop-"));
const remote = `/tmp/luna-desktop-${randomUUID()}`;
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
const output: any[] = [];
faux.setResponses(Array.from({ length: 30 }, () => (c: any) => {
  const last = c.messages.at(-1);
  if (last?.role === "toolResult") { output.push(last); return fauxAssistantMessage("verified"); }
  const content = c.messages.findLast((x: any) => x.role === "user")?.content;
  const command = typeof content === "string" ? content : content?.find((x: any) => x.type === "text")?.text;
  return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
}));
const rt = await startRuntime(parseConfig({ dataDir: join(dir, "data"), extensions: ["coding"] }, dir, {}), { models, model });
const token = randomUUID();
const app = createApp({ harness: rt.harness, workers: rt.workers, models, agent: { model }, token });
const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 0 }) as Server;
rt.workers.attach(server);
await new Promise<void>(r => server.listening ? r() : server.once("listening", r));
const url = `${mainUrl}:${(server.address() as { port: number }).port}`;
let ssh: ChildProcess | undefined;
const logs: string[] = [];
async function until(check: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!check()) { if (Date.now() > deadline) throw new Error("desktop did not connect: " + logs.join("")); await new Promise(r => setTimeout(r, 100)); }
}
try {
  // Reuse the project's installed esbuild, through tsx's declared dependency. This does not install anything on desktop.
  const require = createRequire(import.meta.url);
  const { build } = require(require.resolve("esbuild", { paths: [require.resolve("tsx")] }));
  await build({ entryPoints: ["src/worker.ts"], bundle: true, platform: "node", format: "esm", outfile: join(dir, "worker.mjs"),
    banner: { js: 'import { createRequire as __workerRequire } from "node:module"; const require = __workerRequire(import.meta.url);' } });
  await run("ssh", ["-o", "BatchMode=yes", desktop, `mkdir -m 700 '${remote}'`]);
  await run("scp", ["-q", join(dir, "worker.mjs"), `${desktop}:${remote}/worker.mjs`]);
  const w = rt.workers.store.create("hyari-live");
  ssh = spawn("ssh", ["-o", "BatchMode=yes", desktop, "bash -s"], { stdio: ["pipe", "pipe", "pipe"] });
  ssh.stdout!.on("data", d => logs.push(String(d))); ssh.stderr!.on("data", d => logs.push(String(d)));
  // Credentials go through stdin, never command arguments or a saved file.
  ssh.stdin!.end(`export LUNA_URL='${url}' LUNA_WORKER_TOKEN='${w.token}' LUNA_WORKER_CWD='${remote}'\nexec node '${remote}/worker.mjs'\n`);
  await until(() => !!rt.workers.view(w.worker.id)?.online);
  assert.equal(rt.workers.view(w.worker.id)?.capabilities?.arch, "x64");
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(local + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(r.ok, await r.clone().text()); return await r.json() as any;
  };
  // Create the shared session from desktop, not from the main process.
  const createdOnDesktop = await new Promise<string>((resolve, reject) => {
    const client = spawn("ssh", ["-o", "BatchMode=yes", desktop, "node --input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", error = "";
    client.stdout.on("data", d => { out += String(d); }); client.stderr.on("data", d => { error += String(d); });
    client.on("error", reject); client.on("exit", code => code === 0 ? resolve(out) : reject(new Error(error)));
    client.stdin.end(`const r = await fetch(${JSON.stringify(url + "/v1/sessions")}, { method: "POST", headers: { authorization: ${JSON.stringify("Bearer " + token)}, "content-type": "application/json" }, body: JSON.stringify({ worker: ${w.worker.id} }) }); if (!r.ok) throw new Error(await r.text()); console.log(await r.text());`);
  });
  const { id } = JSON.parse(createdOnDesktop);
  assert.ok((await call("/v1/sessions")).sessions.some((s: { id: number }) => s.id === id), "desktop-created session is visible on main");
  const conv = (await rt.harness.conversation(id, context))!;
  await (await conv.submit({ type: "input", content: "printf 'machine='; hostname; uname -m; pwd; printf desktop-proof > proof.txt; cat proof.txt" }, context)).wait(context);
  const text = output.at(-1).content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  assert.match(text, /machine=hyari/); assert.match(text, /x86_64/); assert.ok(text.includes(remote)); assert.match(text, /desktop-proof/);
  const viewed = await call(`/v1/sessions/${id}`);
  assert.equal(viewed.machine.id, w.worker.id); assert.ok(viewed.entries.length > 0);
  // Main can view and move the same shared session, without a second agent or database on desktop.
  await call(`/v1/sessions/${id}/machine`, "PUT", { worker: null, cwd: dir });
  await (await conv.submit({ type: "input", content: "uname -m; pwd" }, context)).wait(context);
  const main = output.at(-1).content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  assert.match(main, /aarch64/); assert.ok(main.includes(dir));
  console.log("WORKERS_DESKTOP_OK: desktop x86_64 execution, shared history, explicit transfer to main aarch64");
} finally {
  rt.workers.close();
  ssh?.kill("SIGTERM");
  server.close(); await rt.close();
  await run("ssh", ["-o", "BatchMode=yes", desktop, `rm -rf '${remote}'`]).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
