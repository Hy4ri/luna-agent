// Real browser + isolated SQLite + HTTP. No external services or model calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { UsageDoc, AssistantEntry } from "@earendil-works/pi-durable";
import { openLuna, context } from "./luna.js";
import { createApp } from "./server.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-analytics-ui-"));
const faux = fauxProvider({ models: [{ id: "alpha", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, { id: "beta" }] });
const models = createModels(); models.setProvider(faux.provider);
const model = { provider: "faux", modelId: "alpha" };
const harness = await openLuna({ dbPath: join(dir, "luna.db"), memory: join(dir, "memory.db"), models, cwd: dir });
const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
await conv.commit(async tx => {
  const ledger = await tx.doc(UsageDoc, conv.id);
  ledger.models["faux/alpha"] = { input: 1000, output: 200, cacheRead: 600, cacheWrite: 200, totalTokens: 2000, reasoning: 70, cacheWrite1h: 50, cost: { input: 0.003, output: 0.003, cacheRead: 0.00018, cacheWrite: 0.00075, total: 0.00693 } };
  ledger.models["faux/beta"] = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  ledger.tools["search <script>alert(1)</script>"] = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 3; i++) {
    const msg = fauxAssistantMessage([fauxText("Analytics fixture")]);
    msg.provider = "faux"; msg.model = "alpha"; msg.timestamp = Date.UTC(2026, 9, 2 + i);
    msg.usage = { input: 100, output: 20, cacheRead: 60, cacheWrite: 20, totalTokens: 200, cost: { input: 0.0003, output: 0.0003, cacheRead: 0.000018, cacheWrite: 0.000075, total: 0.000693 } };
    await tx.appendEntry(AssistantEntry, conv.id, { model: [msg] });
  }
}, context);
const app = createApp({ harness, models, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-settings-tab="workspace"]').click();
  await page.locator('#settings-screen [data-panel="analytics"]').click();
  const screen = page.locator("#analytics-screen");
  await screen.getByLabel("Model usage table", { exact: true }).waitFor();
  assert.equal(await page.locator("#main").isVisible(), false);
  assert.equal(await page.locator("#panel").isVisible(), false);
  assert.equal(await page.locator('[data-panel="settings"]').getAttribute("aria-current"), null);
  assert.equal(new URL(page.url()).hash, "#analytics");
  assert.equal(await screen.locator(".a-kpi").nth(0).locator(".a-value").getAttribute("title"), "2,150");
  assert.equal(await screen.locator(".a-kpi").nth(2).locator(".a-value").textContent(), "31.6%");
  assert.equal(await screen.locator("svg.a-chart rect").count(), 12);
  await screen.getByText("Tool-reported usage", { exact: true }).waitFor();
  await screen.getByText("search <script>alert(1)</script>", { exact: true }).waitFor();
  assert.equal(await screen.locator("script").count(), 0, "Tool names must stay text");
  await screen.getByLabel("Model comparison metric").selectOption("cost");
  assert.ok((await screen.locator(".a-bars").textContent()).includes("$0.00693"));
  await screen.getByLabel("Analytics model").selectOption("faux/alpha");
  assert.equal(await screen.locator(".a-kpi").nth(0).locator(".a-value").getAttribute("title"), "2,000");
  await screen.getByRole("heading", { name: "Current model rates", exact: true }).waitFor();
  assert.equal(await screen.getByRole("heading", { name: "Tool-reported usage", exact: true }).count(), 0);
  await screen.getByText("$3.75", { exact: true }).waitFor();
  await screen.getByLabel("Analytics model").selectOption("faux/beta");
  await screen.getByText("No dated response history is available.", { exact: true }).waitFor();
  await screen.getByText("Not reported", { exact: true }).first().waitFor();
  await screen.getByLabel("Analytics model").selectOption("");
  await screen.getByRole("button", { name: "beta", exact: true }).click();
  assert.equal(await screen.getByLabel("Analytics model").inputValue(), "faux/beta");
  console.log("OK totals, per-model selection, charts, exact costs, nullable counters, rates, safe tool text");

  // A failed refresh must retain the snapshot and permit retry without replacing the select.
  const originalSelect = await screen.getByLabel("Analytics model").elementHandle();
  await page.route("**/v1/analytics", (route: any) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Fixture failure" }) }));
  await screen.getByRole("button", { name: "Refresh", exact: true }).click();
  await screen.getByText(/Showing the previous snapshot.*Fixture failure/).waitFor();
  assert.equal(await screen.getByRole("button", { name: "Refresh", exact: true }).isDisabled(), false);
  await page.unroute("**/v1/analytics");
  await screen.getByRole("button", { name: "Refresh", exact: true }).click();
  await screen.locator(".a-status").filter({ hasText: "All retained history" }).waitFor();
  assert.equal(await originalSelect.evaluate((el: any) => el === (globalThis as any).document.querySelector('[aria-label="Analytics model"]')), true);

  // Delayed response after close/reopen must not overwrite the current snapshot.
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const waiting = new Promise<void>(r => { arrived = r; });
  let intercepted = false;
  await page.route("**/v1/analytics", async (route: any) => {
    if (!intercepted) { intercepted = true; const response = await route.fetch(); const data = await response.json(); data.sessions = 999; arrived(); await gate; await route.fulfill({ json: data }); }
    else await route.continue();
  });
  await screen.getByRole("button", { name: "Refresh", exact: true }).click(); await waiting;
  await screen.getByRole("button", { name: "Back to chat", exact: true }).click();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-settings-tab="workspace"]').click();
  await page.locator('#settings-screen [data-panel="analytics"]').click();
  await screen.locator('.a-status').filter({ hasText: 'All retained history' }).waitFor();
  release(); await page.waitForTimeout(100);
  await screen.getByLabel("Analytics model").selectOption("");
  assert.equal(await screen.locator(".a-kpi").nth(3).locator(".a-value").textContent(), "1");
  await page.unroute("**/v1/analytics");
  console.log("OK failed refresh, retry, retained controls, stale response after navigation");

  await page.screenshot({ path: "/tmp/luna-analytics-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await screen.getByRole("button", { name: "Open navigation", exact: true }).click();
  assert.equal(await page.locator("#side").evaluate((el: any) => el.inert), false);
  assert.equal(await screen.evaluate((el: any) => el.inert), true);
  await page.locator('[data-panel="cron"]').click();
  assert.equal(await screen.isVisible(), false);
  assert.equal(await page.locator("#cron-screen").isVisible(), true);
  await page.locator("#cron-menu").click();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-settings-tab="workspace"]').click();
  await page.locator('#settings-screen [data-panel="analytics"]').click();
  assert.equal(await screen.isVisible(), true);
  await screen.locator(".a-status").filter({ hasText: "All retained history" }).waitFor();
  assert.equal(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).innerWidth), false);
  assert.equal(await screen.evaluate((el: any) => el.scrollWidth > el.clientWidth), false);
  await page.screenshot({ path: "/tmp/luna-analytics-mobile.png", fullPage: true });
  await screen.getByRole("button", { name: "Back to chat", exact: true }).click();
  assert.equal(await page.locator("#main").isVisible(), true);
  await page.goto(page.url().split("#")[0] + "#analytics");
  await screen.getByLabel("Model usage table", { exact: true }).waitFor();
  assert.equal(await page.locator("#main").isVisible(), false);
  console.log("OK mobile layout, navigation inert state, Cron transitions, back to chat, direct hash");

  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await screen.evaluate((el: any) => el.scrollWidth > el.clientWidth), false, "320px layout must not overflow");
  await page.route("**/v1/analytics", (route: any) => route.fulfill({ status: 500, json: { error: "Initial load failed" } }));
  await page.reload();
  await screen.getByText(/Could not load usage.*Initial load failed/).waitFor();
  assert.equal(await screen.locator(".a-kpi").count(), 0, "Failed initial load must not show false zero totals");
  await page.unroute("**/v1/analytics");
  await screen.getByRole("button", { name: "Refresh", exact: true }).click();
  await screen.getByLabel("Model usage table", { exact: true }).waitFor();

  const empty = { generatedAt: new Date().toISOString(), scope: "No retained conversations", totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: null, cacheWrite1h: null, cacheHitRate: null, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, sessions: 0, models: [], tools: [], notes: [] };
  await page.route("**/v1/analytics", (route: any) => route.fulfill({ json: empty }));
  await screen.getByRole("button", { name: "Refresh", exact: true }).click();
  await screen.getByText(/No model usage recorded yet/).waitFor();
  assert.equal(await screen.getByLabel("Analytics model").inputValue(), "");
  assert.equal(await screen.locator(".a-kpi").nth(2).locator(".a-value").textContent(), "Not reported");
  await page.unroute("**/v1/analytics");
  assert.deepEqual(errors, []);
  console.log("ANALYTICS_UI_OK: real HTTP/browser, chart data, filters, details, failure/retry, stale response, empty state, mobile navigation, no page errors");
} finally {
  if (browser) await browser.close();
  await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); if ("closeAllConnections" in server) server.closeAllConnections(); });
  await harness.close(context); rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
