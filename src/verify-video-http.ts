// Deterministic transport tests. No public network or provider requests.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
const dir = mkdtempSync(join(tmpdir(), "video-http-"));
const attempts = new Map<string, number>();
let dns = 0, requests = 0;
const timeoutValues: number[] = [];
const realTimeout = AbortSignal.timeout;
mock.method(AbortSignal, "timeout", (ms: number) => { timeoutValues.push(ms); return realTimeout(1000); });
mock.module("node:dns/promises", { namedExports: { lookup: async (host: string) => {
  dns++;
  if (host === "mixed.example") return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
  return [{ address: "8.8.8.8", family: 4 }];
} } });
function request(url: URL, options: any, callback: (res: any) => void) {
  requests++;
  assert.equal(url.hostname, "public.example"); assert.equal(options.agent, false);
  assert.ok(options.signal instanceof AbortSignal);
  for (const all of [false, true]) options.lookup(url.hostname, { all }, (error: Error | null, address: any, family: number) => {
    assert.equal(error, null);
    if (all) assert.deepEqual(address, [{ address: "8.8.8.8", family: 4 }]);
    else { assert.equal(address, "8.8.8.8"); assert.equal(family, 4); }
  });
  const req = new EventEmitter() as EventEmitter & { end(): void };
  req.end = () => queueMicrotask(() => {
    const path = url.pathname, n = (attempts.get(path) ?? 0) + 1; attempts.set(path, n);
    if (path === "/network.mp4" && n < 4) { req.emit("error", new Error("connection reset")); return; }
    if (path === "/interrupt.mp4" || path === "/timeout.mp4") {
      options.signal.addEventListener("abort", () => req.emit("error", new Error("aborted")), { once: true }); return;
    }
    const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
    res.statusCode = path === "/retry.mp4" && n < 4 || path === "/fail.mp4" ? 503 : path === "/bad.mp4" ? 404 : 200;
    res.headers = {};
    const redirects: Record<string, string> = { "/private.mp4": "http://127.0.0.1/clip.mp4", "/site.mp4": "https://blocked.example/clip.mp4",
      "/credentials.mp4": "https://user:pass@public.example/clip.mp4", "/scheme.mp4": "file:///clip.mp4", "/loop.mp4": "/loop.mp4", "/redirect.mp4": "/clip.mp4" };
    if (redirects[path]) { res.statusCode = 302; res.headers.location = redirects[path]!; }
    if (path === "/length.mp4") res.headers["content-length"] = String(51 * 1024 * 1024);
    callback(res);
    if (path === "/bytes.mp4") { res.end(Buffer.alloc(51 * 1024 * 1024)); return; }
    if (path === "/base64.mp4") { res.end(Buffer.alloc(38 * 1024 * 1024)); return; }
    res.end(Buffer.from("whole video"));
  });
  return req;
}
mock.module("node:http", { defaultExport: { ...http, request } });
mock.module("node:https", { defaultExport: { ...https, request } });
const { materializeVideo } = await import("./video-source.js");
const { analyzeVideo } = await import("./video.js");
const { parseConfig } = await import("./config.js");
const { createModels, fauxProvider } = await import("@earendil-works/pi-ai");
const base = { signal: new AbortController().signal, dataDir: dir, blocked_paths: [], blocked_hosts: ["blocked.example"] };
const load = (name: string, overrides: Partial<typeof base> = {}) => materializeVideo(`https://public.example/${name}.mp4`, { ...base, ...overrides });
const empty = () => assert.deepEqual(readdirSync(join(dir, "video-cache")), [], "every terminal path removes owned downloads");
try {
  for (const name of ["clip", "retry", "network", "redirect"]) {
    const loaded = await load(name); assert.equal(Buffer.from(loaded.data, "base64").toString(), "whole video");
    const dirs = readdirSync(join(dir, "video-cache")); assert.equal(dirs.length, 1);
    await loaded.cleanup(); empty();
  }
  assert.equal(attempts.get("/retry.mp4"), 4); assert.equal(attempts.get("/network.mp4"), 4);
  for (const [name, match] of [["bad", /404/], ["fail", /503/], ["private", /SSRF/], ["site", /Site access/], ["credentials", /Site access/],
    ["scheme", /Site access/], ["loop", /redirect limit/], ["length", /transport limit/], ["bytes", /transport limit/], ["base64", /compress or trim/]] as const) {
    await assert.rejects(load(name), match); empty();
  }
  assert.equal(attempts.get("/bad.mp4"), 1); assert.equal(attempts.get("/fail.mp4"), 4);
  assert.equal(attempts.get("/bytes.mp4"), 1, "byte caps must not retry");
  let before = requests;
  await assert.rejects(materializeVideo("https://mixed.example/clip.mp4", base), /SSRF/); assert.equal(requests, before); empty();
  await assert.rejects(materializeVideo("https://child.blocked.example/clip.mp4", base), /Site access/); assert.equal(requests, before); empty();
  const controller = new AbortController(); const running = load("interrupt", { signal: controller.signal });
  while (!attempts.has("/interrupt.mp4")) await new Promise(r => setTimeout(r, 1));
  controller.abort(); await assert.rejects(running, /Interrupted/); empty();
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(load("timeout"), /timed out/); } finally { clearInterval(keepAlive); }
  assert.equal(attempts.get("/timeout.mp4"), 4); empty();
  assert.ok(timeoutValues.length > 0); assert.ok(timeoutValues.every(ms => ms === 60_000)); assert.ok(dns > 0);
  const auxiliary = fauxProvider({ provider: "aux", api: "openai-completions", models: [{ id: "gemini", input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(auxiliary.provider);
  const cfg = parseConfig({ dataDir: dir, auxiliary: { vision: { provider: "aux", model: "gemini" } } }, dir, {});
  for (const mode of ["success", "error", "empty", "interrupt"] as const) {
    const controller = new AbortController();
    const result = await analyzeVideo({ models, config: cfg, active: { provider: "main", modelId: "main" },
      source: "https://public.example/clip.mp4", question: "Describe", signal: controller.signal,
      fetch: async () => {
        assert.equal(readdirSync(join(dir, "video-cache")).length, 1, "owned source lives until provider request finishes");
        if (mode === "error") return new Response("private detail", { status: 500 });
        if (mode === "interrupt") { controller.abort(); throw new Error("aborted"); }
        return Response.json({ choices: [{ message: { content: mode === "empty" ? "" : "full analysis" } }] });
      } });
    assert.equal(result.success, mode === "success");
    if (mode === "interrupt") assert.equal(result.analysis, "Interrupted");
    empty();
  }
  console.log("VIDEO_HTTP_OK");
} finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
