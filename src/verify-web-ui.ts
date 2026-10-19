// Browser gate. Use an installed Playwright: LUNA_PLAYWRIGHT_PATH=/path/to/playwright.
// The server, model, settings file, and databases are isolated. No external model calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

// These names exist only inside callbacks evaluated in Chromium.
declare const document: any;
declare const window: any;
declare const innerWidth: number;
declare const innerHeight: number;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-web-ui-"));
const raw = { dataDir: join(dir, "data"), cwd: dir, provider: "faux" };
const configPath = join(dir, "luna.config.json");
writeFileSync(configPath, JSON.stringify(raw));
const cfg = { ...parseConfig(raw, dir, {}), configPath };
const faux = fauxProvider();
faux.setResponses(Array(20).fill(() => fauxAssistantMessage([fauxText("## A clear response\n\nThe **chat** works.\n\n```js\nconsole.log('hello');\n```\n\n| Item | State |\n| --- | --- |\n| Chat | Ready |\n\n<script>window.injected = true</script>")])));
const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel();
const model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(cfg, { models, model, log: () => {} });
const app = createApp({ harness: rt.harness, token: "ui-token", agent: { model }, settings: rt.settings, models: rt.models, providers: rt.providers, store: rt.store, scheduler: rt.scheduler, memory: rt.memory, skillDirs: rt.skillDirs, mcp: rt.mcp });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.on("dialog", (dialog: any) => dialog.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator("#token").fill("wrong");
  await page.locator("#loginForm button").click();
  await page.getByText("token rejected", { exact: true }).waitFor();
  await page.locator("#token").fill("ui-token");
  await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator("#welcome").waitFor();
  await page.screenshot({ path: join(dir, "desktop-empty.png") });
  await page.locator("#input").fill("Show me a response");
  await page.locator("#send").click();
  await page.locator(".assistant h2").waitFor();
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "Ready");
  assert.equal(await page.locator(".assistant strong").textContent(), "chat");
  assert.equal(await page.evaluate(() => (window as any).injected), undefined);
  assert.equal(await page.locator("#welcome").count(), 0);
  assert.equal(await page.locator(".assistant table").count(), 1);
  console.log("OK authenticated streaming chat, markdown, safe text rendering, empty state");

  // Cron has page navigation, not modal focus trapping or Escape-to-close.
  async function checkCronPage() {
    const screen = page.locator("#cron-screen");
    await screen.waitFor();
    await screen.locator('[data-cron-list="latest"]').getByText("No matching records.", { exact: true }).waitFor();
    assert.equal(await screen.locator(".cron-error").count(), 0);
    assert.equal(await page.locator("#panel").isVisible(), false);
    assert.equal(await page.locator("#main").isVisible(), false);
    assert.equal(await page.locator('[data-panel="cron"]').getAttribute("aria-current"), "page");
    assert.equal(new URL(page.url()).hash, "#cron");
    assert.equal(await screen.evaluate((p: any) => p.scrollWidth <= p.clientWidth + 1), true, "Cron page overflow");
    await page.keyboard.press("Escape");
    assert.equal(await screen.isVisible(), true, "Escape must not close a workspace page");
    await screen.getByRole("button", { name: "Back to chat", exact: true }).click();
    await screen.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#main").isVisible(), true);
    assert.equal(await page.locator('[data-panel="cron"]').getAttribute("aria-current"), null);
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(await page.locator("#input").evaluate((input: any) => input === document.activeElement), true);
    assert.equal(await page.locator(".assistant strong").textContent(), "chat", "Chat survives Cron navigation");
  }

  async function checkSettingsPage() {
    const screen = page.locator("#settings-screen");
    await screen.waitFor({ state: "visible" });
    await screen.locator('[data-setting="dataDir"]').waitFor();
    assert.equal(await page.locator("#main").isVisible(), false);
    assert.equal(await page.locator("#panel").isVisible(), false);
    assert.equal(await screen.getByRole("tab").count(), 6);
    await screen.locator('[data-settings-tab="tools"]').click();
    assert.equal(await screen.locator('[data-setting="browser.provider"]').inputValue(), "disabled");
    assert.equal(await screen.locator('[data-setting="browser.providers.camofox.mcpServer"]').inputValue(), "camofox");
    assert.equal(await page.evaluate(() => { const p = document.getElementById("settings-screen")!; return p.scrollWidth <= p.clientWidth + 1; }), true, "Settings overflow");
    await screen.getByRole("button", { name: "Back to chat", exact: true }).click();
    await screen.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#main").isVisible(), true);
    assert.equal(await page.locator("#input").evaluate((input: any) => input === document.activeElement), true);
  }

  async function checkAnalyticsPage() {
    const screen = page.locator('#analytics-screen');
    await screen.waitFor({ state: 'visible' });
    await screen.getByLabel('Model usage table', { exact: true }).waitFor();
    assert.equal(await page.locator('#panel').isVisible(), false);
    await page.keyboard.press('Escape');
    assert.equal(await screen.isVisible(), true);
    assert.equal(await screen.evaluate((p: any) => p.scrollWidth <= p.clientWidth + 1), true);
    await screen.getByRole('button', { name: 'Back to chat', exact: true }).click();
  }
  async function showNavigation() {
    if (page.viewportSize().width <= 760 && !(await page.locator('#side').evaluate((el: any) => el.classList.contains('open')))) await page.locator('#menu').click();
  }

  // Real API-backed workspace content, not static fixtures.
  for (const name of ["cron", "settings"]) {
    await showNavigation();
    await page.locator(`[data-panel=${name}]`).click();
    if (name === "cron") { await checkCronPage(); continue; }
    if (name === "settings") { await checkSettingsPage(); continue; }
  }
  for (const name of ["agents", "analytics", "memory", "skills", "providers", "mcp"]) {
    await showNavigation();
    await page.locator('[data-panel="settings"]').click();
    await page.locator('[data-settings-tab="workspace"]').click();
    await page.locator(`#settings-screen [data-panel="${name}"]`).click();
    if (name === "analytics") { await checkAnalyticsPage(); continue; }
    await page.getByText("Loading…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.locator("#pbody .msg.err").count(), 0, name);
    assert.ok((await page.locator("#pbody").textContent()).trim().length, name);
    assert.equal(await page.evaluate(() => { const p = document.getElementById("pbody")!; return p.scrollWidth <= p.clientWidth + 1; }), true, name + " overflow");
    await page.locator("#pclose").focus(); await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#panel")), true);
    await page.keyboard.press("Escape");
    await page.locator("#panel").waitFor({ state: "hidden" });
  }
  console.log("OK workspace panels via Settings workspace tab, full-page Cron and Settings, browser provider controls, no overflow, panel focus and Escape, return to chat");
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-settings-tab="workspace"]').click();
  await page.locator('#settings-screen [data-panel="memory"]').click();
  await page.getByLabel("key (optional, e.g. user.timezone)").fill("ui.test");
  await page.getByLabel("fact or note", { exact: true }).fill("Browser test fact");
  await page.locator("#pbody").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Browser test fact", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await page.getByText("Nothing stored.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator('[data-panel="settings"]').click();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Settings saved. Compaction changes apply now. New sessions and subagents use the new defaults.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  console.log("OK memory write/remove and settings save through the real server");
  await page.locator("#file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") });
  await page.getByRole("button", { name: "Remove attached image 1" }).click();
  assert.equal(await page.locator("#atts img").count(), 0);
  await page.locator("#search-toggle").click();
  await page.locator("#search").fill("not-a-conversation");
  await page.getByText("No matching conversations.", { exact: true }).waitFor();
  await page.locator("#search").fill("");
  await page.screenshot({ path: process.env.LUNA_UI_SCREENSHOTS ? join(process.env.LUNA_UI_SCREENSHOTS, "luna-desktop.png") : join(dir, "desktop.png") });

  await page.locator('#side-collapse').click();
  assert.equal(await page.locator('#side-collapse').getAttribute('aria-label'), 'Expand sidebar');
  assert.equal(await page.evaluate(() => localStorage.getItem('luna.side.collapsed')), '1');
  await page.waitForFunction(() => document.getElementById('side')!.getBoundingClientRect().width <= 64);
  await page.locator('#side-collapse').click();
  const separator = page.locator('#side-resize');
  await separator.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await separator.getAttribute('aria-valuenow'), '280');
  await separator.dblclick();
  assert.equal(await separator.getAttribute('aria-valuenow'), '264');
  for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const mobile = viewport.width <= 760;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(viewport));
    assert.equal(await page.locator("#input").isVisible(), true);
    assert.equal(await page.evaluate(() => { const b = document.getElementById("send")!.getBoundingClientRect(); return b.bottom <= innerHeight && b.right <= innerWidth; }), true, "send visible");
    if (mobile) {
      await page.locator("#menu").click();
      assert.equal(await page.locator("#menu").getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#menu").getAttribute("aria-expanded"), "false");
      await page.locator("#menu").click();
    }
  for (const name of ["cron", "settings"]) {
    await showNavigation();
    await page.locator(`[data-panel=${name}]`).click();
    if (name === "cron") {
      await checkCronPage();
      if (mobile) await page.locator("#menu").click();
      continue;
    }
    if (name === "settings") { await checkSettingsPage(); continue; }
  }
  for (const name of ["agents", "analytics", "memory", "skills", "providers", "mcp"]) {
    await showNavigation();
    await page.locator('[data-panel="settings"]').click();
    await page.locator('[data-settings-tab="workspace"]').click();
    await page.locator(`#settings-screen [data-panel="${name}"]`).click();
    if (name === "analytics") { await checkAnalyticsPage(); continue; }
    await page.getByText("Loading…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => { const p = document.getElementById("pbody")!; return p.scrollWidth <= p.clientWidth + 1; }), true, `${name} at ${viewport.width}`);
    if (name === "providers" && viewport.width === 390 && process.env.LUNA_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.LUNA_UI_SCREENSHOTS, "luna-mobile-providers.png") });
    await page.locator("#pclose").click();
    if (mobile) await page.locator("#menu").click();
  }
    if (mobile) {
      if (await page.locator("#side").evaluate((el: any) => el.classList.contains("open"))) await page.keyboard.press("Escape");
      await page.locator("#input").fill("Line one");
      await page.locator("#input").press("Enter");
      assert.equal(await page.locator("#input").inputValue(), "Line one\n");
      await page.locator("#input").fill("");
      if (viewport.width === 390 && process.env.LUNA_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.LUNA_UI_SCREENSHOTS, "luna-mobile.png") });
      await page.locator("#menu").click();
      await page.locator("#shade").click({ position: { x: viewport.width - 5, y: 200 } });
      assert.equal(await page.locator("#menu").getAttribute("aria-expanded"), "false");
    }
    console.log(`OK ${viewport.width}×${viewport.height}: chat, navigation, five panels, Cron and Settings pages, no horizontal overflow`);
  }
  assert.deepEqual(errors, []);
  console.log("WEB_UI_OK (faux model; no external provider or device-keyboard claim)");
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
}
