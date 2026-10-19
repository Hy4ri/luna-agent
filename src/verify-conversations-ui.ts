// Real-browser gate for database-backed conversation management.
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
const dir = mkdtempSync(join(tmpdir(), "luna-conversations-ui-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models: rt.models, conversations: rt.conversations, agent: { model }, token: "test" });
const headers = { authorization: "Bearer test", "content-type": "application/json" };
const create = async () => (await (await app.request("/v1/sessions", { method: "POST", headers, body: "{}" })).json() as { id: number }).id;
const first = await create(), second = await create();
await rt.conversations.update(first, { title: "First conversation" });
await rt.conversations.update(second, { title: "Second conversation" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  const row = (id: number) => page.locator(`[data-session="${id}"]`);
  const manage = async (id: number) => {
    await row(id).locator(".session-manage").click();
    await page.locator("#session-menu").waitFor({ state: "visible" });
  };
  const close = async () => { await page.keyboard.press("Escape"); };
  await manage(first);
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByLabel("Conversation name", { exact: true }).fill("Renamed <safe> conversation");
  await page.keyboard.press("Enter");
  await page.waitForFunction((id: number) => {
    const el = (globalThis as any).document.querySelector(`[data-session="${id}"] .session-open`);
    return el && el.textContent === "Renamed <safe> conversation";
  }, first);
  await manage(first);
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await row(first).locator(".session-pin").waitFor();
  await close();
  assert.equal(await page.locator(".session-row").first().getAttribute("data-session"), String(first));
  assert.equal(await row(first).locator(".session-open").textContent(), "Renamed <safe> conversation");
  await row(first).locator(".session-open").click();
  await page.locator("#title").filter({ hasText: "Renamed <safe> conversation" }).waitFor();
  await manage(first); await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await row(first).waitFor({ state: "hidden" });
  await row(first).waitFor({ state: "hidden" });
  assert.equal(await row(first).count(), 0);
  assert.equal(await page.locator("#title").textContent(), "New conversation");
  await page.locator("#history-view").click();
  await assert.equal(await page.locator("#history-view").getAttribute("aria-pressed"), "true");
  await row(first).waitFor();
  await page.reload();
  await page.locator("#history-view").click();
  await row(first).waitFor();
  await manage(first); await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await row(first).waitFor({ state: "hidden" });
  await row(first).waitFor({ state: "hidden" });
  assert.equal(await row(first).count(), 0);
  await page.locator("#history-view").click();
  await row(first).waitFor();
  await manage(first); await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await row(first).locator(".session-pin").waitFor({ state: "hidden" });
  await close();
  assert.equal(await page.locator(".session-row").first().getAttribute("data-session"), String(second));
  // A failed database mutation must not remove the row or close the management dialog.
  await manage(first);
  await page.route(`**/v1/sessions/${first}`, (route: any) => route.fulfill({ status: 409, json: { error: "Stop the conversation first." } }));
  page.once("dialog", (d: any) => d.accept());
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.locator("#history-status").filter({ hasText: "Stop the conversation first." }).waitFor();
  assert.equal(await row(first).count(), 1);
  await page.unroute(`**/v1/sessions/${first}`);
  // Cancelling confirmation preserves the database. Confirming deletion removes it and clears the active view.
  page.once("dialog", (d: any) => d.dismiss());
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click(); await close();
  await row(first).locator(".session-open").click(); await manage(first);
  page.once("dialog", (d: any) => d.accept());
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  assert.equal(await page.locator("#panel").isVisible(), false);
  await row(first).waitFor({ state: "hidden" });
  assert.equal(await row(first).count(), 0);
  assert.equal(await page.locator("#title").textContent(), "New conversation");
  assert.equal((await app.request(`/v1/sessions/${first}`, { headers })).status, 404);
  await page.reload(); assert.equal(await row(first).count(), 0); await row(second).waitFor();
  // Controls fit on a narrow display and remain usable through the navigation drawer.
  await page.setViewportSize({ width: 320, height: 844 }); await page.locator("#menu").click();
  await manage(second);
  const bounds = await page.locator("#session-menu").boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 321);
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByLabel("Conversation name", { exact: true }).fill("Mobile rename");
  await page.keyboard.press("Enter");
  await page.waitForFunction((id: number) => {
    const el = (globalThis as any).document.querySelector(`[data-session="${id}"] .session-open`);
    return el && el.textContent === "Mobile rename";
  }, second);
  await close(); await page.locator("#menu").click();
  await row(second).getByRole("button", { name: "Mobile rename", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("CONVERSATIONS_UI_OK: rename, pin ordering, archive/restore, reload, failed/cancelled/confirmed deletion, active reset, mobile controls");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
