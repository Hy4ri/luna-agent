// Generated image delivery through the production tool, HTTP/SSE and the real Web UI. Fixtures only.
import assert from "node:assert/strict";
import sharp from "sharp";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { createOpenAICodexImageProvider } from "./plugins/image_gen/openai-codex.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const png = (await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
const dir = mkdtempSync(join(tmpdir(), "luna-browser-image-"));
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const imageProvider = createOpenAICodexImageProvider({ config: () => ({ model: "gpt-image-2", quality: "low" as const }), outputDir: join(dir, "generated-images"), auth: { is_available: () => true, resolve: async () => ({ accessToken: "fixture-token" }) }, fetch: async () => Response.json({ data: [{ b64_json: png }] }) });
const rt = await startRuntime(parseConfig({ dataDir: dir, extensions: [], image_gen: { provider: "openai-codex" } }, dir, {}), { models, model, imageGenProviders: new Map([["openai-codex", imageProvider]]), log: () => {} });
const app = createApp({ harness: rt.harness, models, conversations: rt.conversations, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }); page.setDefaultTimeout(12000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript((id: string) => { localStorage.setItem("luna.token", "test"); localStorage.setItem("luna.session", id); }, String(conv.id));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  // Wait for boot's draft restoration before editing the composer.
  await page.locator(`[data-session="${conv.id}"] .session-open[aria-current="page"]`).waitFor();
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall("image_generate", { prompt: "Fixture one" }), fauxToolCall("image_generate", { prompt: "Fixture two", aspect_ratio: "square" }),
  ], { stopReason: "toolUse" }), fauxAssistantMessage("Generated images delivered")]);
  await page.locator("#input").fill("Show generated images"); await page.locator("#send").click();
  await page.getByText("Generated images delivered", { exact: true }).waitFor();
  async function verifyImages() {
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll("img.tool-image").length === 2);
    await page.locator(".tool details").evaluateAll((items: any[]) => items.forEach(item => item.open = true));
    await page.waitForFunction(() => [...(globalThis as any).document.querySelectorAll("img.tool-image")].every((img: any) => img.complete && img.naturalWidth === 1));
    const images = page.locator("img.tool-image"); assert.equal(await images.count(), 2);
    assert.ok((await images.first().getAttribute("src"))?.startsWith("data:image/"));
    assert.equal(await page.getByAltText("image_generate result").count(), 2);
    assert.ok(!(await page.locator(".tool pre").allTextContents()).join("").includes(png), "Do not print image bytes as JSON text");
  }
  await verifyImages(); await page.reload(); await verifyImages();
  await page.setViewportSize({ width: 390, height: 844 }); await verifyImages();
  assert.equal(await page.evaluate(() => { const d = (globalThis as any).document; return d.documentElement.scrollWidth <= d.documentElement.clientWidth; }), true);
  assert.deepEqual(errors, []);
  console.log("IMAGE_GEN_UI_OK: generated image blocks render, load, survive reconnect, no duplicates, mobile, no page errors");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close();
  rmSync(dir, { recursive: true, force: true });
}
