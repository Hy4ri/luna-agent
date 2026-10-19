// Opt-in: consumes ChatGPT/Codex subscription image quota. Never runs in the default test suite.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { loadConfig, parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live only with authorization to consume one subscription image request.");
const saved = loadConfig();
const dir = mkdtempSync(join(tmpdir(), "luna-image-live-"));
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
let submissions = 0;
const rt = await startRuntime(parseConfig({ dataDir: dir, extensions: [], image_gen: {
  provider: "openai-codex", "openai-codex": { ...saved.image_gen["openai-codex"], quality: "low" },
} }, process.cwd(), {}), { models, model, log: () => {}, fetch: async (url, init) => {
  assert.equal(String(url), "https://chatgpt.com/backend-api/codex/images/generations", "Never call the paid API or another endpoint");
  assert.equal(++submissions, 1, "Only one live image submission is authorized");
  return fetch(url, init);
} });
try {
  let result: any;
  const prompt = "A minimal flat illustration of a silver crescent moon above terraced green hills at night, deep navy sky, warm small house lights, clean shapes, calm composition, no text, no watermark. Wide landscape composition.";
  faux.setResponses([fauxAssistantMessage([fauxToolCall("image_generate", { prompt, aspect_ratio: "landscape" })], { stopReason: "toolUse" }), c => { result = c.messages.findLast(m => m.role === "toolResult"); return fauxAssistantMessage("Live image test finished"); }]);
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  await (await conv.submit({ type: "input", content: "Run one authorized subscription image test" }, context)).wait(context);
  assert.ok(result, "Tool result is missing");
  const data = JSON.parse(result.content.find((b: any) => b.type === "text")?.text ?? "{}");
  assert.equal(data.success, true, JSON.stringify(data));
  assert.equal(submissions, 1); assert.equal(data.provider, "openai-codex");
  assert.equal(result.content.filter((b: any) => b.type === "image").length, 1, "The real image must reach chat as a preview");
  const metadata = await sharp(data.image).metadata(); assert.equal(metadata.format, "png");
  const destination = join(saved.dataDir, "generated-images"); mkdirSync(destination, { recursive: true, mode: 0o700 });
  const path = join(destination, `subscription-live-${randomUUID()}.png`);
  copyFileSync(data.image, path); chmodSync(path, 0o600);
  console.log("IMAGE_GEN_LIVE_OK " + JSON.stringify({ ...data, image: path, width: metadata.width, height: metadata.height, submissions, chat_preview: true }));
} finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
