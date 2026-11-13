// Contract: media_analyze routes video vs image, prepares/analyzes images, tracks video usage, and rejects native codemode delivery.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import sharp from "sharp";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { isVideoSource } from "../src/media.js";
import { parseVideoUsage, analyzeVideo } from "../src/video.js";
import { loadVisionImage, fitVisionImage } from "../src/vision-images.js";

test("video sources are detected by data URL type or extension; everything else is an image", () => {
  for (const s of ["clip.mp4", "/tmp/a.MOV", "https://x.test/v/clip.webm?sig=1", "data:video/mp4;base64,AAAA", "a.mkv", "b.mpg"])
    expect(isVideoSource(s)).toBe(true) /* s */;
  for (const s of ["shot.png", "https://x.test/clip.mp4.png", "data:image/png;base64,AAAA", "https://x.test/watch?v=clip.mp4", "noext", "data:text/plain,mp4"])
    expect(isVideoSource(s)).toBe(false) /* s */;
});

test("loadVisionImage validates passthrough images without temp files and crops region to PNG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-vision-img-"));
  try {
    const pngPath = join(dir, "sample.png");
    const jpgPath = join(dir, "sample.jpg");
    const pngBytes = await sharp({ create: { width: 40, height: 24, channels: 3, background: { r: 20, g: 120, b: 220 } } }).png().toBuffer();
    const jpgBytes = await sharp({ create: { width: 40, height: 24, channels: 3, background: { r: 220, g: 60, b: 20 } } }).jpeg().toBuffer();
    writeFileSync(pngPath, pngBytes);
    writeFileSync(jpgPath, jpgBytes);

    const loadedJpg = await loadVisionImage(jpgPath, undefined, { signal: new AbortController().signal, cwd: dir });
    expect(loadedJpg.mimeType).toBe("image/jpeg");
    expect(loadedJpg.width).toBe(40);
    expect(loadedJpg.height).toBe(24);
    expect(loadedJpg.bytes.equals(jpgBytes)).toBe(true);
    await loadedJpg.cleanup();

    const cropped = await loadVisionImage(pngPath, { x: 4, y: 2, width: 12, height: 10 }, { signal: new AbortController().signal, cwd: dir });
    expect(cropped.mimeType).toBe("image/png");
    expect(cropped.width).toBe(12);
    expect(cropped.height).toBe(10);
    const fit = await fitVisionImage(cropped, { maxBytes: 100_000, hardBytes: 200_000, longEdge: 200, signal: new AbortController().signal });
    expect(fit.width).toBe(12);
    expect(fit.height).toBe(10);
    await cropped.cleanup();

    const truncatedPng = join(dir, "corrupt.png");
    writeFileSync(truncatedPng, pngBytes.subarray(0, Math.floor(pngBytes.length * 0.6)));
    await expect(loadVisionImage(truncatedPng, undefined, { signal: new AbortController().signal, cwd: dir })).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseVideoUsage maps google-generative-ai and openai-completions usage with cost", () => {
  const models = createModels();
  models.setProvider(createProvider({
    id: "vid",
    name: "Vid",
    auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "test", baseUrl: "https://vid.example/v1" }, source: "test" }) } },
    models: [
      {
        id: "g-vid", name: "g-vid", api: "google-generative-ai", provider: "vid", baseUrl: "https://vid.example/v1",
        input: ["text", "image"], reasoning: true, contextWindow: 128_000, maxTokens: 8192,
        cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
      },
      {
        id: "o-vid", name: "o-vid", api: "openai-completions", provider: "vid", baseUrl: "https://vid.example/v1",
        input: ["text", "image"], reasoning: false, contextWindow: 128_000, maxTokens: 8192,
        cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 0 },
      },
    ],
    api: { stream: (() => { throw new Error("unused"); }) as never, streamSimple: (() => { throw new Error("unused"); }) as never },
  }));
  const gModel = models.getModel("vid", "g-vid")!;
  const gUsage = parseVideoUsage({
    usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 100, thoughtsTokenCount: 50, totalTokenCount: 1150 },
  }, gModel)!;
  expect(gUsage.input).toBe(800);
  expect(gUsage.cacheRead).toBe(200);
  expect(gUsage.output).toBe(150);
  expect(gUsage.reasoning).toBe(50);
  expect(gUsage.totalTokens).toBe(1150);
  expect(gUsage.cost.total).toBeGreaterThan(0);

  const oModel = models.getModel("vid", "o-vid")!;
  const oUsage = parseVideoUsage({
    usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600, prompt_tokens_details: { cached_tokens: 100 } },
  }, oModel)!;
  expect(oUsage.input).toBe(400);
  expect(oUsage.cacheRead).toBe(100);
  expect(oUsage.output).toBe(100);
  expect(oUsage.totalTokens).toBe(600);
  expect(oUsage.cost.total).toBeGreaterThan(0);
});

test("media_analyze video path records tool usage in UsageDoc and preserves warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-media-vid-"));
  try {
    const mp4 = join(dir, "clip.mp4");
    writeFileSync(mp4, Buffer.from("00000018667479706d703432", "hex"));
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("media_analyze", { source: mp4, question: "what happens?" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    models.setProvider(createProvider({
      id: "auxvid",
      name: "AuxVid",
      auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "secret", baseUrl: "https://auxvid.test/v1" }, source: "test" }) } },
      models: [{
        id: "v1", name: "v1", api: "openai-completions", provider: "auxvid", baseUrl: "https://auxvid.test/v1",
        input: ["text", "image"], reasoning: false, contextWindow: 128_000, maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }],
      api: { stream: (() => { throw new Error("unused"); }) as never, streamSimple: (() => { throw new Error("unused"); }) as never },
    }));
    const model = faux.getModel();
    const modelRef = { provider: model.provider, modelId: model.id };
    const fetchMock: typeof fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: "A test video clip." } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const rt = await startRuntime(parseConfig({
      dataDir: dir, cwd: dir, extensions: ["coding"],
      auxiliary: { vision: { provider: "auxvid", model: "v1" } },
    }), { models, model: modelRef, fetch: fetchMock });
    try {
      const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef, cwd: dir } }, context);
      const run = await (await conv.submit({ type: "input", content: "inspect clip" }, context)).wait(context);
      expect(run.status).toBe("done");
      const entries = (await conv.entries({}, 50, undefined, context)).items;
      const toolResult = entries.flatMap(e => e.model ?? []).find(m => m.role === "toolResult");
      const resultText = toolResult?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
      expect(resultText).toContain("A test video clip.");
      const usageDoc = await rt.harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(UsageDoc, conv.id as ConversationId))) as { tools: Record<string, { totalTokens: number; cost: { total: number } }> }, context);
      expect(usageDoc.tools["media_analyze"]?.totalTokens).toBe(150);
      expect(usageDoc.tools["media_analyze"]?.cost.total).toBeGreaterThan(0);
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media_analyze inside codemode succeeds with auxiliary.vision when active model is native", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-media-cm-aux-"));
  try {
    const imgPath = join(dir, "img.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 128, b: 0 } } }).png().toFile(imgPath);
    const faux = fauxProvider({ models: [{ id: "m", input: ["text", "image"] }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: `return await tools.media_analyze({ source: ${JSON.stringify(imgPath)}, question: "color?" });` })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("handled")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const auxFaux = fauxProvider({ provider: "auximg", models: [{ id: "v", input: ["text", "image"] }] });
    auxFaux.setResponses([
      fauxAssistantMessage([fauxText("Solid green square.")]),
    ]);
    models.setProvider(auxFaux.provider);
    const model = faux.getModel();
    const modelRef = { provider: model.provider, modelId: model.id };
    const auxModel = auxFaux.getModel();

    const rt = await startRuntime(parseConfig({
      dataDir: dir, cwd: dir, extensions: ["coding", "codemode"],
      vision: { image_mode: "native" },
      auxiliary: { vision: { provider: auxModel.provider, model: auxModel.id } },
    }), { models, model: modelRef });
    try {
      const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef } }, context);
      const run = await (await conv.submit({ type: "input", content: "use codemode aux" }, context)).wait(context);
      expect(run.status).toBe("done");
      const entries = (await conv.entries({}, 50, undefined, context)).items;
      const toolResult = entries.flatMap(e => e.model ?? []).find(m => m.role === "toolResult");
      const resultText = toolResult?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
      expect(resultText).toContain("Solid green square.");
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media_analyze inside codemode refuses native-only routing cleanly when auxiliary.vision is unset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-media-cm-"));
  try {
    const imgPath = join(dir, "img.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 128, b: 0 } } }).png().toFile(imgPath);
    const faux = fauxProvider({ models: [{ id: "m", input: ["text", "image"] }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: `try { return await tools.media_analyze({ source: "img.png", question: "color?" }); } catch (e) { return "ERR: " + e.message; }` })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("handled")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const modelRef = { provider: model.provider, modelId: model.id };

    const rt = await startRuntime(parseConfig({
      dataDir: dir, cwd: dir, extensions: ["coding", "codemode"],
      vision: { image_mode: "native" },
    }), { models, model: modelRef });
    try {
      const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef } }, context);
      const run = await (await conv.submit({ type: "input", content: "use codemode on image" }, context)).wait(context);
      expect(run.status).toBe("done");
      const entries = (await conv.entries({}, 50, undefined, context)).items;
      const toolResult = entries.flatMap(e => e.model ?? []).find(m => m.role === "toolResult");
      const resultText = toolResult?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
      expect(resultText).toMatch(/cannot deliver images through codemode/i);
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyzeVideo accumulates usage across empty-reply retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-vid-retry-"));
  try {
    const mp4 = join(dir, "clip.mp4");
    writeFileSync(mp4, Buffer.from("00000018667479706d703432", "hex"));
    const models = createModels();
    models.setProvider(createProvider({
      id: "vidr", name: "VidR",
      auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "k", baseUrl: "https://vidr.test/v1" }, source: "test" }) } },
      models: [{
        id: "m", name: "m", api: "openai-completions", provider: "vidr", baseUrl: "https://vidr.test/v1",
        input: ["text", "image"], reasoning: false, contextWindow: 128_000, maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }],
      api: { stream: (() => { throw new Error("unused"); }) as never, streamSimple: (() => { throw new Error("unused"); }) as never },
    }));
    let calls = 0;
    const fetchMock: typeof fetch = (async () => {
      calls++;
      const content = calls === 1 ? "" : "Second attempt text";
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const cfg = parseConfig({ dataDir: dir, cwd: dir, auxiliary: { vision: { provider: "vidr", model: "m" } } });
    const res = await analyzeVideo({
      models, config: cfg, active: { provider: "vidr", modelId: "m" },
      source: "clip.mp4", question: "describe", cwd: dir, signal: new AbortController().signal, fetch: fetchMock,
    });
    expect(res.success).toBe(true);
    expect(res.usage?.totalTokens).toBe(120);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
