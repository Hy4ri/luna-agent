import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TerminalRegistry } from "../src/terminal/registry.js";
import { localLauncher } from "../src/terminal/pty-host.js";
import { startWorker } from "../src/worker.js";
import { WorkerHub, WorkerStore } from "../src/workers.js";

const dir = mkdtempSync(join(tmpdir(), "luna-term-worker-"));
const hub = new WorkerHub(new WorkerStore(join(dir, "w.db")), () => {});
const server = createServer();
hub.attach(server);
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const { worker, token } = hub.store.create("remote");
const registry = new TerminalRegistry({
  launcher: (w, o) => w === null ? localLauncher(null, o) : hub.openPty(w, o),
  env: { SHELL: "/bin/sh", PATH: process.env.PATH, HOME: dir },
});
const w = startWorker({ url, token, cwd: dir, log: () => {} });
await w.ready;

after(async () => { registry.closeAll(); await w.close(); hub.close(); server.close(); rmSync(dir, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 25)); } };

test("a worker advertises PTY support", () => {
  assert.equal(hub.view(worker.id)?.capabilities?.pty, true);
});

test("a terminal on a worker runs a shell there and relays input, output and exit", async () => {
  const info = await registry.create({ session: 1, worker: worker.id, cwd: dir, cols: 100, rows: 30 });
  assert.equal(info.worker, worker.id);
  assert.equal(info.shell, "sh");
  let out = "";
  let exit: number | null | undefined;
  const a = registry.attach(info.id, { data: d => { out += d.toString(); }, exit: i => { exit = i.exitCode; }, closed: () => {} });
  out += a.replay.toString();
  registry.write(info.id, "echo relay-$((6*7)); pwd\n");
  await until(() => out.includes("relay-42") && out.includes(dir));
  registry.write(info.id, "exit 3\n");
  await until(() => exit !== undefined);
  assert.equal(exit, 3);
  assert.equal(registry.get(info.id)?.status, "ended");
});

test("losing the worker ends its terminals with a reason", async () => {
  const info = await registry.create({ session: 2, worker: worker.id, cwd: dir });
  let reason: string | undefined, ended = false;
  registry.attach(info.id, { data: () => {}, exit: i => { ended = true; reason = i.endReason; }, closed: () => {} });
  hub.remove(worker.id);
  await until(() => ended);
  assert.match(reason ?? "", /removed/i);
  await assert.rejects(registry.create({ session: 2, worker: worker.id, cwd: dir }), /offline|unavailable|Execution machine/);
});
