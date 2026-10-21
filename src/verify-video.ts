import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync, linkSync, openSync, ftruncateSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { analyzeVideo, resolveVideoClient, VIDEO_PROMPT, videoError } from "./video.js";
import { materializeVideo, videoMime, VIDEO_MAX_BYTES } from "./video-source.js";

const dir = mkdtempSync(join(tmpdir(), "luna-video-"));
const path = join(dir, "clip.mp4"), bytes = Buffer.from("complete video bytes");
writeFileSync(path, bytes);
const cfg = parseConfig({ dataDir: join(dir, "data"), extensions: [], auxiliary: { vision: { provider: "aux", model: "gemini" } } }, dir, {});
const signal = new AbortController().signal;
const main = fauxProvider({ provider: "main", api: "anthropic-messages", models: [{ id: "main", input: ["text"] }] });
const aux = fauxProvider({ provider: "aux", api: "openai-completions", models: [{ id: "gemini", input: ["text", "image"] }, { id: "override", input: ["text", "image"] }] });
const models = createModels(); models.setProvider(main.provider); models.setProvider(aux.provider);
const active = { provider: "main", modelId: "main" };
const sourceOptions = { ...cfg.video, signal, dataDir: cfg.dataDir, cwd: dir };
let fetches = 0, lastBody: any, lastUrl = "";
const fakeFetch: typeof fetch = async (input, init) => {
  fetches++; lastUrl = String(input); lastBody = JSON.parse(String(init?.body));
  assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
  return Response.json({ choices: [{ message: { content: "The clip shows a red ball." } }] });
};
const call = (overrides: Partial<Parameters<typeof analyzeVideo>[0]> = {}) => analyzeVideo({ models, config: cfg, active, source: path,
  question: "What moves?", signal, fetch: fakeFetch, ...overrides });
function sparse(name: string, size: number) { const p = join(dir, name); const fd = openSync(p, "w"); ftruncateSync(fd, size); closeSync(fd); return p; }
try {
  for (const [suffix, mime] of Object.entries({ mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mpg: "video/mpeg", mpeg: "video/mpeg", avi: "video/mp4", mkv: "video/mp4" }))
    assert.equal(videoMime(`https://example.com/CLIP.${suffix.toUpperCase()}?secret=x`), mime);
  assert.throws(() => videoMime("bad.gif"), /Unsupported video format/);
  for (const source of ["data:video/mp4;base64,AA==", "ssh://host/clip.mp4", "remote:/clip.mp4", ""]) await assert.rejects(materializeVideo(source, sourceOptions), /Invalid video source/);
  await assert.rejects(materializeVideo("bad.txt", sourceOptions), /Unsupported video format/);
  const loaded = await materializeVideo("clip.mp4", sourceOptions);
  assert.equal(loaded.data, bytes.toString("base64")); await loaded.cleanup(); assert.ok(existsSync(path));
  assert.equal(existsSync(join(cfg.dataDir, "video-cache")), false, "local videos do not create caches");
  const blocked = join(dir, "blocked"); mkdirSync(blocked); writeFileSync(join(blocked, "clip.mp4"), bytes);
  symlinkSync(join(blocked, "clip.mp4"), join(dir, "alias.mp4"));
  await assert.rejects(materializeVideo("alias.mp4", { ...sourceOptions, blocked_paths: [blocked] }), /Read blocked/);
  writeFileSync(join(dir, ".env"), "secret"); symlinkSync(join(dir, ".env"), join(dir, "secret.mp4"));
  await assert.rejects(materializeVideo("secret.mp4", sourceOptions), /Read blocked/);
  mkdirSync(cfg.dataDir, { recursive: true }); writeFileSync(join(cfg.dataDir, "auth.json"), "secret");
  linkSync(join(cfg.dataDir, "auth.json"), join(dir, "hardlink.mp4"));
  await assert.rejects(materializeVideo("hardlink.mp4", sourceOptions), /Read blocked/);
  const big = sparse("warning.mp4", 21 * 1024 * 1024);
  const warning = await materializeVideo(big, sourceOptions); assert.match(warning.warning!, /20 MiB/); await warning.cleanup(); assert.ok(existsSync(big));
  const base64 = sparse("base64.mp4", Math.floor(VIDEO_MAX_BYTES * 3 / 4) + 1);
  await assert.rejects(materializeVideo(base64, sourceOptions), /base64.*compress or trim/); assert.ok(existsSync(base64));
  await assert.rejects(materializeVideo(sparse("oversize.mp4", VIDEO_MAX_BYTES + 1), sourceOptions), /transport limit/);
  const aborted = AbortSignal.abort();
  await assert.rejects(materializeVideo(path, { ...sourceOptions, signal: aborted }), /Interrupted/);
  const success = await call(); assert.equal(success.success, true); assert.match(success.analysis, /red ball/);
  assert.equal(lastBody.temperature, 0.1); assert.equal(lastBody.model, "gemini"); assert.equal(lastBody.messages.length, 1);
  assert.deepEqual(lastBody.messages[0].content, [{ type: "text", text: VIDEO_PROMPT + "What moves?" },
    { type: "video_url", video_url: { url: `data:video/mp4;base64,${bytes.toString("base64")}` } }]);
  assert.ok(lastUrl.endsWith("/chat/completions"));
  assert.equal((await resolveVideoClient(models, { ...cfg, auxiliary: { ...cfg.auxiliary, video: { model: "override" } } }, active, { AUXILIARY_VIDEO_MODEL: "env" }))?.id, "override");
  assert.equal((await resolveVideoClient(models, cfg, active, { AUXILIARY_VIDEO_MODEL: "env" }))?.id, "gemini", "vision model wins over environment");
  const auto = { ...cfg, auxiliary: {} };
  const router = fauxProvider({ provider: "openrouter", api: "openai-completions", models: [{ id: "gemini-router", input: ["text", "image"] }] });
  const nous = fauxProvider({ provider: "nous", api: "openai-completions", models: [{ id: "gemini-nous", input: ["text", "image"] }] });
  models.setProvider(nous.provider); models.setProvider(router.provider);
  assert.equal((await resolveVideoClient(models, auto, active, {}))?.provider, "openrouter");
  assert.equal((await resolveVideoClient(models, auto, { provider: "aux", modelId: "gemini" }, {}))?.provider, "aux");
  assert.equal((await resolveVideoClient(models, auto, active, { AUXILIARY_VIDEO_MODEL: "env-video", AUXILIARY_VISION_MODEL: "env-vision" }))?.id, "env-video");
  assert.equal((await resolveVideoClient(models, auto, active, { AUXILIARY_VISION_MODEL: "env-vision" }))?.id, "env-vision");
  assert.equal(await resolveVideoClient(models, { ...cfg, auxiliary: { vision: { provider: "missing", model: "missing" } } }, active), undefined);
  assert.equal((await resolveVideoClient(Object.assign(Object.create(models) as typeof models, { getAuth: async (m: string | { provider: string }) => typeof m !== "string" && m.provider === "nous" ? { auth: {} } : undefined }), auto, active, {}))?.provider, "nous");
  assert.equal(await resolveVideoClient(Object.assign(Object.create(models) as typeof models, { getAuth: async () => undefined }), cfg, active, {}), undefined);
  const authenticated = Object.assign(Object.create(models) as typeof models, { getAuth: async () => ({ auth: { apiKey: "test-key", baseUrl: "https://auxiliary.example/v1", headers: { "x-provider": "scoped" } } }) });
  assert.equal((await call({ models: authenticated, fetch: async (url, init) => {
    assert.equal(String(url), "https://auxiliary.example/v1/chat/completions");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key"); assert.equal(headers.get("x-provider"), "scoped");
    return Response.json({ choices: [{ message: { content: "authenticated" } }] });
  } })).analysis, "authenticated");
  const timeoutValues: number[] = [];
  const timer = mock.method(AbortSignal, "timeout", (ms: number) => { timeoutValues.push(ms); return AbortSignal.abort(new Error("timeout")); });
  try {
    const timed = await call({ fetch: async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error("unreachable"); } });
    assert.match(timed.analysis, /timed out/); assert.deepEqual(timeoutValues, [180_000]);
    await call({ config: { ...cfg, video: { ...cfg.video, timeout_ms: 240_000 } }, fetch: async (_url, init) => { init?.signal?.throwIfAborted(); throw new Error("unreachable"); } });
    assert.deepEqual(timeoutValues, [180_000, 240_000]);
  } finally { timer.mock.restore(); }
  let attempts = 0;
  const emptyFetch: typeof fetch = async () => { attempts++; return Response.json({ choices: [{ message: { content: attempts === 1 ? " " : "retry worked" } }] }); };
  assert.equal((await call({ fetch: emptyFetch })).analysis, "retry worked"); assert.equal(attempts, 2);
  attempts = 0;
  const empty = await call({ fetch: async () => { attempts++; return Response.json({}); } });
  assert.equal(empty.success, false); assert.match(empty.analysis, /empty reply/); assert.equal(attempts, 2);
  const fail = await call({ fetch: async () => new Response("SECRET_API_KEY", { status: 401 }) });
  assert.equal(fail.success, false); assert.match(fail.analysis, /authentication/); assert.ok(!JSON.stringify(fail).includes("SECRET"));
  assert.equal((await call({ signal: aborted })).analysis, "Interrupted");
  assert.match((await call({ source: "not-here.mp4" })).analysis, /Invalid video source/);
  for (const [raw, expected] of [["429 quota", /quota/], ["timeout", /timed out/], ["413", /compress or trim/], ["400", /video-capable/], ["SSRF", /policy/], ["Read blocked", /Read blocked/]] as const)
    assert.match(videoError(new Error(raw), signal).analysis, expected);
  const google = fauxProvider({ provider: "google-test", api: "google-generative-ai", models: [{ id: "gemini", input: ["text", "image"] }] });
  models.setProvider(google.provider);
  const googleResult = await call({ config: { ...cfg, auxiliary: { vision: { provider: "google-test", model: "gemini" } } }, fetch: async (url, init) => {
    assert.match(String(url), /\/models\/gemini:generateContent$/);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.temperature, 0.1);
    assert.deepEqual(body.contents[0].parts[1], { inlineData: { mimeType: "video/mp4", data: bytes.toString("base64") } });
    return Response.json({ candidates: [{ content: { parts: [{ text: "Google analysis" }] } }] });
  } }); assert.equal(googleResult.analysis, "Google analysis");
  // Real runtime tools and generation hooks: text-only main, aux credentials, then live config removal.
  const runtimeModels = createModels(); runtimeModels.setProvider(main.provider); runtimeModels.setProvider(aux.provider);
  const rt = await startRuntime(cfg, { models: runtimeModels, model: active, fetch: fakeFetch, log: () => {} });
  try {
    let offered: string[] = [], history: readonly Message[] = [];
    main.setResponses([c => { offered = c.messages.flatMap(m => m.role === "system" ? (m.toolsAdded ?? []).map(t => t.name) : []); return fauxAssistantMessage("ready"); }]);
    const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: active, cwd: dir } }, context);
    await (await conv.submit({ type: "input", content: "List tools" }, context)).wait(context);
    assert.ok(offered.includes("video_analyze"));
    main.setResponses([fauxAssistantMessage([fauxToolCall("video_analyze", { video_url: "clip.mp4", question: "What moves?" }, { id: "video-call" })], { stopReason: "toolUse" }),
      c => { history = c.messages; return fauxAssistantMessage("done"); }]);
    await (await conv.submit({ type: "input", content: "Analyze video" }, context)).wait(context);
    const result = history.find(m => m.role === "toolResult" && m.toolCallId === "video-call");
    assert.ok(result && result.role === "toolResult"); assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).success, true);
    assert.ok(!JSON.stringify(history).includes(bytes.toString("base64")), "main conversation receives no video payload");
    assert.ok(existsSync(path));
    // Re-resolve policy on the next generation, without restarting the runtime.
    cfg.auxiliary.vision = { provider: "missing", model: "missing" };
    main.setResponses([c => { offered = c.messages.flatMap(m => m.role === "system" ? (m.toolsAdded ?? []).map(t => t.name) : []); return fauxAssistantMessage("updated"); }]);
    const next = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: active } }, context);
    await (await next.submit({ type: "input", content: "List" }, context)).wait(context);
    assert.ok(!offered.includes("video_analyze"));
  } finally { await rt.close(); }
  const unavailable = parseConfig({ dataDir: join(dir, "unavailable"), extensions: [] }, dir, {});
  const bareModels = createModels(); bareModels.setProvider(main.provider);
  const bare = await startRuntime(unavailable, { models: bareModels, model: active, log: () => {} });
  try {
    let names: string[] = [];
    main.setResponses([c => { names = c.messages.flatMap(m => m.role === "system" ? (m.toolsAdded ?? []).map(t => t.name) : []); return fauxAssistantMessage("done"); }]);
    const conv = await bare.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: active } }, context);
    await (await conv.submit({ type: "input", content: "List" }, context)).wait(context);
    assert.ok(!names.includes("video_analyze"));
  } finally { await bare.close(); }
  assert.throws(() => parseConfig({ auxiliary: { video: { provider: "oops", model: "x" } } }, dir, {}));
  assert.throws(() => parseConfig({ video: { timeout_ms: 179999 } }, dir, {}));
  assert.ok(fetches >= 2); assert.ok(existsSync(path));
  if (existsSync(join(cfg.dataDir, "video-cache"))) assert.deepEqual(readdirSync(join(cfg.dataDir, "video-cache")), []);
  console.log("VIDEO_OK");
} finally { rmSync(dir, { recursive: true, force: true }); }
