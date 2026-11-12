import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, test, expect } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startWorker } from "../src/worker.js";
import { WorkerHub, WorkerStore, type WorkerWsData } from "../src/workers.js";

const dir = mkdtempSync(join(tmpdir(), "luna-hardening-"));
const home = join(dir, "home"); mkdirSync(home);
const config = join(dir, "c.json"); writeFileSync(config, "{}");
const saved = { LUNA_CONFIG: process.env.LUNA_CONFIG, HOME: process.env.HOME, LUNA_WORKER_MAX_FRAME_BYTES: process.env.LUNA_WORKER_MAX_FRAME_BYTES };
process.env.LUNA_WORKER_MAX_FRAME_BYTES = String(1024 * 1024);
process.env.LUNA_CONFIG = config;
const hub = new WorkerHub(new WorkerStore(join(dir, "w.db")), () => {});
const server = Bun.serve<WorkerWsData>({
  hostname: "127.0.0.1", port: 0,
  fetch(req, srv) { const r = hub.tryUpgrade(req, srv); return r !== undefined ? r ?? undefined : new Response("nf", { status: 404 }); },
  websocket: { maxPayloadLength: 256 * 1024 * 1024, open: ws => hub.wsOpen(ws), message: (ws, m) => hub.wsMessage(ws, m), pong: ws => hub.wsPong(ws), close: ws => hub.wsClose(ws) },
});
const url = "http://127.0.0.1:" + server.port;
after(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  hub.close(); await server.stop(true); rmSync(dir, { recursive: true, force: true }); });

test("worker commands cannot read the link token or the API token", async () => {
  const { worker, token } = hub.store.create("env");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/worker.ts")], {
    env: { ...process.env, HOME: home, LUNA_URL: url, LUNA_WORKER_TOKEN: token, LUNA_TOKEN: "api-secret", LUNA_WORKER_CWD: dir }, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 100 && !hub.view(worker.id)?.online; i++) await Bun.sleep(100);
    expect(hub.view(worker.id)?.online).toBeTruthy();
    let out = "";
    const r = await (hub.env(worker.id, dir) as any).exec("echo \"[$LUNA_WORKER_TOKEN][$LUNA_TOKEN]\"", { onOutput: (t: string) => { out += t; } }, BACKGROUND_CONTEXT);
    expect(r.ok).toBeTruthy();
    expect(out.trim()).toBe("[][]");
  } finally { proc.kill(); await proc.exited; }
});

let releaseFifo: (() => void) | undefined;
test("a call the worker never answers fails on its own and leaves the link up", async () => {
  hub.fileTimeoutMs = 500;
  const { worker, token } = hub.store.create("slow");
  process.env.HOME = home;
  const w = startWorker({ url, token, cwd: dir, log: () => {} });
  try {
    await w.ready;
    const fifo = join(dir, "fifo");
    await Bun.$`mkfifo ${fifo}`.quiet();
    // The worker's blocked open() holds a thread-pool thread until a writer appears. Release it at the end
    // or a small CI runner runs out of fs threads for the next test file.
    releaseFifo = () => closeSync(openSync(fifo, "r+"));
    const env = hub.env(worker.id, dir) as any;
    const r = await env.readTextFile(fifo, BACKGROUND_CONTEXT);
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/did not answer within/);
    expect(hub.view(worker.id)?.online).toBeTruthy();
    expect((await env.exists(dir, BACKGROUND_CONTEXT)).ok).toBeTruthy();
  } finally { hub.fileTimeoutMs = 120_000; releaseFifo?.(); await Bun.sleep(100); await w.close(); }
}, 20_000);

test("an oversized result fails that call only; other commands survive", async () => {
  const { worker, token } = hub.store.create("big");
  const w = startWorker({ url, token, cwd: dir, log: () => {} });
  try {
    await w.ready;
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 1));
    const env = hub.env(worker.id, dir) as any;
    const running = env.exec("sleep 2; echo alive", {}, BACKGROUND_CONTEXT);
    const r = await env.readBinaryFile(big, BACKGROUND_CONTEXT);
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/frame limit/);
    expect(hub.view(worker.id)?.online).toBeTruthy();
    const done = await running;
    expect(done.ok).toBeTruthy(); expect(done.value.exitCode).toBe(0);
  } finally { await w.close(); }
}, 60_000);
