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
const gates = new Map(["LEFT", "RIGHT", "THIRD", "CLOSE"].map(name => [name, { entered: deferred(), release: deferred() }]));
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
  const ids: string[] = [];
  for (const title of ["First session", "Second session", "Third session", "Fourth session"]) {
    const id = String((await request("/v1/sessions", "POST", {})).id); ids.push(id);
    await request(`/v1/sessions/${id}/metadata`, "PATCH", { title });
  }
  const [a, b, c, d] = ids as [string, string, string, string];
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  const tileListFeeds: string[] = [];
  page.on("request", (req: any) => {
    if (new URL(req.url()).pathname === "/v1/events" && req.frame().parentFrame()) tileListFeeds.push(req.url());
  });
  await page.addInitScript(({ id }: { id: string }) => {
    if (globalThis !== (globalThis as any).top || localStorage.getItem("split-test-initialized")) return;
    localStorage.setItem("split-test-initialized", "1");
    localStorage.setItem("luna.token", "split-test");
    sessionStorage.setItem("luna.session", id); localStorage.setItem("luna.session", id);
  }, { id: a });
  const ready = async (scope: any) => {
    await scope.locator("#input").waitFor();
    await scope.waitForFunction(() => !(globalThis as any).document.getElementById("activity")?.textContent?.includes("Reconnecting"));
  };
  const row = (id: string) => page.locator(`[data-session="${id}"] .session-open`);
  const frameElement = (id: string) => page.locator(`iframe[data-tile-session="${id}"]`);
  const frame = async (id: string) => {
    await frameElement(id).waitFor();
    const f = await (await frameElement(id).elementHandle()).contentFrame();
    assert.ok(f); await ready(f); return f;
  };
  const primaryId = () => page.evaluate(() => sessionStorage.getItem("luna.session"));
  const tileCount = () => page.locator("[data-session-tile]:visible").count();
  // Real pointer-driven HTML drag. The target may be a live iframe: the product
  // must place its drop surface above frames, not depend on cross-document bubbling.
  const drag = async (id: string, target = page.locator("#chat-workspace")) => {
    const source = await row(id).boundingBox(), dest = await target.boundingBox();
    assert.ok(source && dest);
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 });
    await page.mouse.move(dest.x + dest.width - 25, dest.y + Math.min(dest.height / 2, 250), { steps: 12 });
    await page.mouse.up();
  };
  const png = { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") };
  await page.goto(url); await ready(page);
  assert.equal(await row(b).getAttribute("draggable"), "true", "Sidebar sessions must be draggable");
  assert.equal(await page.locator("#split-view, #pane-session").count(), 0, "No split toggle or tile picker");
  await drag(b); let right = await frame(b);
  assert.equal(await tileCount(), 2);
  assert.equal(await right.locator("#title").textContent(), "Second session");
  assert.equal(await right.locator("#side, #split-view, #pane-session, #new-session, #more").count(), 0, "Tiles have a title and close control, not navigation/pickers");
  await drag(c, frameElement(b)); let third = await frame(c);
  assert.equal(await tileCount(), 3, "Dropping over an iframe adds the third tile");
  const boxes = await page.locator("[data-session-tile]:visible").evaluateAll((els: any[]) => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, width: r.width }; }));
  assert.equal(boxes.length, 3);
  assert.ok(boxes[1].x >= boxes[0].x + boxes[0].width - 1 && boxes[2].x >= boxes[1].x + boxes[1].width - 1);
  assert.ok(Math.abs(boxes[0].width - boxes[2].width) < 2, "Desktop tiles share the workspace equally");
  // Split controls: hidden until a 1s hover, then swap and resize.
  const split = page.locator(".tile-split").first();
  const xs = () => page.locator("[data-session-tile]:visible").evaluateAll((els: any[]) => els.map(el => ({ id: el.dataset.tileSession || "primary", x: el.getBoundingClientRect().x, w: el.getBoundingClientRect().width })).sort((a: any, b: any) => a.x - b.x));
  const before = await xs();
  const sb = await split.boundingBox(); assert.ok(sb);
  await page.mouse.move(sb.x + 0.5, sb.y + sb.height / 2 + 120);
  await page.waitForTimeout(300); assert.equal(await page.locator(".tile-split-actions").count(), 0, "Controls wait one second");
  await page.waitForSelector(".tile-split-actions", { timeout: 2000 });
  await page.locator('[aria-label="Swap tiles"]').click();
  const swapped = await xs();
  assert.equal(swapped[0].id, before[1].id, "Swap exchanges the two neighbouring tiles"); assert.equal(swapped[1].id, before[0].id);
  const handle = await page.locator(".tile-resize").first().boundingBox(); assert.ok(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, { steps: 6 }); await page.mouse.up();
  const resized = await xs(); assert.ok(resized[0].w > swapped[0].w + 80, "Resize handle widens the left tile");
  assert.equal(await page.locator(".tile-focused").count(), 1, "Exactly one tile has the focus border");
  await page.mouse.move(5, 5);
  await drag(d); assert.equal(await tileCount(), 3, "A fourth session is rejected");
  assert.equal(await frameElement(d).count(), 0); assert.equal(await primaryId(), a);
  await drag(b); await drag(a);
  assert.equal(await tileCount(), 3, "Neither the primary nor a frame can be tiled twice");
  await row(b).click(); assert.equal(await primaryId(), a, "Clicking an already tiled session focuses it without duplicating it");
  await right.waitForFunction(() => (globalThis as any).document.activeElement?.id === "input");
  await page.locator("#open-palette").click();
  await page.locator("#palette-input").fill("Second session");
  await page.locator(`#command-palette [data-command="session:${b}"]`).click();
  await page.locator("#command-palette").waitFor({ state: "hidden" });
  assert.equal(await primaryId(), a, "Palette selection of an existing tile does not duplicate it in the primary view");
  assert.equal(await tileCount(), 3);

  await right.locator("#model").click();
  await right.locator('#model-picker details[data-provider="faux"] summary').click();
  await right.locator('#model-picker [data-model="faux/other"]').click();
  await right.locator("#model-picker").waitFor({ state: "hidden" });
  assert.deepEqual((await request(`/v1/sessions/${b}`)).agent.model, { provider: "faux", modelId: "other" });
  assert.deepEqual((await request(`/v1/sessions/${a}`)).agent.model, model);
  await page.locator("#input").fill("left draft"); await right.locator("#input").fill("right draft"); await third.locator("#input").fill("third draft");
  await page.reload(); await ready(page); right = await frame(b); third = await frame(c);
  assert.equal(await tileCount(), 3);
  assert.equal(await page.locator("#input").inputValue(), "left draft");
  assert.equal(await right.locator("#input").inputValue(), "right draft");
  assert.equal(await third.locator("#input").inputValue(), "third draft", "All three text drafts survive reload");
  await request(`/v1/sessions/${b}/metadata`, "PATCH", { title: "Second renamed" });
  await right.getByText("Second renamed", { exact: true }).waitFor();
  // Persisted tiles must not retain a stale document-local login after the
  // workspace authenticates. No real credentials or external service is used.
  await page.evaluate(() => localStorage.removeItem("luna.token")); await page.reload();
  await page.locator("#login").waitFor();
  assert.equal(await page.locator("iframe[data-tile-session]").count(), 0, "Login owns the workspace; unauthenticated tile documents are not retained");
  await page.locator("#token").fill("split-test"); await page.locator('#loginForm button[type="submit"], #loginForm button').click();
  await page.locator("#login").waitFor({ state: "hidden" }); await ready(page);
  right = await frame(b); third = await frame(c);
  await right.locator("#login").waitFor({ state: "hidden" }); await third.locator("#login").waitFor({ state: "hidden" });
  assert.equal(await right.locator("#title").textContent(), "Second renamed");
  assert.equal(await right.locator("#input").inputValue(), "right draft");
  assert.equal(await third.locator("#input").inputValue(), "third draft");

  for (const [scope, text] of [[page, "LEFT"], [right, "RIGHT"], [third, "THIRD"]] as const) {
    await scope.locator("#input").fill(text); await scope.locator("#send").click();
    await bounded(gates.get(text)!.entered.promise, `${text} model entered`);
  }
  for (const id of [a, b, c]) assert.equal((await request(`/v1/sessions/${id}`)).running, true);
  await right.locator("#stop").click(); await right.locator("#stop").waitFor({ state: "hidden" });
  assert.equal((await request(`/v1/sessions/${b}`)).running, false);
  for (const id of [a, c]) assert.equal((await request(`/v1/sessions/${id}`)).running, true, "Stop affects only its tile");
  gates.get("LEFT")!.release.resolve(); await page.getByText("Reply to LEFT.", { exact: true }).waitFor();
  gates.get("THIRD")!.release.resolve(); await third.getByText("Reply to THIRD.", { exact: true }).waitFor();
  assert.ok(!(await right.locator("#log").textContent()).includes("Reply to LEFT."));
  assert.ok(!(await page.locator("#log").textContent()).includes("THIRD"));
  console.log("OK real sidebar/iframe drops, three-tile limit, duplicates, model ownership, three concurrent runs and independent Stop");

  await right.locator("#input").fill("keep B"); await third.locator("#input").fill("keep C");
  await right.locator("#file").setInputFiles(png); await right.locator("#atts img").waitFor();
  await page.locator('[data-panel="settings"]').click();
  await frameElement(b).waitFor({ state: "hidden" });
  await page.locator("[data-settings-close]").click();
  assert.equal(await right.locator("#atts img").count(), 1, "Workspace navigation retains attachments");
  await page.locator("#close-tile").click();
  assert.equal(await tileCount(), 2);
  await page.locator("#main").waitFor({ state: "hidden" });
  assert.equal(await right.locator("#atts img").count(), 1, "Closing primary leaves surviving documents and drafts untouched");
  assert.equal(await third.locator("#input").inputValue(), "keep C");
  await row(b).click(); assert.equal(await primaryId(), null); assert.equal(await tileCount(), 2);
  await right.locator("#close-tile").click(); await frameElement(b).waitFor({ state: "detached" });
  assert.equal((await request(`/v1/sessions/${b}`)).id, Number(b), "X removes a tile, not the session");
  // One session left: tiling ends and it becomes the normal single view.
  await frameElement(c).waitFor({ state: "detached" });
  assert.equal(await tileCount(), 1); assert.equal(await primaryId(), c, "A lone surviving tile is promoted to the normal view");
  assert.equal(await page.locator("#input").inputValue(), "keep C");
  await row(b).click(); await ready(page);
  assert.equal(await page.locator("#input").inputValue(), "keep B", "Draft follows a session from a removed frame into the native view");
  await page.locator("#input").fill("B moved between documents");
  await row(a).click(); await ready(page);
  await drag(c); await drag(b, frameElement(c)); right = await frame(b); third = await frame(c);
  assert.equal(await right.locator("#input").inputValue(), "B moved between documents", "A retiled session reads its current draft, not a stale document snapshot");
  assert.equal(await tileCount(), 3);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBoxes = await page.locator("[data-session-tile]:visible").evaluateAll((els: any[]) => els.map(el => { const r = el.getBoundingClientRect(); return { y: r.y, bottom: r.bottom }; }));
  assert.ok(mobileBoxes[1].y >= mobileBoxes[0].bottom - 1 && mobileBoxes[2].y >= mobileBoxes[1].bottom - 1, "Narrow screens stack all three sessions");
  assert.ok(mobileBoxes[2].bottom <= 845);
  for (const scope of [page, right, third]) assert.equal(await scope.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true);
  await page.screenshot({ path: "/tmp/luna-session-tiles-mobile.png" });
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.screenshot({ path: "/tmp/luna-session-tiles.png" });
  // Internal navigation in a tile goes through the workspace, never into a duplicate document.
  await third.evaluate((id: string) => (globalThis as any).openSession(id), b);
  await right.waitForFunction(() => (globalThis as any).document.activeElement?.id === "input");
  assert.equal(await third.locator("#title").textContent(), "Third session");
  assert.equal(await tileCount(), 3);
  await request(`/v1/sessions/${c}`, "DELETE"); await frameElement(c).waitFor({ state: "detached" });
  assert.equal(await tileCount(), 2, "Live deletion removes its tile instead of leaving an empty frame");
  await right.locator("#input").fill("CLOSE"); await right.locator("#send").click();
  await bounded(gates.get("CLOSE")!.entered.promise, "close model entered");
  await page.locator("#close-tile").click();
  await frameElement(b).waitFor({ state: "detached" });
  assert.equal(await primaryId(), b, "Closing one of two tiles returns the other to the normal view");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#menu").click(); await page.locator("#side").waitFor({ state: "visible" });
  await page.locator("#side-close").click();
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.locator("#close-tile").click();
  await page.locator("#welcome").waitFor(); assert.equal(await tileCount(), 1, "Closing the final session restores the blank chat view");
  assert.equal((await request(`/v1/sessions/${b}`)).running, true, "Removing a tile does not stop its run");
  await request(`/v1/sessions/${b}/abort`, "POST");
  await drag(d); await ready(page);
  assert.equal(await primaryId(), d); assert.equal(await page.locator("iframe[data-tile-session]").count(), 0, "A blank view opens the dropped session without an empty tile");
  // Text from files or external drags must not become tile state.
  await page.locator("#chat-workspace").dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => { const dt = new (globalThis as any).DataTransfer(); dt.setData("text/plain", "99999"); return dt; }) });
  assert.equal(await primaryId(), d); assert.equal(await tileCount(), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(tileListFeeds, [], "Only the workspace owns the list SSE; three tiles cannot exhaust HTTP/1 connection slots");

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
  console.log("SPLIT_VIEW_UI_OK: sidebar drag-and-drop, maximum three unique sessions, independent controls, per-tile close, persistence, deletion, responsive layout and cross-origin protection");
} finally {
  for (const gate of gates.values()) gate.release.resolve();
  await browser?.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  await rt.close(); rmSync(dir, { recursive: true, force: true });
}
