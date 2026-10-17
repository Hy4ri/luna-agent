// Browser gate for the chat model picker, using an isolated runtime and real session writes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-model-picker-"));
const faux = fauxProvider({ models: [{ id: "main" }, { id: "nested/child" }] });
const models = createModels(); models.setProvider(faux.provider);
const model = { provider: "faux", modelId: "main" };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models: rt.models, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.route("**/v1/models", async (route: any) => {
    const response = await route.fetch(), catalog = await response.json();
    catalog.models.push({ provider: "other-provider", id: "other-model", name: "Other model" });
    await route.fulfill({ response, json: catalog });
  });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  const picker = page.locator("#model-picker");
  const open = async () => { await page.locator("#model").click(); await picker.waitFor({ state: "visible" }); };
  const group = picker.locator('details[data-provider="faux"]');
  await open(); assert.equal(await group.getAttribute("open"), null);
  assert.equal(await picker.locator("details").count(), 2);
  assert.equal(await picker.locator('details[data-provider="other-provider"]').getAttribute("open"), null);
  await group.locator("summary").click();
  await group.getByRole("button", { name: "Pin faux/nested/child", exact: true }).click();
  const pinned = picker.locator("[data-pinned-models]");
  assert.equal(await picker.locator(":scope > :first-child").getAttribute("data-pinned-models"), "");
  await pinned.locator('[data-model="faux/nested/child"]').click();
  await picker.waitFor({ state: "hidden" });
  assert.match(await page.locator("#model").textContent(), /nested\/child/);
  const session = await page.evaluate(() => (globalThis as any).localStorage.getItem("luna.session"));
  const state = await (await app.request(`/v1/sessions/${session}`, { headers: { authorization: "Bearer test" } })).json() as any;
  assert.deepEqual(state.agent.model, { provider: "faux", modelId: "nested/child" });
  await page.reload(); await open();
  assert.equal(await group.getAttribute("open"), null);
  assert.equal(await pinned.locator('[data-model="faux/nested/child"]').count(), 1);
  await page.keyboard.press("Escape"); await picker.waitFor({ state: "hidden" });
  // Read storage on each open, not only on page load. Unavailable pins remain removable.
  await page.evaluate(() => (globalThis as any).localStorage.setItem("luna.pinnedModels", JSON.stringify(["offline/missing"])));
  await open();
  assert.equal(await pinned.locator('[data-model="offline/missing"]').isDisabled(), true);
  await pinned.getByRole("button", { name: "Unpin offline/missing", exact: true }).click();
  assert.equal(await pinned.count(), 0);
  assert.equal(await picker.isVisible(), true);
  await page.keyboard.press("Escape");
  await page.evaluate(() => (globalThis as any).localStorage.setItem("luna.pinnedModels", "invalid json"));
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 }); await open();
    await group.locator("summary").click();
    const bounds = await picker.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    await page.keyboard.press("Escape");
  }
  // Native popovers support keyboard activation, focus return, and outside dismissal.
  await page.locator("#model").focus(); await page.keyboard.press("Enter");
  await picker.waitFor({ state: "visible" }); await page.keyboard.press("Escape");
  assert.equal(await page.locator("#model").getAttribute("aria-expanded"), "false");
  await open(); await page.locator("#title").click(); await picker.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log("MODEL_PICKER_UI_OK: collapsed providers, pins, reload, stale pins, real selection, keyboard, mobile layout");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
