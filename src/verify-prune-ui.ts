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
import { context } from "./luna.js";
import { SessionCreated } from "./session-activity.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-prune-ui-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, conversations: rt.conversations, agent: { model }, token: "test" });
const headers = { authorization: "Bearer test", "content-type": "application/json" };
const create = async (title: string, archived = false) => {
  const { id } = await (await app.request("/v1/sessions", { method: "POST", headers, body: "{}" })).json() as { id: number };
  await rt.conversations.update(id, { title, archived });
  await rt.harness.commit(async tx => { (await tx.doc(SessionCreated, id as never)).at = Date.now() - 10 * 86400000; }, context);
  return id;
};
const current = await create("Current protected"), old = await create("Old to prune"), archived = await create("Archived protected", true);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator(`[data-session="${current}"] .session-open`).click();
  const open = async () => {
    await page.getByRole("button", { name: "History actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Prune sessions", exact: true }).click();
    await page.getByRole("dialog", { name: "Prune sessions", exact: true }).waitFor();
  };
  await open();
  const dialog = page.getByRole("dialog", { name: "Prune sessions", exact: true });
  const days = dialog.getByLabel("Days", { exact: true });
  const include = dialog.getByLabel("Include archived sessions", { exact: true });
  const deletion = dialog.getByRole("button", { name: /^Delete / });
  assert.equal(await days.inputValue(), "7");
  assert.equal(await include.isChecked(), false);
  await dialog.getByRole("button", { name: "Delete 1 session", exact: true }).waitFor();
  for (const value of ["0", "-1", "1.5", ""]) {
    await days.fill(value);
    await page.waitForFunction(() => (globalThis as any).document.querySelector('[data-testid="prune-delete"]')?.disabled);
    assert.equal(await deletion.isDisabled(), true);
  }
  await days.fill("30");
  await dialog.getByText("0 sessions will be permanently deleted.", { exact: true }).waitFor();
  assert.equal(await deletion.isDisabled(), true);
  // Ignore a delayed count for a previous form state.
  let releasePreview!: () => void, previewEntered!: () => void, previewFinished!: () => void;
  const finishedPreview = new Promise<void>(r => { previewFinished = r; });
  const heldPreview = new Promise<void>(r => { releasePreview = r; });
  const enteredPreview = new Promise<void>(r => { previewEntered = r; });
  await page.route("**/v1/sessions/prune/preview", async (route: any) => {
    if (route.request().postDataJSON().days !== 8) return route.continue();
    previewEntered(); await heldPreview; await route.fulfill({ json: { ids: [] } }); previewFinished();
  });
  await days.fill("8"); await enteredPreview;
  await days.fill("7");
  await dialog.getByRole("button", { name: "Delete 1 session", exact: true }).waitFor();
  releasePreview(); await finishedPreview;
  await page.unroute("**/v1/sessions/prune/preview");
  await page.waitForTimeout(100);
  assert.equal(await deletion.textContent().then((s: string) => s.trim()), "Delete 1 session");
  await include.check();
  await dialog.getByRole("button", { name: "Delete 2 sessions", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await app.request(`/v1/sessions/${old}`, { headers })).status, 200);
  await open();
  assert.equal(await days.inputValue(), "7"); assert.equal(await include.isChecked(), false);
  await dialog.getByRole("button", { name: "Delete 1 session", exact: true }).waitFor();
  // A failed write keeps the dialog open and shows the actual backend error.
  await page.route("**/v1/sessions/prune", (route: any) => route.fulfill({ status: 500, json: { error: "Deletion failed in test" } }));
  await deletion.click();
  await dialog.getByRole("alert").filter({ hasText: "Deletion failed in test" }).waitFor();
  assert.equal((await app.request(`/v1/sessions/${old}`, { headers })).status, 200);
  await page.unroute("**/v1/sessions/prune");
  await deletion.click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator("#prune-status").filter({ hasText: "Deleted 1 session." }).waitFor();
  assert.equal((await app.request(`/v1/sessions/${old}`, { headers })).status, 404);
  for (const id of [current, archived]) assert.equal((await app.request(`/v1/sessions/${id}`, { headers })).status, 200);
  // A reopened dialog reads fresh server data, not the previous count. Mobile remains usable.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator("#menu").click();
  await open();
  await dialog.getByText("0 sessions will be permanently deleted.", { exact: true }).waitFor();
  await include.check();
  await dialog.getByRole("button", { name: "Delete 1 session", exact: true }).waitFor();
  const box = await dialog.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 360);
  await page.screenshot({ path: "/tmp/luna-prune-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopBox = await dialog.boundingBox();
  assert.ok(desktopBox && desktopBox.width <= 560, "desktop dialog stays compact");
  await page.screenshot({ path: "/tmp/luna-prune-desktop.png" });
  await deletion.click(); await dialog.waitFor({ state: "hidden" });
  assert.equal((await app.request(`/v1/sessions/${archived}`, { headers })).status, 404);
  assert.equal((await app.request(`/v1/sessions/${current}`, { headers })).status, 200);
  assert.deepEqual(errors, []);
  console.log("PRUNE_UI_OK: defaults, validation, count, cancel, error/retry, current/archive safety, reopen, mobile, actual deletion");
} finally { if (browser) await browser.close(); await new Promise<void>(r => server.close(() => r())); await rt.close(); rmSync(dir, { recursive: true, force: true }); }
