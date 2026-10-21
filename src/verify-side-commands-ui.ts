// Real browser, runtime, HTTP, SSE, and SQLite. Only model responses are scripted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
const dir = mkdtempSync(join(tmpdir(), "luna-side-ui-"));
const png = join(dir, "image.png");
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: [], auxiliary: { review: { provider: fm.provider, model: fm.id } } }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models, sideCommands: rt.sideCommands, conversations: rt.conversations, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once("listening", r));
const mainStarted = gate(), mainRelease = gate(), btwStarted = gate(), btwRelease = gate(), bgStarted = gate(), bgRelease = gate();
let browser: any;
try {
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const other = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  faux.setResponses([fauxAssistantMessage("Seed response")]);
  await (await conv.submit({ type: "input", content: "Seed context" }, context)).wait(context);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }); page.setDefaultTimeout(12000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript((id: string) => { localStorage.setItem("luna.token", "test"); localStorage.setItem("luna.session", id); }, String(conv.id));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.waitForFunction(() => (globalThis as any).document.getElementById("input") && !(globalThis as any).document.getElementById("activity")?.textContent?.includes("Reconnecting"));
  let mainCancelled = false, mainCompleted = false;
  faux.setResponses([async (_ctx, options) => {
    options?.signal?.addEventListener("abort", () => { if (!mainCompleted) mainCancelled = true; }, { once: true });
    mainStarted.resolve(); await mainRelease.promise; mainCompleted = true; return fauxAssistantMessage("Main final");
  }, async () => { btwStarted.resolve(); await btwRelease.promise; return fauxAssistantMessage("BTW answer"); },
  async () => { bgStarted.resolve(); await bgRelease.promise; return fauxAssistantMessage(`Before media\nMEDIA:${png}\nAfter media`); }]);
  async function send(text: string) {
    await page.waitForFunction(() => (globalThis as any).document.getElementById("input") && !(globalThis as any).document.getElementById("activity")?.textContent?.includes("Reconnecting"));
    await page.locator("#input").fill(text); await page.locator("#send").click();
  }
  await send("Main task"); await mainStarted.promise;
  await send("/btw <b>side question</b>"); await btwStarted.promise;
  const btwCard = page.locator('.side-job').filter({ hasText: "<b>side question</b>" });
  await btwCard.getByText(/\/btw · Started/).waitFor();
  assert.equal(await btwCard.locator("b").count(), 0, "question text must be escaped");
  assert.ok((await btwCard.textContent()).includes("Not in main history"));
  await send("/bg background task"); await bgStarted.promise;
  const bgCard = page.locator('.side-job').filter({ hasText: "background task" });
  await bgCard.getByText(/\/bg · Started/).waitFor();
  assert.equal(mainCancelled, false); assert.equal((await conv.agent(context)).model?.modelId, fm.id);
  btwRelease.resolve(); bgRelease.resolve();
  await btwCard.getByText("BTW answer", { exact: true }).waitFor();
  await bgCard.getByText(/\/bg · Complete/).waitFor();
  await bgCard.locator("img").waitFor();
  assert.ok((await bgCard.locator("img").getAttribute("src")).startsWith("blob:"));
  assert.equal(await bgCard.evaluate((card: any) => {
    const content = card.querySelector(".md"), image = content.querySelector(".side-media");
    return !!image.previousElementSibling?.textContent.includes("Before media") && !!image.nextElementSibling?.textContent.includes("After media");
  }), true, "media stays at its directive position");

  // Force completion SSE to precede the started HTTP receipt.
  faux.setResponses([fauxAssistantMessage("FAST_ANSWER")]);
  await page.route("**/messages?async=1", async (route: any) => {
    const response = await route.fetch();
    await page.locator(".side-job").filter({ hasText: "FAST_ANSWER" }).waitFor();
    await route.fulfill({ response });
  });
  await send("/btw fast question");
  await page.waitForFunction(() => (globalThis as any).document.getElementById("input") && !(globalThis as any).document.getElementById("activity")?.textContent?.includes("Reconnecting"));
  const fast = page.locator(".side-job").filter({ hasText: "fast question" });
  assert.ok((await fast.textContent()).includes("Complete")); assert.ok((await fast.textContent()).includes("FAST_ANSWER"));
  await page.unroute("**/messages?async=1");

  const modelContext = JSON.stringify((await conv.context(context)).messages);
  assert.ok(!modelContext.includes("side question") && !modelContext.includes("BTW answer") && !modelContext.includes("background task") && !modelContext.includes("FAST_ANSWER"));
  await page.evaluate((id: string) => (globalThis as any).openSession(id), String(other.id));
  assert.equal(await page.locator(".side-job").count(), 0);
  await page.evaluate((id: string) => (globalThis as any).openSession(id), String(conv.id));
  await page.locator(".side-job").filter({ hasText: "FAST_ANSWER" }).waitFor();
  await page.locator(".side-job").filter({ hasText: "BTW answer" }).waitFor();
  await page.locator(".side-job").filter({ hasText: "background task" }).locator("img").waitFor();
  mainRelease.resolve(); await conv.waitForIdle(context);
  await page.locator("#log").getByText("Main final", { exact: true }).waitFor();
  assert.equal(mainCancelled, false); assert.deepEqual(errors, []);
  // A reload reconnects and restores out-of-band results without adding transcript entries.
  await page.reload(); await page.locator(".side-job").filter({ hasText: "FAST_ANSWER" }).waitFor();
  assert.equal((await rt.sideCommands.list(String(conv.id))).length, 3);
  // Review cards stay at their start position as later durable and live messages arrive.
  faux.setResponses([fauxAssistantMessage("REVIEW_FINDING: Missing coverage for cancellation.")]);
  await send("/review cancellation coverage");
  const review = page.locator('.side-job').filter({ hasText: 'cancellation coverage' });
  await review.getByRole('button', { name: 'Send to agent', exact: true }).waitFor();
  assert.ok(!JSON.stringify((await conv.context(context)).messages).includes('REVIEW_FINDING'));
  faux.setResponses([fauxAssistantMessage('Later reply')]);
  await send('Later user message');
  await page.getByText('Later reply', { exact: true }).waitFor();
  async function assertOrder() {
    assert.equal(await review.evaluate((card: any) => {
      const later = [...(globalThis as any).document.querySelectorAll('.user-content')].find(el => el.textContent === 'Later user message');
      return !!later && !!(card.compareDocumentPosition(later) & (globalThis as any).Node.DOCUMENT_POSITION_FOLLOWING);
    }), true, 'later user messages render below the review');
  }
  await assertOrder();
  await page.reload();
  await review.getByRole('button', { name: 'Send to agent', exact: true }).waitFor();
  await assertOrder();
  // A rejected submission preserves the draft and allows the same report to be retried.
  await page.locator('#input').fill('Keep this draft');
  await page.route('**/messages?async=1', (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Report delivery failed' }) }));
  await review.getByRole('button', { name: 'Send to agent', exact: true }).click();
  await page.getByText('Send not confirmed: Report delivery failed', { exact: true }).waitFor();
  assert.equal(await page.locator('#input').inputValue(), 'Keep this draft');
  await page.unroute('**/messages?async=1');
  let received = '';
  const busyStarted = gate(), busyRelease = gate();
  let busyAborted = false;
  faux.setResponses([async (_ctx, options) => {
    options?.signal?.addEventListener('abort', () => { busyAborted = true; }, { once: true });
    busyStarted.resolve(); await Promise.race([busyRelease.promise, new Promise<void>(r => options?.signal?.addEventListener('abort', () => r(), { once: true }))]); return fauxAssistantMessage('Busy task finished');
  }, ctx => { received = JSON.stringify(ctx.messages); return fauxAssistantMessage('Review received'); }]);
  await send('Work before receiving review'); await busyStarted.promise;
  await page.locator('#input').fill('Keep this draft');
  await review.getByRole('button', { name: 'Send to agent', exact: true }).click();
  await review.getByRole('button', { name: 'Sent to agent', exact: true }).waitFor();
  assert.equal(received, '', 'review waits for the active turn');
  assert.equal(busyAborted, false, 'send review must not interrupt the active turn');
  busyRelease.resolve();
  await page.getByText('Review received', { exact: true }).waitFor();
  assert.ok(received.includes('REVIEW_FINDING: Missing coverage for cancellation.'));
  assert.equal(await page.locator('#input').inputValue(), 'Keep this draft');
  // A reload can expose the action again, but its stable request ID must not append twice.
  const before = (await conv.context(context)).messages.filter(m => m.role === 'user' && JSON.stringify(m.content).includes('REVIEW_FINDING')).length;
  assert.equal(before, 1);
  await page.reload();
  await review.getByRole('button', { name: 'Send to agent', exact: true }).click();
  await review.getByRole('button', { name: 'Sent to agent', exact: true }).waitFor();
  assert.equal((await conv.context(context)).messages.filter(m => m.role === 'user' && JSON.stringify(m.content).includes('REVIEW_FINDING')).length, 1);
  assert.deepEqual(errors, []);
  console.log("SIDE_COMMANDS_UI_OK: busy dispatch, separate results, escaped text, inline authenticated media, reconnect, late receipt race, chronological reports, explicit idempotent review delivery, retry, draft preservation, busy queue");
} finally {
  mainRelease.resolve(); btwRelease.resolve(); bgRelease.resolve();
  await browser?.close(); await new Promise<void>(r => server.close(() => r())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
