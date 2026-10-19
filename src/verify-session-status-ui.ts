// Browser verification: real lifecycle synchronization plus deterministic rendering of every status.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-session-status-ui-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model, log: () => {} });
const app = createApp({ harness: rt.harness, models, conversations: rt.conversations, agent: { model }, token: "test" });
const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
await rt.conversations.update(conv.id, { title: "A long session title that must leave space for status and controls", pinned: true });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any, release: (() => void) | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript((id: string) => { localStorage.setItem("luna.token", "test"); localStorage.setItem("luna.session", id); }, String(conv.id));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const row = () => page.locator(`[data-session="${conv.id}"]`);
  const expectStatus = async (key: string, label: string) => {
    if (key === "ready") {
      // Ready shows nothing — wait for absence of any status label and indicator.
      await row().locator(".session-status").waitFor({ state: "hidden" });
      await page.locator("#session-status").waitFor({ state: "hidden" });
      return;
    }
    await row().locator(`.session-status[data-status="${key}"]`).filter({ hasText: label }).waitFor();
    await page.locator(`#session-status[data-status="${key}"]`).waitFor();
  };
  await expectStatus("ready", "Ready");
  let entered!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("Response finished."); }]);
  await page.locator("#input").fill("Please work"); await page.locator("#send").click(); await started;
  await expectStatus("running", "Running");
  assert.equal(await row().locator(".session-running svg").count(), 1);
  release!(); await conv.waitForIdle(context);
  // The active session's detail GET (triggered by the live feed) marks it read immediately,
  // so the sidebar shows ready (nothing) rather than finished for the current session.
  await expectStatus("ready", "Ready");
  assert.equal(await row().locator(".session-running svg").count(), 0);
  await page.reload(); await expectStatus("ready", "Ready");
  console.log("OK real ready/running/finished; active session clears finished to ready immediately");

  const questions = [{ header: "Target", question: "Which target should I use?", options: [{ label: "Local", description: "Local target" }, { label: "Remote", description: "Remote target" }] }];
  faux.setResponses([fauxAssistantMessage([fauxToolCall("ask_user_question", { questions })], { stopReason: "toolUse" }), fauxAssistantMessage("Answer received.")]);
  await page.locator("#input").fill("Ask me"); await page.locator("#send").click();
  await expectStatus("needs_input", "Needs input");
  assert.equal(await row().locator(".session-running svg").count(), 0, "human-blocked execution must not keep spinning");
  const snapshot = await (await app.request(`/v1/sessions/${conv.id}`, { headers: { authorization: "Bearer test" } })).json() as any;
  const answer = await app.request(`/v1/sessions/${conv.id}/questions/${snapshot.questions[0].callId}`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ answers: [{ questionIndex: 0, kind: "option", answer: "Local" }], cancelled: false }) });
  assert.equal(answer.status, 200); await conv.waitForIdle(context); await expectStatus("finished", "Finished");
  console.log("OK questionnaire attention appears without a spinner and clears after answer");

  const cases = [ ["ready", "Ready"], ["running", "Running"], ["finished", "Finished"], ["needs_approval", "Needs approval"], ["needs_input", "Needs input"], ["limit_reached", "Limit reached"], ["failed", "Failed"], ["stopped", "Stopped"] ];
  let selected = "ready";
  await page.route("**/v1/sessions", async (route: any) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(), body = await response.json();
    for (const session of body.sessions) if (session.id === conv.id) {
      session.status = selected; session.statusReason = "A precise reason for this state";
      session.running = ["running", "needs_input", "needs_approval"].includes(selected);
    }
    await route.fulfill({ response, json: body });
  });
  const colors = new Map<string, string>();
  for (const width of [1200, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [key, label] of cases) {
      selected = key!; await page.reload();
      if (width === 320) await page.locator("#menu").click();
      await expectStatus(key!, label!);
      const isReady = key === "ready";
      assert.equal(await row().locator(".session-status").count(), isReady ? 0 : 1, `${key}: label absent when ready`);
      if (!isReady) {
        assert.equal((await row().locator(".session-status").textContent()).trim(), label);
        assert.equal(await row().locator(".session-status").getAttribute("title"), "A precise reason for this state");
      }
      assert.equal(await row().locator(".session-running svg").count(), key === "running" ? 1 : 0);
      assert.equal(await row().locator(".session-state-dot").count(), (!isReady && key !== "running") ? 1 : 0);
      if (!isReady) {
        const indicator = row().getByRole("img", { name: label, exact: true });
        await indicator.waitFor();
        const color = await row().locator(".session-status").evaluate((element: any) => (globalThis as any).getComputedStyle(element).color);
        assert.equal(await indicator.evaluate((element: any) => (globalThis as any).getComputedStyle(element).color), color);
        colors.set(key!, color);
      }
      assert.equal(await page.locator("#sessions").evaluate((element: any) => element.scrollWidth <= element.clientWidth), true, `${width}/${key} sidebar overflow`);
      assert.equal(await page.locator("#main").evaluate((element: any) => element.scrollWidth <= element.clientWidth), true, `${width}/${key} chat overflow`);
      if (!isReady) {
        const box = await row().boundingBox(), indicator2 = row().getByRole("img", { name: label, exact: true }), gutter = await indicator2.boundingBox();
        assert.ok(gutter && box && gutter.x >= 0 && gutter.x + gutter.width <= box.x, "indicator stays in left gutter");
      }
      const title = await row().locator(".session-title").boundingBox(), manage = await row().locator(".session-manage").boundingBox();
      assert.ok(title && manage && title.x + title.width <= manage.x, "title does not overlap management control");
    }
    await page.screenshot({ path: `/tmp/luna-session-status-${width === 320 ? "mobile" : "desktop"}.png` });
  }
  assert.equal(new Set(["running", "finished", "needs_approval", "needs_input", "limit_reached", "failed"].map(key => colors.get(key))).size, 6, "actionable colors must be distinct");
  assert.deepEqual(errors, []);
  console.log("SESSION_STATUS_UI_OK: eight labeled colors, reasons, correct spinner, desktop/mobile layout");
} finally {
  release?.(); await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rt.close(); rmSync(dir, { recursive: true, force: true });
}
