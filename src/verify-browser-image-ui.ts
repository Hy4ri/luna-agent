// Deterministic screenshot delivery through native tools, HTTP/SSE and the real Web UI.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { type: "image" as const, data: png, mimeType: "image/png" };
const dir = mkdtempSync(join(tmpdir(), "luna-browser-image-"));
const http = createServer(async (req, res) => {
  const mcp = new McpServer({ name: "browser-image", version: "1" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void mcp.close(); });
  mcp.tool("camofox_screenshot", "test", { tabId: z.string() }, async () => ({ content: [image] }));
  mcp.tool("camofox_snapshot", "test", { tabId: z.string() }, async () => ({ content: [
    { type: "text", text: JSON.stringify({ url: "https://example.com", snapshot: '- heading "Fixture"', hasMore: false }) }, image,
  ] }));
  await mcp.connect(transport); await transport.handleRequest(req, res);
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, extensions: [], browser: { provider: "camofox" },
  mcpServers: [{ name: "camofox", transport: "http", url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp` }],
}, dir, {}), { models, model, log: () => {} });
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
    fauxToolCall("browser_screenshot", { tabId: "tab-1" }), fauxToolCall("browser_snapshot", { tabId: "tab-1" }),
  ], { stopReason: "toolUse" }), fauxAssistantMessage("Browser images delivered")]);
  await page.locator("#input").fill("Show browser images"); await page.locator("#send").click();
  await page.getByText("Browser images delivered", { exact: true }).waitFor();
  async function verifyImages() {
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll("img.tool-image").length === 2);
    await page.locator(".tool details").evaluateAll((items: any[]) => items.forEach(item => item.open = true));
    await page.waitForFunction(() => [...(globalThis as any).document.querySelectorAll("img.tool-image")].every((img: any) => img.complete && img.naturalWidth === 1));
    const images = page.locator("img.tool-image"); assert.equal(await images.count(), 2);
    assert.equal(await images.first().getAttribute("src"), `data:image/png;base64,${png}`);
    assert.equal(await page.getByAltText("browser_screenshot result").count(), 1);
    assert.equal(await page.getByAltText("browser_snapshot result").count(), 1);
    assert.ok(!(await page.locator(".tool pre").allTextContents()).join("").includes(png), "Do not print image bytes as JSON text");
  }
  await verifyImages(); await page.reload(); await verifyImages();
  await page.setViewportSize({ width: 390, height: 844 }); await verifyImages();
  assert.equal(await page.evaluate(() => { const d = (globalThis as any).document; return d.documentElement.scrollWidth <= d.documentElement.clientWidth; }), true);
  assert.deepEqual(errors, []);
  console.log("BROWSER_IMAGE_UI_OK: native screenshot/snapshot image blocks render, load, survive reconnect, no duplicates, mobile, no page errors");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close();
  await new Promise<void>(resolve => http.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
}
