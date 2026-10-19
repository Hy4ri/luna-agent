// Contract checks use fixtures only. No paid requests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createImageGenExtension, ImageGenManager, type ImageGenProvider, type ImageGenCapabilities } from "./image-gen.js";
import { createOpenAICodexImageProvider } from "./plugins/image_gen/openai-codex.js";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";

const dir = mkdtempSync(join(tmpdir(), "luna-image-gen-"));
const root = join(dir, "root"); mkdirSync(root);
const png = await sharp({ create: { width: 16, height: 9, channels: 3, background: "red" } }).png().toBuffer();
writeFileSync(join(root, "input.png"), png); writeFileSync(join(dir, "outside.png"), png);
symlinkSync(join(dir, "outside.png"), join(root, "escape.png"));
const signal = new AbortController().signal;
let selected: string | undefined, probes = 0, calls = 0, refreshes = 0;
let caps: ImageGenCapabilities = { edit: true, max_reference_images: 2, controls: ["creativity"] };
const fake: ImageGenProvider = { name: "fake", is_available: () => true, capabilities: () => caps,
  async generate(request) { calls++; assert.equal(request.intensity, undefined); return { success: true, image: join(root, "input.png"), model: "fixture", prompt: request.prompt, aspect_ratio: request.aspect_ratio, provider: "fake", modality: request.sources.length ? "edit" : "text-to-image", upscaled: false }; } };
const manager = new ImageGenManager({ config: () => ({ provider: selected }), providers: new Map([["fake", fake], ["unused", { ...fake, name: "unused", is_available: () => { probes++; return true; } }]]), refresh: () => { refreshes++; } });
try {
  assert.equal(parseConfig({}, dir, {}).image_gen.provider, undefined);
  assert.throws(() => parseConfig({ image_gen: { unknown: true } }, dir, {}));
  assert.throws(() => parseConfig({ image_gen: { "openai-codex": { model: "unknown" } } }, dir, {}));
  const extension = createImageGenExtension(manager);
  assert.equal(extension.tools!.length, 0);
  selected = "fake";
  const schema = extension.tools![0]!.parameters as any;
  assert.ok(schema.properties.image_url); assert.equal(schema.properties.reference_image_urls.maxItems, 2);
  assert.ok(schema.properties.creativity); assert.equal(schema.properties.intensity, undefined); assert.equal(schema.properties.upscale, undefined);
  caps = {}; assert.equal((extension.tools![0]!.parameters as any).properties.image_url, undefined);
  caps = { edit: true, max_reference_images: 2, controls: ["creativity"] };
  const run = (args: Record<string, unknown>, backend = "local") => manager.generate(args, { cwd: root, signal, backend });
  assert.equal((await run({ prompt: " " })).error_type, "invalid_prompt");
  assert.equal((await run({ prompt: "edit", image_url: "../outside.png" })).error_type, "source_rejected");
  assert.equal((await run({ prompt: "edit", image_url: "escape.png" })).error_type, "source_rejected");
  assert.equal((await run({ prompt: "edit", image_url: "http://127.0.0.1/private" })).error_type, "source_rejected");
  assert.equal(calls, 0);
  assert.equal((await run({ prompt: "draw", intensity: 99 })).success, true);
  assert.equal((await run({ prompt: "edit", image_url: "input.png" })).modality, "edit");
  assert.equal((await run({ prompt: "edit", reference_image_urls: ["input.png", "input.png", "input.png"] })).error_type, "modality_unsupported");
  caps = {}; assert.equal((await run({ prompt: "edit", image_url: "input.png" })).error_type, "modality_unsupported");
  caps = { edit: true };
  fake.generate = async () => { throw new TypeError("internal failure"); };
  assert.equal((await run({ prompt: "draw" })).error_type, "provider_exception", "TypeError is not Python unsupported kwargs");
  selected = "missing";
  assert.equal((await run({ prompt: "draw", image_url: "../outside.png" })).error_type, "source_rejected"); assert.equal(refreshes, 0, "confinement precedes provider lookup and refresh");
  assert.equal((await run({ prompt: "draw" })).error_type, "provider_not_registered"); assert.equal(refreshes, 1);
  selected = "nous"; assert.equal((await run({ prompt: "draw" })).error_type, "gateway_unsupported");
  selected = "fake"; assert.equal((await run({ prompt: "draw" }, "ssh")).error_type, "backend_unsupported");
  assert.equal(probes, 0);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await manager.generate({ prompt: "draw" }, { cwd: root, signal: aborted.signal })).error_type, "interrupted");

  let key: string | undefined, requests = 0;
  const auth = { is_available: () => !!key, resolve: async () => { if (!key) throw new Error("No subscription"); return { accessToken: key, accountId: "fixture-account", residency: "us" }; } };
  const provider = createOpenAICodexImageProvider({ config: () => ({ model: "gpt-image-2", quality: "low" as const }), outputDir: join(dir, "outputs"), auth,
    fetch: async (url, init) => { requests++; assert.equal(init?.redirect, "error"); assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
      assert.ok(String(url).startsWith("https://chatgpt.com/backend-api/codex/images/"));
      const h = new Headers(init?.headers); assert.equal(h.get("chatgpt-account-id"), "fixture-account"); assert.equal(h.get("x-openai-internal-codex-residency"), "us"); assert.equal(h.get("originator"), "luna-pi"); assert.match(h.get("x-codex-image-turn-id")!, /^[a-f0-9-]{36}$/);
      if (String(url).endsWith("/edits")) { const body = JSON.parse(init!.body as string); assert.equal(body.images.length, 1); assert.match(body.images[0].image_url, /^data:image\/png;base64,/); assert.equal(body.size, "864x1536"); }
      else { const body = JSON.parse(init!.body as string); assert.equal(body.size, "1536x864"); assert.equal(body.n, 1); assert.equal(body.intensity, undefined); assert.equal(body.quality, "low"); assert.equal(body.background, "opaque"); }
      return Response.json({ data: [{ b64_json: png.toString("base64") }] }); } });
  assert.equal(provider.is_available(), false); key = "test-key"; assert.equal(provider.is_available(), true);
  const request = { prompt: "draw", aspect_ratio: "landscape" as const, sources: [], intensity: 9 };
  const result = await provider.generate(request, signal); assert.equal(result.success, true); assert.deepEqual(readFileSync(result.image!), png);
  assert.equal((await provider.generate({ ...request, aspect_ratio: "portrait", sources: [{ bytes: png, mimeType: "image/png" }] }, signal)).modality, "edit");
  assert.equal(requests, 2);
  for (const [response, expected] of [[new Response("secret body", { status: 429 }), "provider_http_error"], [Response.json({ data: [] }), "invalid_response"], [Response.json({ data: [{ b64_json: "not base64" }] }), "invalid_response"]] as const) {
    const adapter = createOpenAICodexImageProvider({ config: () => ({ model: "gpt-image-2", quality: "low" as const }), auth, outputDir: join(dir, "outputs"), fetch: async () => response });
    const result = await adapter.generate(request, signal); assert.equal(result.error_type, expected); assert.ok(!JSON.stringify(result).includes("secret body"));
  }

  // Production entrypoint: schemas change on an existing conversation, results contain deliverable pixels.
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
  const cfg = parseConfig({ dataDir: join(dir, "runtime"), cwd: root, extensions: [], image_gen: { provider: "openai-codex" } }, dir, {});
  const runtimeProvider = { ...fake, is_available: () => true, generate: async (r: any) => ({ success: true, image: join(root, "input.png"), model: "fixture", prompt: r.prompt, aspect_ratio: r.aspect_ratio, provider: "fake", modality: "edit" as const }) };
  const rt = await startRuntime(cfg, { models, model, imageGenProviders: new Map([["openai-codex", provider], ["fake", runtimeProvider]]), log: () => {} });
  try {
    const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    async function offered() {
      let tool: any;
      faux.setResponses([c => { const tools = new Map(); for (const m of c.messages) if (m.role === "system") { for (const n of m.toolsRemoved ?? []) tools.delete(n.name); for (const t of m.toolsAdded ?? []) tools.set(t.name, t); } tool = tools.get("image_generate"); return fauxAssistantMessage("listed"); }]);
      await (await conv.submit({ type: "input", content: "list" }, context)).wait(context); return tool;
    }
    assert.ok((await offered()).parameters.properties.image_url);
    key = undefined; assert.equal(await offered(), undefined); key = "test-key";
    assert.ok(await offered());
    cfg.image_gen.provider = "fake"; caps = { controls: ["movement"] };
    let changed = await offered(); assert.ok(changed.parameters.properties.movement); assert.equal(changed.parameters.properties.image_url, undefined);
    caps = { edit: true, upscale: true }; changed = await offered(); assert.ok(changed.parameters.properties.upscale); assert.ok(changed.parameters.properties.image_url); assert.equal(changed.parameters.properties.movement, undefined);
    cfg.image_gen.provider = "openai-codex";
    let result: any;
    faux.setResponses([fauxAssistantMessage([fauxToolCall("image_generate", { prompt: "draw" })], { stopReason: "toolUse" }), c => { result = c.messages.findLast(m => m.role === "toolResult"); return fauxAssistantMessage("done"); }]);
    await (await conv.submit({ type: "input", content: "generate fixture" }, context)).wait(context);
    assert.equal(result.isError, false); assert.equal(result.content.filter((b: any) => b.type === "image").length, 1);
    const data = JSON.parse(result.content.find((b: any) => b.type === "text").text); assert.equal(data.success, true); assert.ok(data.image);
  } finally { await rt.close(); }
  // Default runtime wiring must read the selected Codex home, not a provider override or API key.
  const codexHome = join(dir, "codex-home"); mkdirSync(codexHome);
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600, "https://api.openai.com/auth": { chatgpt_account_id: "runtime-account" } })).toString("base64url")}.fixture`;
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: "runtime-account" } }));
  let nativeCalls = 0;
  const wired = await startRuntime(parseConfig({ dataDir: join(dir, "wired"), cwd: root, extensions: [], image_gen: { provider: "openai-codex", "openai-codex": { codexHome } } }, dir, {}), { models, model, log: () => {}, fetch: async (url, init) => {
    nativeCalls++; assert.equal(String(url), "https://chatgpt.com/backend-api/codex/images/edits");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(JSON.parse(init!.body as string).images.length, 1);
    return Response.json({ data: [{ b64_json: png.toString("base64") }], size: "16x9", quality: "medium" });
  } });
  try {
    let delivered: any;
    faux.setResponses([fauxAssistantMessage([fauxToolCall("image_generate", { prompt: "edit", image_url: "input.png" })], { stopReason: "toolUse" }), c => { delivered = c.messages.findLast(m => m.role === "toolResult"); return fauxAssistantMessage("done"); }]);
    const conv = await wired.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    await (await conv.submit({ type: "input", content: "edit fixture" }, context)).wait(context);
    assert.equal(nativeCalls, 1); assert.equal(delivered.isError, false);
    const data = JSON.parse(delivered.content.find((b: any) => b.type === "text").text);
    assert.equal(data.provider, "openai-codex"); assert.equal(data.pixel_size, "16x9"); assert.equal(data.requested_size, "1536x864"); assert.equal(data.requested_quality, "low"); assert.equal(data.reported_quality, "medium");
  } finally { await wired.close(); }
  console.log("IMAGE_GEN_OK: isolated availability, dynamic schemas, confined inputs, dispatch, Codex subscription wire, local delivery (fixtures only)");
} finally { rmSync(dir, { recursive: true, force: true }); }
