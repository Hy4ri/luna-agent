import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, test } from "bun:test";
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
    assert.ok(hub.view(worker.id)?.online);
    let out = "";
    const r = await (hub.env(worker.id, dir) as any).exec("echo \"[$LUNA_WORKER_TOKEN][$LUNA_TOKEN]\"", { onOutput: (t: string) => { out += t; } }, BACKGROUND_CONTEXT);
    assert.ok(r.ok);
    assert.equal(out.trim(), "[][]");
  } finally { proc.kill(); await proc.exited; }
});

test("a call the worker never answers fails on its own and leaves the link up", async () => {
  hub.fileTimeoutMs = 500;
  const { worker, token } = hub.store.create("slow");
  process.env.HOME = home;
  const w = startWorker({ url, token, cwd: dir, log: () => {} });
  try {
    await w.ready;
    const fifo = join(dir, "fifo");
    await Bun.$`mkfifo ${fifo}`.quiet();
    const env = hub.env(worker.id, dir) as any;
    const r = await env.readTextFile(fifo, BACKGROUND_CONTEXT);
    assert.equal(r.ok, false);
    assert.match(r.error.message, /did not answer within/);
    assert.ok(hub.view(worker.id)?.online);
    assert.ok((await env.exists(dir, BACKGROUND_CONTEXT)).ok);
  } finally { hub.fileTimeoutMs = 120_000; await w.close(); }
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
    assert.equal(r.ok, false);
    assert.match(r.error.message, /frame limit/);
    assert.ok(hub.view(worker.id)?.online);
    const done = await running;
    assert.ok(done.ok); assert.equal(done.value.exitCode, 0);
  } finally { await w.close(); }
}, 60_000);
