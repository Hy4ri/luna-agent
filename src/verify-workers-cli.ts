// Drives the existing CLI's shared-session mode over stdin. Real HTTP and SSE, no paid model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";
const dir = mkdtempSync(join(tmpdir(), "luna-workers-cli-"));
const faux = fauxProvider(); faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("terminal-result")));
const models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, extensions: [] }, dir, {}), { models, model });
const w = rt.workers.store.create("desk").worker;
const app = createApp({ harness: rt.harness, conversations: rt.conversations, workers: rt.workers, models, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once("listening", r));
const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "connect"], {
  env: { ...process.env, LUNA_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, LUNA_TOKEN: "test" }, stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", d => { output += String(d); }); child.stderr.on("data", d => { output += String(d); });
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error("CLI timeout: " + output); await new Promise(r => setTimeout(r, 20)); }
}
async function command(line: string) {
  const offset = output.length;
  child.stdin.write(line + "\n");
  await until(() => output.slice(offset).includes("> "));
  return output.slice(offset);
}
try {
  await until(() => output.includes("> "));
  const created = await command(`/new ${w.id}`);
  const id = /\[session (\d+)/.exec(created)?.[1]; assert.ok(id, created);
  assert.match(created, /desk · offline/);
  assert.match(await command("/sessions"), /desk \(offline\)/);
  assert.match(await command(`/open ${id}`), /desk · offline/);
  assert.match(await command("/status"), /desk · offline/);
  // Opening the worker session did not move its execution target.
  const conv = (await rt.harness.conversation(id as never, context))!;
  assert.equal((await rt.harness.snapshot((await import("./workers.js")).ExecTarget, conv.id, context))?.worker, w.id);
  assert.match(await command(`/machine main ${dir}`), /· main ·/);
  assert.equal((await conv.agent(context)).cwd, dir);
  await command("hello");
  await until(() => output.includes("terminal-result"));
  await command("/questions");
  assert.match(await command(`/machine ${w.id}`), /desk · offline/);
  child.stdin.write("/quit\n");
  await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, output);
  console.log("WORKERS_CLI_OK");
} finally {
  child.kill("SIGTERM");
  await new Promise<void>(r => server.close(() => r())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
