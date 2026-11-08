// Real-browser verification for Level 1 sidebar project-row quick new session (Option A).
// Build web first (`bun run build:web`), then run: `bun test/sidebar-quick-new-browser.mjs`
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.ts";
import { ConversationStore } from "../src/conversations.ts";
import { createApp } from "../src/server.ts";
import { SettingsStore } from "../src/settings.ts";
import { UploadStore } from "../src/uploads.ts";
import { conversationStorage } from "../src/conversation-storage.ts";
import { WorkerStore, WorkerHub } from "../src/workers.ts";

const { chromium } = createRequire(import.meta.url)(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");

const dir = mkdtempSync(join(tmpdir(), "luna-487-ui-"));
const projDirA = join(dir, "luna-pi");
const projDirB = join(dir, "hermes-mobile");
mkdirSync(projDirA);
mkdirSync(projDirB);

const faux = fauxProvider({ models: [{ id: "fixture-model", reasoning: true, input: ["text", "image"] }] });
faux.setResponses(Array.from({ length: 20 }, () => async () => fauxAssistantMessage("fixture reply")));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };

const workerStore = new WorkerStore(join(dir, "workers.db"));
const workers = new WorkerHub(workerStore);
const fixtureToken = "offline-fixture-only-token";

let harness, server, browser;
try {
  harness = await openLuna({
    dbPath: join(dir, "luna.db"),
    models,
    memory: false,
    coding: false,
    cwd: dir,
    remoteEnv: (worker, cwd) => workers.env(worker, cwd),
  });
  const conversations = new ConversationStore(harness);
  const projA = conversations.projects.create("luna-pi", projDirA);
  const projB = conversations.projects.create("hermes-mobile", projDirB);
  const offlineWorker = workerStore.create("arm-worker").worker;
  const projOffline = conversations.projects.create("worker-only", "", {
    worker: offlineWorker.id,
    workerCwd: "/srv/worker-only",
  });

  const settings = new SettingsStore(join(dir, "config.json"), dir);
  const uploads = new UploadStore(join(dir, "uploads"));
  uploads.bind(conversationStorage(harness).db);

  const app = createApp({
    harness,
    conversations,
    models,
    settings,
    uploads,
    workers,
    token: fixtureToken,
    cwd: dir,
    agent: { model, thinkingLevel: "off", instructions: "DEFAULT_ONLY" },
  });
  server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0, idleTimeout: 0 });
  const port = server.port;
  const base = `http://127.0.0.1:${port}`;

  async function request(path, body, method = "POST") {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + fixtureToken },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(res.ok, `${method} ${path}: ${res.status} ${await res.clone().text()}`);
    return res.json();
  }

  // Seed a session in luna-pi and an unscoped session in Chats
  await request("/v1/sessions", { model, project: projA.id, cwd: projDirA });
  await request("/v1/sessions", { model });

  browser = await chromium.launch({
    executablePath: process.env.LUNA_CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });

  // 1. Desktop hover & keyboard focus verification
  const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  await desktopCtx.addInitScript(tok => {
    localStorage.setItem("luna.token", tok);
  }, fixtureToken);
  const page = await desktopCtx.newPage();
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#sessions .folder-row").first().waitFor();

  // Verify semantic HTML: no nested <button> inside <button>
  const nestedButtons = await page.evaluate(() => document.querySelectorAll("#sessions button button").length);
  assert.equal(nestedButtons, 0, "must not nest buttons inside buttons");

  const rowB = page.locator(`#sessions .folder-row[data-project="${projB.id}"]`);
  const quickBtnB = rowB.locator(".folder-quick-new");
  const chevronB = rowB.locator(".folder-chevron");

  // Resting desktop state: chevron visible, quick-new hidden
  assert.equal(await quickBtnB.evaluate(el => getComputedStyle(el).opacity), "0");
  assert.equal(await chevronB.evaluate(el => getComputedStyle(el).opacity), "1");

  // Hover swaps chevron for + without shifting title width
  const widthBefore = await rowB.locator(".folder-title").evaluate(el => el.getBoundingClientRect().width);
  await rowB.hover();
  assert.equal(await quickBtnB.evaluate(el => getComputedStyle(el).opacity), "1");
  assert.equal(await chevronB.evaluate(el => getComputedStyle(el).opacity), "0");
  const widthAfter = await rowB.locator(".folder-title").evaluate(el => el.getBoundingClientRect().width);
  assert.equal(widthAfter, widthBefore, "title width must not reflow on hover");

  await page.screenshot({ path: "/.luna/generated/images/sidebar-quick-new-desktop-hover-s318926.png" });

  // Offline worker-only project has disabled quick-new button with explanation
  const rowOffline = page.locator(`#sessions .folder-row[data-project="${projOffline.id}"]`);
  const quickOffline = rowOffline.locator(".folder-quick-new");
  assert.equal(await quickOffline.isDisabled(), true);
  assert.equal(await quickOffline.getAttribute("title"), "arm-worker is offline");

  // Clicking quick-new on hermes-mobile starts a draft session in hermes-mobile WITHOUT drilling into the folder
  const sessionCreates = [];
  page.on("request", r => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/v1/sessions") {
      sessionCreates.push(r.postDataJSON());
    }
  });

  await quickBtnB.click();
  // Level 1 folder list remains visible (no #history-back)
  assert.equal(await page.locator("#history-back").count(), 0, "sidebar must stay on Level 1 project list");
  assert.equal(await page.evaluate(() => localStorage.getItem("luna.side.project")), null);
  assert.equal(await page.locator("#input").evaluate(el => el === document.activeElement), true, "#input must receive focus");

  // Send a message to confirm the new session actually binds to hermes-mobile
  await page.locator("#input").fill("hello hermes");
  await page.locator("#input").press("Enter");
  for (let i = 0; i < 50 && sessionCreates.length === 0; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(sessionCreates.length, 1);
  assert.equal(sessionCreates[0].project, projB.id);

  // Clicking quick-new on Chats ("none") starts an unscoped session without drilling
  const rowNone = page.locator('#sessions .folder-row[data-project="none"]');
  await rowNone.hover();
  await rowNone.locator(".folder-quick-new").click();
  assert.equal(await page.locator("#history-back").count(), 0, "Chats quick-new must not drill into Chats");
  await page.locator("#input").fill("hello general chat");
  await page.locator("#input").press("Enter");
  for (let i = 0; i < 50 && sessionCreates.length < 2; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(sessionCreates.length, 2);
  assert.equal(sessionCreates[1].project, undefined);

  // Clicking main .folder-open button still drills into the folder as before
  await rowB.locator(".folder-open").click();
  await page.locator("#history-back").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("luna.side.project")), String(projB.id));

  assert.deepEqual(errors, [], "no desktop browser errors");
  await desktopCtx.close();

  // 2. Touch / mobile drawer verification
  const touchCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  await touchCtx.addInitScript(tok => {
    localStorage.setItem("luna.token", tok);
  }, fixtureToken);
  const touchPage = await touchCtx.newPage();
  const touchErrors = [];
  touchPage.on("pageerror", err => touchErrors.push(err.message));

  await touchPage.goto(base, { waitUntil: "domcontentloaded" });
  await touchPage.locator("#menu").click();
  await touchPage.locator("aside#side.open").waitFor();

  const touchRowA = touchPage.locator(`#sessions .folder-row[data-project="${projA.id}"]`);
  const touchQuickA = touchRowA.locator(".folder-quick-new");
  const touchChevronA = touchRowA.locator(".folder-chevron");

  // On coarse pointer, quick-new is always visible and chevron is hidden
  assert.equal(await touchQuickA.evaluate(el => getComputedStyle(el).opacity), "1");
  assert.equal(await touchChevronA.evaluate(el => getComputedStyle(el).display), "none");
  const box = await touchQuickA.boundingBox();
  assert.ok(box && box.width >= 36 && box.height >= 36, `touch target >= 36px (got ${box?.width}x${box?.height})`);

  await touchPage.screenshot({ path: "/.luna/generated/images/sidebar-quick-new-mobile-touch-s318926.png" });

  // Tapping quick-new closes the mobile drawer without drilling into the folder
  await touchQuickA.tap();
  await touchPage.waitForFunction(() => !document.querySelector("aside#side")?.classList.contains("open"));
  assert.equal(await touchPage.evaluate(() => localStorage.getItem("luna.side.project")), null);

  assert.deepEqual(touchErrors, [], "no mobile browser errors");
  await touchCtx.close();

  console.log("All real-browser checks passed.");
} finally {
  await browser?.close();
  if (server) {
    await server.stop(true);
  }
  await harness?.close(context);
  workers.close();
  workerStore.close();
  rmSync(dir, { recursive: true, force: true });
}
