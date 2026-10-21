// Built UI, real HTTP routes, isolated SQLite, and no external model calls.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const { chromium } = createRequire(import.meta.url)("playwright");
const dir = mkdtempSync(join(tmpdir(), "general-board-ui-"));
let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
let server: ReturnType<typeof serve> | undefined, browser: any;
try {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel();
  rt = await startRuntime(loadConfig(config), { models, model: { provider: m.provider, modelId: m.id } });
  const app = createApp({ harness: rt.harness, models: rt.models, conversations: rt.conversations, projectExtensions: rt.projectExtensions, agent: { model: { provider: m.provider, modelId: m.id } } });
  const plain = await (await app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: number };
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(r => server!.listening ? r() : server!.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript((id: number) => localStorage.setItem("luna.session", String(id)), plain.id);
  await page.goto(url);
  await page.locator(`[data-session="${plain.id}"]`).waitFor();
  assert.equal(await page.locator('.session-group[data-project="none"] .group-name').textContent(), "Chats");
  assert.equal(await page.locator('.group-name').count(), 1, "General does not duplicate Chats in the sidebar");
  await page.locator('[data-panel="board"]').click();
  const selector = page.getByLabel("Project", { exact: true });
  await page.waitForFunction(() => (globalThis as any).document.querySelector('.kb-project select')?.value === "0");
  assert.deepEqual(await selector.locator("option").allTextContents(), ["General"], "Board works without project setup");
  await page.getByRole("button", { name: "New card", exact: true }).click();
  const editor = page.getByRole("form", { name: "Card editor" });
  await editor.getByLabel("Card title", { exact: true }).fill("General browser card");
  await editor.getByRole("button", { name: "Save card", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const card = rt.conversations.board.list(0).find(c => c.subject === "General browser card");
  assert.ok(card, "Browser created a persisted General card");
  await page.locator('#pclose').click();
  // Zero is a real project ID, including the # mention picker.
  await page.locator('#input').fill('#');
  await page.locator('#input').press('End');
  await page.getByText('General browser card', { exact: true }).waitFor();
  await page.locator('#input').fill('');
  await page.locator('[data-panel="projects"]').click();
  await page.locator('.pw-item[data-project="0"]').click();
  assert.equal(await page.getByRole("button", { name: "Delete", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Working directory", { exact: true }).count(), 0);
  await page.locator('#project-chat').click();
  await page.locator('#panel').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('.session-group[data-project="none"] [data-session]').length === 2);
  const named = rt.conversations.projects.create("Named", dir);
  const namedCard = rt.conversations.board.create(named.id, { subject: "Named-only browser card" });
  // A saved named board must not override the active General chat on reopen.
  await page.evaluate((id: number) => localStorage.setItem('luna.project', String(id)), named.id);
  await page.locator('[data-panel="board"]').click();
  await page.locator(`[data-card="${card.id}"]`).waitFor();
  assert.equal(await selector.inputValue(), '0');
  assert.equal(await page.locator(`[data-card="${namedCard.id}"]`).count(), 0);
  await selector.selectOption(String(named.id));
  await page.locator(`[data-card="${namedCard.id}"]`).waitFor();
  assert.equal(await page.locator(`[data-card="${card.id}"]`).count(), 0, "Named board stays isolated");
  await page.locator('#pclose').click();
  await page.locator('[data-panel="board"]').click();
  await page.locator(`[data-card="${card.id}"]`).waitFor();
  assert.equal(await selector.inputValue(), '0', "Reopen follows the active chat");
  // The same board is usable at a mobile viewport.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator(`[data-card="${card.id}"]`).waitFor();
  const box = await page.locator('#panel [role="dialog"]').boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 800);
  assert.deepEqual(errors, []);
  console.log("GENERAL_BOARD_UI_OK");
} finally {
  await browser?.close();
  if (server) { if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  await rt?.close();
  rmSync(dir, { recursive: true, force: true });
}
