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
