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

  // Real API-backed panel content, not static fixtures.
  for (const name of ["agents", "cron", "memory", "skills", "providers", "mcp", "settings"]) {
    await page.locator(`[data-panel=${name}]`).click();
    await page.getByText("Loading…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.locator("#pbody .msg.err").count(), 0, name);
    assert.ok((await page.locator("#pbody").textContent()).trim().length, name);
    assert.equal(await page.evaluate(() => { const p = document.getElementById("pbody")!; return p.scrollWidth <= p.clientWidth + 1; }), true, name + " overflow");
    await page.locator("#pclose").focus(); await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("#panel")), true);
    await page.keyboard.press("Escape");
    await page.locator("#panel").waitFor({ state: "hidden" });
  }
  console.log("OK all seven workspace panels, no panel overflow, keyboard focus and Escape");
  await page.locator('[data-panel="memory"]').click();
  await page.getByLabel("key (optional, e.g. user.timezone)").fill("ui.test");
  await page.getByLabel("fact or note", { exact: true }).fill("Browser test fact");
  await page.locator("#pbody").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Browser test fact", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await page.getByText("Nothing stored.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator('[data-panel="settings"]').click();
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Settings saved. New sessions and subagents use the new defaults.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log("OK memory write/remove and settings save through the real server");
  await page.locator("#file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") });
  await page.getByRole("button", { name: "Remove attached image 1" }).click();
  assert.equal(await page.locator("#atts img").count(), 0);
  await page.locator("#search").fill("not-a-conversation");
  await page.getByText("No matching conversations.", { exact: true }).waitFor();
  await page.locator("#search").fill("");
  await page.screenshot({ path: process.env.LUNA_UI_SCREENSHOTS ? join(process.env.LUNA_UI_SCREENSHOTS, "luna-desktop.png") : join(dir, "desktop.png") });

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
    for (const name of ["agents", "cron", "memory", "skills", "providers", "mcp", "settings"]) {
      await page.locator(`[data-panel=${name}]`).click();
      await page.getByText("Loading…", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => { const p = document.getElementById("pbody")!; return p.scrollWidth <= p.clientWidth + 1; }), true, `${name} at ${viewport.width}`);
      if (name === "providers" && viewport.width === 390 && process.env.LUNA_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.LUNA_UI_SCREENSHOTS, "luna-mobile-providers.png") });
      await page.locator("#pclose").click();
      if (mobile && name !== "settings") await page.locator("#menu").click();
    }
    if (mobile) {
      await page.locator("#input").fill("Line one");
      await page.locator("#input").press("Enter");
      assert.equal(await page.locator("#input").inputValue(), "Line one\n");
      await page.locator("#input").fill("");
      if (viewport.width === 390 && process.env.LUNA_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.LUNA_UI_SCREENSHOTS, "luna-mobile.png") });
      await page.locator("#menu").click();
      await page.locator("#shade").click({ position: { x: viewport.width - 5, y: 200 } });
      assert.equal(await page.locator("#menu").getAttribute("aria-expanded"), "false");
    }
    console.log(`OK ${viewport.width}×${viewport.height}: chat, navigation, all panels, no horizontal overflow`);
  }
  assert.deepEqual(errors, []);
  console.log("WEB_UI_OK (faux model; no external provider or device-keyboard claim)");
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
}
