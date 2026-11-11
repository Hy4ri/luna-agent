import assert from "node:assert/strict";
import { test } from "bun:test";
import { startWorker } from "../src/worker.js";
import { CONNECT_PATH, PROTOCOL_VERSION } from "../src/worker-protocol.js";

// An idle link carries only server pings. The worker must treat them as liveness and keep the link open.
test("idle worker link survives past the liveness window on server pings alone", async () => {
  let opens = 0, closes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { return new URL(req.url).pathname === CONNECT_PATH && srv.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: {
      open(ws) { opens++; (ws as any).t = setInterval(() => ws.ping(), 100); },
      message(ws) { ws.send(JSON.stringify({ t: "welcome", protocol: PROTOCOL_VERSION, workerId: 1, name: "t" })); },
      close(ws) { closes++; clearInterval((ws as any).t); },
    },
  });
  const w = startWorker({ url: `http://127.0.0.1:${server.port}`, token: "x", cwd: "/tmp", log: () => {}, livenessMs: 500 });
  try {
    await w.ready;
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(opens, 1);
    assert.equal(closes, 0);
  } finally { await w.close(); await server.stop(true); }
});

// A main that accepts the socket but never welcomes must not hold the worker for the full liveness window.
test("a link without a welcome closes at the handshake deadline and retries", async () => {
  let opens = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { return new URL(req.url).pathname === CONNECT_PATH && srv.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: { open() { opens++; }, message() { /* never welcome */ }, close() {} },
  });
  const w = startWorker({ url: `http://127.0.0.1:${server.port}`, token: "x", cwd: "/tmp", log: () => {}, livenessMs: 60_000, handshakeMs: 200, retryMs: 50 });
  try {
    const start = performance.now();
    while (opens < 2 && performance.now() - start < 3000) await new Promise(r => setTimeout(r, 20));
    assert.ok(opens >= 2, "worker must give up on a silent link and reconnect");
  } finally { await w.close(); await server.stop(true); }
});

// A main that accepts and drops at once must not cause a fixed-rate reconnect storm: TCP open is not stability.
test("links that drop right after open back off instead of retrying at the base delay", async () => {
  const opens: number[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { return new URL(req.url).pathname === CONNECT_PATH && srv.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: { open(ws) { opens.push(performance.now()); ws.close(1011, "drop"); }, message() {}, close() {} },
  });
  const w = startWorker({ url: `http://127.0.0.1:${server.port}`, token: "x", cwd: "/tmp", log: () => {}, retryMs: 40 });
  try {
    await new Promise(r => setTimeout(r, 1500));
    // 40, 80, 160, 320, 640 ms (minus jitter) fits about 5-6 attempts; a reset-on-open loop makes ~30.
    assert.ok(opens.length <= 9, `expected exponential backoff, saw ${opens.length} connects in 1.5 s`);
    assert.ok(opens.length >= 3);
  } finally { await w.close(); await server.stop(true); }
});
