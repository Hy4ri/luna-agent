// Controlled HTTP/DNS transport tests. No public network request is made.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import sharp from "sharp";
const dir = mkdtempSync(join(tmpdir(), "vision-http-"));
const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
let dnsCalls = 0, calls = 0;
const attempts = new Map<string, number>();
mock.module("node:dns/promises", { namedExports: { lookup: async (host: string) => {
  dnsCalls++;
  if (host === "mixed.example") return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
  return [{ address: dnsCalls % 2 ? "8.8.8.8" : "1.1.1.1", family: 4 }];
} } });
function request(url: URL, options: any, callback: (res: any) => void) {
  calls++;
  assert.equal(url.hostname, "public.example");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.agent, false, "disable pooled sockets that could bypass pinning");
  options.lookup(url.hostname, { all: true }, (error: Error | null, addresses: any[]) => {
    assert.equal(error, null); assert.equal(addresses.length, 1); assert.ok(["8.8.8.8", "1.1.1.1"].includes(addresses[0].address));
  });
  const req = new EventEmitter() as EventEmitter & { end(): void };
  req.end = () => queueMicrotask(() => {
    const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
    const n = (attempts.get(url.pathname) ?? 0) + 1; attempts.set(url.pathname, n);
    res.statusCode = url.pathname === "/retry" && n === 1 ? 500 : url.pathname === "/bad" ? 404 : 200;
    res.headers = {};
    if (url.pathname === "/private-redirect") { res.statusCode = 302; res.headers.location = "http://127.0.0.1/secret"; }
    if (url.pathname === "/loop") { res.statusCode = 302; res.headers.location = "/loop"; }
    if (url.pathname === "/redirect") { res.statusCode = 302; res.headers.location = "/image"; }
    if (url.pathname === "/network" && n === 1) { req.emit("error", new Error("socket reset")); return; }
    callback(res);
    if (url.pathname === "/interrupt") {
      options.signal.addEventListener("abort", () => { req.emit("error", new Error("aborted")); res.destroy(); }, { once: true });
      return;
    }
    res.end(png);
  });
  return req;
}
mock.module("node:http", { defaultExport: { ...http, request } });
mock.module("node:https", { defaultExport: { ...https, request } });
const { loadVisionImage } = await import("./vision-images.js");
try {
  for (const path of ["/image", "/retry", "/network", "/redirect"]) {
    const dnsBefore = dnsCalls;
    const image = await loadVisionImage(`https://public.example${path}`, undefined, { signal: new AbortController().signal, tempRoot: dir });
    assert.equal(image.width, 10); await image.cleanup();
    assert.equal(dnsCalls - dnsBefore, path === "/redirect" ? 2 : 1, "DNS checked once per hop; retries reuse pinned IP");
  }
  assert.equal(attempts.get("/retry"), 2); assert.equal(attempts.get("/network"), 2);
  await assert.rejects(loadVisionImage("http://public.example/bad", undefined, { signal: new AbortController().signal, tempRoot: dir }), /404/);
  assert.equal(attempts.get("/bad"), 1, "4xx not retried");
  const before = calls;
  await assert.rejects(loadVisionImage("http://mixed.example/image", undefined, { signal: new AbortController().signal, tempRoot: dir }), /SSRF/);
  assert.equal(calls, before, "mixed DNS must not reach HTTP");
  await assert.rejects(loadVisionImage("http://public.example/private-redirect", undefined, { signal: new AbortController().signal, tempRoot: dir }), /SSRF/);
  await assert.rejects(loadVisionImage("http://public.example/loop", undefined, { signal: new AbortController().signal, tempRoot: dir }), /redirect limit/);
  const controller = new AbortController();
  const loading = loadVisionImage("http://public.example/interrupt", undefined, { signal: controller.signal, tempRoot: dir });
  while (!attempts.has("/interrupt")) await new Promise(r => setTimeout(r, 1));
  controller.abort(); await assert.rejects(loading, /Interrupted/);
  assert.deepEqual(readdirSync(dir), [], "errors and interruption remove private files");
  console.log("VISION_HTTP_OK");
} finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
