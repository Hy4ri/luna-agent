import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, test, expect } from "bun:test";
import { TerminalRegistry } from "../src/terminal/registry.js";
import { localLauncher } from "../src/terminal/pty-host.js";
import { startWorker } from "../src/worker.js";
import { WorkerHub, WorkerStore, type WorkerWsData } from "../src/workers.js";

const dir = mkdtempSync(join(tmpdir(), "luna-term-worker-"));
const hub = new WorkerHub(new WorkerStore(join(dir, "w.db")), () => {});
const server = Bun.serve<WorkerWsData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const r = hub.tryUpgrade(req, srv);
    if (r !== undefined) return r ?? undefined;
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 256 * 1024 * 1024,
    open(ws) { hub.wsOpen(ws); },
    message(ws, msg) { hub.wsMessage(ws, msg); },
    pong(ws) { hub.wsPong(ws); },
    close(ws) { hub.wsClose(ws); },
  },
});
const url = `http://127.0.0.1:${server.port}`;
const { worker, token } = hub.store.create("remote");
const registry = new TerminalRegistry({
  launcher: (w, o) => w === null ? localLauncher(null, o) : hub.openPty(w, o),
  env: { SHELL: "/bin/sh", PATH: process.env.PATH, HOME: dir },
});
const w = startWorker({ url, token, cwd: dir, log: () => {} });
await w.ready;

after(async () => { registry.closeAll(); await w.close(); hub.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 25)); } };

test("a worker advertises PTY support", () => {
  expect(hub.view(worker.id)?.capabilities?.pty).toBe(true);
});

test("a terminal on a worker runs a shell there and relays input, output and exit", async () => {
  const info = await registry.create({ session: 1, worker: worker.id, cwd: dir, cols: 100, rows: 30 });
  expect(info.worker).toBe(worker.id);
  expect<string | undefined>(info.shell).toBe((process.env.SHELL ?? "/bin/sh").split("/").pop()); // the worker picks its own shell
  let out = "";
  let exit: number | null | undefined;
  const a = registry.attach(info.id, { data: d => { out += d.toString(); }, exit: i => { exit = i.exitCode; }, closed: () => {} });
  out += a.replay.toString();
  registry.write(info.id, "echo relay-$((6*7)); pwd\n");
  await until(() => out.includes("relay-42") && out.includes(dir));
  registry.write(info.id, "exit 3\n");
  await until(() => exit !== undefined);
  expect(exit).toBe(3);
  expect(registry.get(info.id)?.status).toBe("ended");
});

test("losing the worker ends its terminals with a reason", async () => {
  const info = await registry.create({ session: 2, worker: worker.id, cwd: dir });
  let reason: string | undefined, ended = false;
  registry.attach(info.id, { data: () => {}, exit: i => { ended = true; reason = i.endReason; }, closed: () => {} });
  hub.remove(worker.id);
  await until(() => ended);
  expect(reason ?? "").toMatch(/removed/i);
  await expect(registry.create({ session: 2, worker: worker.id, cwd: dir })).rejects.toThrow(/offline|unavailable|Execution machine/);
});
