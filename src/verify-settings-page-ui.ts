// Browser behavior, isolated runtime, no external services or model inference.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-settings-page-")); const path = join(dir, "config.json");
const raw = { dataDir: join(dir, "data"), provider: "faux", model: "main", providers: [], extensions: ["cron"],
  mcpServers: [{ name: "secure", transport: "http", url: "http://localhost/mcp", enabled: false, headers: { Authorization: "secret-token-123" } }] };
writeFileSync(path, JSON.stringify(raw));
const faux = fauxProvider({ models: [{ id: "main" }] }); const models = createModels(); models.setProvider(faux.provider);
const model = { provider: "faux", modelId: "main" };
const rt = await startRuntime({ ...parseConfig(raw, dir, {}), configPath: path }, { models, model });
const app = createApp({ harness: rt.harness, settings: rt.settings, models: rt.models, providers: rt.providers, mcp: rt.mcp, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  let acceptDiscard = false;
  page.on("dialog", (dialog: any) => acceptDiscard ? dialog.accept() : dialog.dismiss());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.goto(base); await page.locator("#token").fill("test"); await page.locator("#loginForm button").click(); await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator("#input").fill("Keep this chat draft");
  await page.locator('[data-panel="settings"]').click();
  const screen = page.locator("#settings-screen"); const field = (id: string) => screen.locator(`[data-setting="${id}"]`);
  const tab = (id: string) => screen.locator(`[data-settings-tab="${id}"]`);
  await screen.getByRole("heading", { name: "Settings", exact: true }).waitFor(); await field("dataDir").waitFor();
  assert.equal(await page.locator("#main").isVisible(), false); assert.equal(await page.locator("#panel").isVisible(), false);
  assert.equal(await page.locator('[data-panel="settings"]').getAttribute("aria-current"), "page");
  assert.equal(await screen.getByRole("tab").count(), 5); assert.equal(new URL(page.url()).hash, "#settings");
  await tab("general").focus(); await page.keyboard.press("ArrowRight");
  await field("thinkingLevel").waitFor(); assert.equal(await tab("models").getAttribute("aria-selected"), "true");
  await field("thinkingLevel").selectOption("high"); await tab("context").click(); await field("instructions").fill("Settings draft instruction");
  await tab("models").click(); assert.equal(await field("thinkingLevel").inputValue(), "high");
  await tab("tools").click(); await field("web.searchProvider").selectOption("ddgs"); await field("web.extractProvider").selectOption("disabled");
  await field("web.providers.ddgs.region").fill("fr-fr");
  assert.equal(await field("browser.provider").inputValue(), "disabled");
  await field("browser.provider").selectOption("camofox");
  await field("browser.providers.camofox.mcpServer").fill("secure");
  await tab("general").click(); await tab("tools").click();
  assert.equal(await field("browser.provider").inputValue(), "camofox");
  assert.equal(await field("browser.providers.camofox.mcpServer").inputValue(), "secure");
  await screen.locator("details").evaluateAll((items: any[]) => items.forEach(item => item.open = true));
  const secret = field("mcpServers.0.headers.Authorization"); await secret.waitFor();
  assert.equal(await secret.getAttribute("type"), "password"); assert.equal(await secret.inputValue(), "<secret: unchanged>");
  assert.ok(!(await screen.textContent()).includes("secret-token-123"));
  // Cancelling close or a hash navigation must preserve the draft and visible page.
  await screen.locator("[data-settings-close]").click(); assert.equal(await screen.isVisible(), true);
  await page.evaluate(() => { (globalThis as any).location.hash = "cron"; });
  await page.waitForURL("**/#settings/tools"); assert.equal(await screen.isVisible(), true);
  // Failed save retains all draft values. A retry persists both current and other-tab fields.
  await page.route("**/v1/settings", (route: any) => route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Save fixture failure"}' }) : route.continue());
  await screen.getByRole("button", { name: "Save settings", exact: true }).click(); await screen.getByText("Save fixture failure", { exact: true }).waitFor();
  assert.equal(await field("web.providers.ddgs.region").inputValue(), "fr-fr");
  await page.unroute("**/v1/settings");
  await screen.getByRole("button", { name: "Save settings", exact: true }).click(); await screen.getByText("Saved. Restart Luna to apply runtime changes.", { exact: true }).waitFor();
  const saved = JSON.parse(readFileSync(path, "utf8")); assert.equal(saved.thinkingLevel, "high"); assert.equal(saved.instructions, "Settings draft instruction");
  assert.equal(saved.web.searchProvider, "ddgs"); assert.equal(saved.web.extractProvider, "disabled"); assert.equal(saved.web.providers.ddgs.region, "fr-fr");
  assert.equal(saved.mcpServers[0].headers.Authorization, "secret-token-123");
  assert.deepEqual(saved.browser, { provider: "camofox", providers: { camofox: { mcpServer: "secure" } } });
  await screen.locator("[data-settings-close]").click(); await screen.waitFor({ state: "hidden" }); assert.equal(await page.locator("#input").inputValue(), "Keep this chat draft");
  // A late settings fetch must not reopen a page that the user has closed.
  let requested!: () => void, release!: () => void, delivered!: () => void;
  const requestedPromise = new Promise<void>(resolve => { requested = resolve; });
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const deliveredPromise = new Promise<void>(resolve => { delivered = resolve; });
  await page.route("**/v1/settings", async (route: any) => {
    const response = await route.fetch(); requested(); await responseGate; await route.fulfill({ response }); delivered();
  });
  await page.locator('[data-panel="settings"]').click(); await requestedPromise;
  await screen.locator("[data-settings-close]").click(); release(); await deliveredPromise;
  await page.unroute("**/v1/settings"); await page.waitForTimeout(100);
  assert.equal(await screen.isVisible(), false); assert.equal(await page.locator("#main").isVisible(), true);
  // Initial load failure and retry are visible and recoverable.
  await page.route("**/v1/settings", (route: any) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Load fixture failure"}' }));
  await page.locator('[data-panel="settings"]').click(); await screen.getByRole("alert").filter({ hasText: "Load fixture failure" }).waitFor();
  await page.unroute("**/v1/settings"); await screen.getByRole("button", { name: "Retry", exact: true }).click(); await field("dataDir").waitFor();
  await tab("tools").click(); await field("web.searchProvider").waitFor();
  await page.reload(); await screen.waitFor({ state: "visible" }); await field("web.searchProvider").waitFor(); assert.equal(new URL(page.url()).hash, "#settings/tools");
  assert.equal(await field("browser.provider").inputValue(), "camofox");
  assert.equal(await field("browser.providers.camofox.mcpServer").inputValue(), "secure");
  // Small screens keep navigation available, preserve chat, and do not overflow horizontally.
  await page.setViewportSize({ width: 390, height: 844 });
  await screen.locator("#settings-menu").click(); await page.locator('[data-panel="analytics"]').click(); await page.locator("#analytics-screen").waitFor({ state: "visible" }); assert.equal(await screen.isVisible(), false);
  await page.locator("#analytics-menu").click(); await page.locator('[data-panel="settings"]').click(); await field("dataDir").waitFor();
  await tab("tools").click(); await field("web.providers.ddgs.region").waitFor();
  assert.equal(await page.evaluate(() => { const d = (globalThis as any).document; return d.documentElement.scrollWidth <= d.documentElement.clientWidth; }), true);
  await screen.locator('[data-section="browser"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/luna17-settings-mobile.png" });
  // Reload discards edits only after confirmation; close confirmation can also be accepted.
  await field("web.providers.ddgs.region").fill("uk-en"); acceptDiscard = true;
  await screen.getByRole("button", { name: "Reload", exact: true }).click(); await page.waitForFunction(() => (globalThis as any).document.querySelector('[data-setting="web.providers.ddgs.region"]')?.value === "fr-fr");
  await field("web.providers.ddgs.region").fill("uk-en"); await screen.locator("[data-settings-close]").click(); await screen.waitFor({ state: "hidden" });
  await page.goto(base + "/#settings/context"); await field("instructions").waitFor(); assert.equal(await field("instructions").inputValue(), "Settings draft instruction");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await tab("tools").click(); await screen.locator('[data-section="browser"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/luna17-settings-desktop.png" });
  assert.deepEqual(errors, []);
  console.log("SETTINGS_PAGE_UI_OK: full page, five tabs, keyboard, web/browser provider drafts and persistence, secrets, failure/retry, deep links, mobile navigation");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
