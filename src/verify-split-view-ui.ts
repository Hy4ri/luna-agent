// Real built UI, authenticated HTTP/SSE, and a scratch runtime. No paid model calls.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const { chromium } = createRequire(import.meta.url)(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-split-ui-"));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const gates = new Map(["LEFT", "RIGHT"].map(name => [name, { entered: deferred(), release: deferred() }]));
const faux = fauxProvider({ models: [{ id: "main" }, { id: "other" }] });
faux.setResponses(Array.from({ length: 30 }, () => async (ctx, options) => {
  const last = [...ctx.messages].reverse().find(m => m.role === "user");
  const text = typeof last?.content === "string" ? last.content : "";
  const gate = gates.get(text);
  if (gate) {
    gate.entered.resolve();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("Test generation aborted"), { name: "AbortError" }));
      if (options?.signal?.aborted) return abort();
      options?.signal?.addEventListener("abort", abort, { once: true });
      gate.release.promise.then(() => { options?.signal?.removeEventListener("abort", abort); resolve(); });
    });
  }
  return fauxAssistantMessage(`Reply to ${text}.`);
}));
const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models, agent: { model }, conversations: rt.conversations, token: "split-test" });
const headers = { authorization: "Bearer split-test", "content-type": "application/json" };
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once("listening", r));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const request = async (path: string, method = "GET", body?: unknown) => {
  const response = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json() as Promise<any>;
};
const bounded = <T>(promise: Promise<T>, label: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 12000);
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});
let browser: any;
try {
  const a = String((await request("/v1/sessions", "POST", {})).id);
  const b = String((await request("/v1/sessions", "POST", {})).id);
  await request(`/v1/sessions/${a}/metadata`, "PATCH", { title: "First session" });
  await request(`/v1/sessions/${b}/metadata`, "PATCH", { title: "Second session" });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript(({ id }: { id: string }) => {
    if (globalThis !== (globalThis as any).top || localStorage.getItem("split-test-initialized")) return;
    localStorage.setItem("split-test-initialized", "1");
    localStorage.setItem("luna.token", "split-test");
    sessionStorage.setItem("luna.session", id);
    localStorage.setItem("luna.session", id);
  }, { id: a });
  const ready = async (scope: any) => {
    await scope.locator("#input").waitFor();
    await scope.waitForFunction(() => !(globalThis as any).document.getElementById("activity")?.textContent?.includes("Reconnecting"));
  };
  const secondary = async () => {
    const handle = await page.locator("#secondary-pane").elementHandle();
    const frame = await handle.contentFrame();
    assert.ok(frame, "The second pane has a browsing context");
    await frame.locator("#pane-session").waitFor();
    return frame;
  };
  const primaryId = () => page.evaluate(() => sessionStorage.getItem("luna.session"));
  const choosePrimary = async (id: string) => {
    await page.locator(`[data-session="${id}"] .session-open`).click();
    await ready(page);
    assert.equal(await primaryId(), id);
  };
  await page.goto(url); await ready(page);
  await page.locator("#split-view").click();
  assert.equal(await page.locator("#split-view").getAttribute("aria-pressed"), "true");
  let right = await secondary();
  assert.equal(await right.locator("#side").count(), 0, "One workspace sidebar only");
  assert.equal(await right.locator("#split-view").count(), 0, "No nested splits");
  await right.locator("#pane-session").selectOption(b); await ready(right);
  assert.equal(await primaryId(), a, "Choosing the second session cannot select the first pane");
  assert.equal(await page.locator("#title").textContent(), "First session");
  const leftBox = await page.locator("#main").boundingBox(), rightBox = await page.locator("#secondary-pane").boundingBox();
  assert.ok(leftBox && rightBox && rightBox.x >= leftBox.x + leftBox.width - 1, "Desktop sessions are side by side");
  assert.ok(Math.abs(leftBox!.width - rightBox!.width) < 2, "Panes share the workspace equally");
  await right.locator("#model").click();
  await right.locator('#model-picker details[data-provider="faux"] summary').click();
  await right.locator('#model-picker [data-model="faux/other"]').click();
  await right.locator("#model-picker").waitFor({ state: "hidden" });
  assert.deepEqual((await request(`/v1/sessions/${b}`)).agent.model, { provider: "faux", modelId: "other" });
  assert.deepEqual((await request(`/v1/sessions/${a}`)).agent.model, model, "Model selection writes only to the second session");
  assert.ok(!(await page.locator("#model").textContent()).includes("other"));
  await page.locator("#input").fill("left draft");
  await right.locator("#input").fill("right draft");
  await right.locator("#file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") });
  await right.locator("#atts img").waitFor();
  assert.equal(await page.locator("#atts img").count(), 0, "Attachments stay in their pane");
  await page.locator("#split-view").click(); await page.locator("#secondary-pane").waitFor({ state: "hidden" });
  await page.locator("#split-view").click();
  assert.equal(await right.locator("#input").inputValue(), "right draft");
  assert.equal(await right.locator("#atts img").count(), 1, "Closing/reopening preserves unsent attachments");
  await right.getByRole("button", { name: "Remove attached image 1" }).click();
  await page.reload(); await ready(page); right = await secondary(); await ready(right);
  assert.equal(await primaryId(), a);
  assert.equal(await right.locator("#pane-session").inputValue(), b);
  assert.equal(await page.locator("#input").inputValue(), "left draft");
  assert.equal(await right.locator("#input").inputValue(), "right draft", "Reload preserves both drafts without storage collisions");
  console.log("OK desktop tiling, authenticated secondary selection, independent drafts and attachments, close/reopen and reload");

  // Both panes use real session-specific message, abort, and event routes.
  await page.locator("#input").fill("LEFT"); await page.locator("#send").click();
  await bounded(gates.get("LEFT")!.entered.promise, "left model entered");
  await right.locator("#input").fill("RIGHT"); await right.locator("#send").click();
  await bounded(gates.get("RIGHT")!.entered.promise, "right model entered");
  assert.equal((await request(`/v1/sessions/${a}`)).running, true);
  assert.equal((await request(`/v1/sessions/${b}`)).running, true);
  await right.locator("#stop").click(); await right.locator("#stop").waitFor({ state: "hidden" });
  assert.equal((await request(`/v1/sessions/${a}`)).running, true, "Stopping right does not stop left");
  assert.equal((await request(`/v1/sessions/${b}`)).running, false);
  gates.get("LEFT")!.release.resolve();
  await page.getByText("Reply to LEFT.", { exact: true }).waitFor();
  assert.ok(!(await right.locator("#log").textContent()).includes("Reply to LEFT."));
  assert.ok(!(await page.locator("#log").textContent()).includes("RIGHT"));
  console.log("OK two concurrent real runtime runs, session-specific sends, streamed delivery and independent Stop");

  await right.locator("#pane-session").selectOption(a); await ready(right);
  await right.locator("#input").fill("secondary same-session draft");
  await page.locator("#input").fill("primary same-session draft");
  await choosePrimary(b);
  assert.equal(await right.locator("#pane-session").inputValue(), a, "Sidebar selection affects only the primary pane");
  await page.reload(); await ready(page); right = await secondary(); await ready(right);
  assert.equal(await primaryId(), b);
  assert.equal(await right.locator("#input").inputValue(), "secondary same-session draft");
  await choosePrimary(a);
  assert.equal(await page.locator("#input").inputValue(), "primary same-session draft", "Even matching session IDs cannot overwrite pane-local drafts");
  await right.locator("#new-session").click();
  await right.waitForFunction((old: string) => (globalThis as any).document.getElementById("pane-session")?.value !== old, a);
  await ready(right);
  const created = await right.locator("#pane-session").inputValue(); assert.ok(created);
  assert.notEqual(created, a); assert.notEqual(created, b); assert.equal(await primaryId(), a);
  await request(`/v1/sessions/${created}`, "DELETE");
  await right.waitForFunction(() => (globalThis as any).document.getElementById("pane-session")?.value === "");
  await right.locator("#welcome").waitFor();
  assert.equal(await right.locator("#pane-session").inputValue(), "");
  assert.equal(await primaryId(), a, "Deleting the second session cannot clear the primary pane");

  // Full-page workspace navigation must not discard or retarget the second pane.
  await right.locator("#pane-session").selectOption(b); await ready(right);
  await right.locator("#input").fill("keep while in settings");
  await page.locator('[data-panel="settings"]').click();
  await page.locator("#secondary-pane").waitFor({ state: "hidden" });
  await page.locator("[data-settings-close]").click();
  await page.locator("#secondary-pane").waitFor({ state: "visible" });
  assert.equal(await right.locator("#input").inputValue(), "keep while in settings");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLeft = await page.locator("#main").boundingBox(), mobileRight = await page.locator("#secondary-pane").boundingBox();
  assert.ok(mobileLeft && mobileRight && mobileRight.y >= mobileLeft.y + mobileLeft.height - 1, "Narrow screens stack the sessions");
  assert.ok(mobileRight!.y + mobileRight!.height <= 845, "Both panes fit the visible viewport");
  assert.equal(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true);
  assert.equal(await right.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true);
  await right.locator("#input").fill("mobile right");
  assert.equal(await page.locator("#input").inputValue(), "primary same-session draft");
  await page.screenshot({ path: "/tmp/luna-split-view-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: process.env.SPLIT_SCREENSHOT || "/tmp/luna-split-view.png" });
  assert.deepEqual(errors, []);

  // The pane exception must not permit clickjacking from another origin.
  const external = serve({ fetch: () => new Response(`<iframe src="${url}/?pane=session"></iframe>`, { headers: { "content-type": "text/html" } }), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>(r => external.listening ? r() : external.once("listening", r));
  const outsider = await browser.newPage();
  try {
    const denied = outsider.waitForEvent("console", { predicate: (m: any) => m.type() === "error" && m.text().includes("frame-ancestors") });
    await outsider.goto(`http://127.0.0.1:${(external.address() as { port: number }).port}`);
    await bounded(denied, "cross-origin frame rejected by browser");
    assert.equal(await outsider.frameLocator("iframe").locator("#app").count(), 0, "Cross-origin framing cannot render the application");
  } finally {
    await outsider.close();
    if ("closeAllConnections" in external) external.closeAllConnections();
    await new Promise<void>(r => external.close(() => r()));
  }
  console.log("SPLIT_VIEW_UI_OK: independent session lifecycles, pane-local storage, live deletion, workspace navigation, responsive layout and cross-origin frame protection");
} finally {
  for (const gate of gates.values()) gate.release.resolve();
  await browser?.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  await rt.close(); rmSync(dir, { recursive: true, force: true });
}
