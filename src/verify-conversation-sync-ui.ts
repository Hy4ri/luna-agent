// Two independent browser contexts are two devices. Gates keep real server runs active until explicitly released.
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
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-sync-ui-"));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
const gates = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
for (const name of ["ALPHA", "BETA", "STOP-A", "STOP-B", "RESUME"]) gates.set(name, { entered: deferred(), release: deferred() });
const faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
faux.setResponses(Array(100).fill(async (ctx: any, opts: any) => {
  const last = [...ctx.messages].reverse().find(m => m.role === "user");
  const text = typeof last?.content === "string" ? last.content : last?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") || "empty";
  const gate = gates.get(text);
  if (gate) {
    gate.entered.resolve();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("test generation aborted"), { name: "AbortError" }));
      if (opts?.signal?.aborted) return abort();
      opts?.signal?.addEventListener("abort", abort, { once: true });
      gate.release.promise.then(() => { opts?.signal?.removeEventListener("abort", abort); resolve(); });
    });
  }
  return fauxAssistantMessage(text === "ALPHA" || text === "RESUME" ? `${text} partial reply. ` + "streaming continues. ".repeat(20) + `${text} complete.` : `Reply to ${text}.`);
}));
const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models, agent: { model }, conversations: rt.conversations, token: "test" });
const headers = { authorization: "Bearer test", "content-type": "application/json" };
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let browser: any;
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Timeout: " + label)), 12000); promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); }); });
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--disable-gpu"] });
  const device1 = await browser.newContext(), device2 = await browser.newContext();
  const one = await device1.newPage(), two = await device2.newPage();
  const errors: string[] = []; for (const p of [one, two]) p.on("pageerror", (e: Error) => errors.push(e.message));
  const ready = async (p: any) => { await p.waitForFunction(() => !(globalThis as any).document.getElementById("send").disabled); };
  const login = async (p: any) => { await p.goto(url); await p.locator("#token").fill("test"); await p.locator("#loginForm button").click(); await p.locator("#login").waitFor({ state: "hidden" }); await ready(p); };
  const row = (p: any, id: number) => p.locator(`[data-session="${id}"]`);
  const selected = (p: any): Promise<number> => p.evaluate(() => Number((globalThis as any).localStorage.getItem("luna.session")));
  const create = async (p: any) => { const old = await selected(p); await p.locator("#new").click(); await p.waitForFunction((previous: number) => Number((globalThis as any).localStorage.getItem("luna.session")) !== previous, old); await ready(p); return selected(p); };
  const choose = async (p: any, id: number) => { await row(p, id).locator(".session-open").click(); await ready(p); };
  const send = async (p: any, text: string) => { await ready(p); await p.locator("#input").fill(text); await p.locator("#send").click(); };
  const idle = async (p: any) => { await p.waitForFunction(() => (globalThis as any).document.getElementById("status").textContent === "Ready"); };
  const state = async (id: number) => (await (await app.request(`/v1/sessions/${id}?limit=500`, { headers })).json()) as any;
  const mutate = (id: number, changes: object) => app.request(`/v1/sessions/${id}/metadata`, { method: "PATCH", headers, body: JSON.stringify(changes) });
  await login(one); await login(two);
  const a = await create(one); await send(one, "ALPHA"); await bounded(gates.get("ALPHA")!.entered.promise, "ALPHA entered");
  await row(two, a).waitFor(); // Live list discovery, without a reload.
  const b = await create(one); await send(one, "BETA"); await bounded(gates.get("BETA")!.entered.promise, "BETA entered");
  assert.equal((await state(a)).running, true); assert.equal((await state(b)).running, true);
  const runningIcon = row(one, a).locator('[data-running][aria-label="Running"][title="Running"]');
  await runningIcon.waitFor();
  assert.equal((await runningIcon.textContent()).trim(), "", "running state must be icon-only");
  assert.equal(await runningIcon.locator("svg").count(), 1);
  assert.equal(await one.locator("#log").getByText("ALPHA", { exact: true }).count(), 0);
  gates.get("BETA")!.release.resolve(); await one.getByText("Reply to BETA.", { exact: true }).waitFor(); await idle(one);
  // Attach the other device before the first run produces any answer, then receive its partial in real time.
  await choose(two, a); await two.locator(".user").getByText("ALPHA", { exact: true }).waitFor();
  assert.equal(await two.locator("#stop").isDisabled(), false);
  gates.get("ALPHA")!.release.resolve();
  await two.locator(".assistant").filter({ hasText: "ALPHA partial" }).waitFor();
  assert.equal((await state(a)).running, true, "snapshot must be observed during generation, not after it");
  assert.equal(await one.locator("#log").textContent(), "BETAReply to BETA.");
  await choose(one, a); await one.locator(".assistant").filter({ hasText: "ALPHA partial" }).waitFor();
  await choose(one, b); await idle(two);
  assert.ok(!(await one.locator("#log").textContent()).includes("ALPHA"));
  assert.equal(await two.locator(".assistant").count(), 1); assert.equal(await two.locator(".user").count(), 1);
  // Continue from device two. Device one receives new turns without a page reload or manual history refresh.
  await choose(one, a); await send(two, "from device two");
  await one.getByText("Reply to from device two.", { exact: true }).waitFor(); await idle(two);
  await send(one, "from device one"); await two.getByText("Reply to from device one.", { exact: true }).waitFor(); await idle(one);
  assert.equal(await one.locator(".user").count(), 3); assert.equal(await two.locator(".user").count(), 3);
  console.log("OK independent parallel runs, background output isolation, live second-device attachment and continued turns");

  // Draft text and images belong to the selected session, not to the tab's global composer.
  await one.locator("#input").fill("draft A");
  await one.locator("#file").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") });
  await one.locator("#atts img").waitFor(); await choose(one, b);
  assert.equal(await one.locator("#input").inputValue(), ""); assert.equal(await one.locator("#atts img").count(), 0);
  await one.locator("#input").fill("draft B"); await choose(one, a);
  assert.equal(await one.locator("#input").inputValue(), "draft A"); assert.equal(await one.locator("#atts img").count(), 1);
  assert.equal(await two.locator("#input").inputValue(), "");
  await one.getByRole("button", { name: "Remove attached image 1" }).click(); await one.reload(); await ready(one);
  assert.equal(await one.locator("#input").inputValue(), "draft A");
  // Force offline interruption. Reconnect must fetch durable history, not resubmit a prior turn.
  await device2.setOffline(true); await send(one, "during disconnection"); await idle(one);
  await device2.setOffline(false); await two.getByText("Reply to during disconnection.", { exact: true }).waitFor(); await idle(two);
  assert.equal(await two.locator(".user").count(), 4); assert.equal(await two.locator(".assistant").count(), 4);
  assert.equal(await two.getByText("Reply to during disconnection.", { exact: true }).count(), 1);
  console.log("OK session-local drafts/images, device-local text recovery, offline reconciliation without duplicates");

  // Rehydrate an in-flight partial after reload. A queued follow-up must be processed once, on that same session.
  const resume = await create(one); await send(one, "RESUME"); await bounded(gates.get("RESUME")!.entered.promise, "RESUME entered");
  await choose(two, resume); await send(two, "/queue queued from second device");
  gates.get("RESUME")!.release.resolve(); await two.locator(".assistant").filter({ hasText: "RESUME partial" }).waitFor();
  await two.reload(); await ready(two); await two.locator(".assistant").filter({ hasText: "RESUME partial" }).waitFor();
  await two.getByText("Reply to queued from second device.", { exact: true }).waitFor(); await idle(two);
  assert.equal(await two.locator(".user").count(), 2); assert.equal(await two.locator(".assistant").count(), 2);
  // Stop affects only the selected run.
  const stopA = await create(one); await send(one, "STOP-A"); await bounded(gates.get("STOP-A")!.entered.promise, "STOP-A entered");
  const stopB = await create(one); await send(one, "STOP-B"); await bounded(gates.get("STOP-B")!.entered.promise, "STOP-B entered");
  await one.locator("#stop").click(); await idle(one);
  assert.equal((await state(stopA)).running, true); assert.equal((await state(stopB)).running, false);
  gates.get("STOP-A")!.release.resolve();
  await choose(two, stopA); await two.getByText("Reply to STOP-A.", { exact: true }).waitFor(); await idle(two);
  assert.ok(!(await one.locator("#log").textContent()).includes("Reply to STOP-A"));
  console.log("OK running-partial reload, queued cross-device follow-up, selected-session stop isolation");

  // A response from a request made before a view switch must never select or paint its old conversation.
  const fetched = deferred(), unblock = deferred();
  await one.route(`**/v1/sessions/${a}?limit=500`, async (route: any) => {
    const response = await route.fetch(); fetched.resolve(); await unblock.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  await row(one, a).locator(".session-open").click(); await bounded(fetched.promise, "slow history fetched");
  await choose(one, b); unblock.resolve(); await one.unroute(`**/v1/sessions/${a}?limit=500`);
  assert.equal(await selected(one), b); assert.ok(!(await one.locator("#log").textContent()).includes("ALPHA"));
  // Lose only the response after durable admission; retry must carry the same idempotency key.
  let lost = false;
  await one.route(`**/v1/sessions/${b}/messages?async=1`, async (route: any) => {
    if (!lost) { lost = true; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  await send(one, "receipt lost"); await one.getByRole("button", { name: "Retry send", exact: true }).waitFor();
  await one.getByRole("button", { name: "Retry send", exact: true }).click();
  await one.getByRole("button", { name: "Retry send", exact: true }).waitFor({ state: "hidden" });
  await one.getByText("Reply to receipt lost.", { exact: true }).waitFor(); await idle(one);
  const bState = await state(b);
  assert.equal(bState.entries.filter((e: any) => e.kind === "pi.user" && JSON.stringify(e.model).includes("receipt lost")).length, 1);
  await one.unroute(`**/v1/sessions/${b}/messages?async=1`);
  console.log("OK delayed history fencing and idempotent retry after lost admission receipt");

  // Shared metadata and deletion from another device update an already open viewer automatically.
  const meta = await create(one); await row(two, meta).waitFor(); await choose(two, meta);
  assert.equal((await mutate(meta, { title: "Shared name", pinned: true })).status, 200);
  await row(two, meta).getByRole("button", { name: "Shared name", exact: true }).waitFor();
  assert.equal(await two.locator(".session-row").first().getAttribute("data-session"), String(meta));
  assert.equal((await mutate(meta, { archived: true })).status, 200); await row(two, meta).waitFor({ state: "hidden" });
  await two.locator("#history-view").click(); await row(two, meta).waitFor();
  assert.equal((await mutate(meta, { archived: false })).status, 200); await row(two, meta).waitFor({ state: "hidden" });
  await two.locator("#history-view").click(); await row(two, meta).waitFor();
  assert.equal((await app.request(`/v1/sessions/${meta}`, { method: "DELETE", headers })).status, 200);
  await row(two, meta).waitFor({ state: "hidden" }); await two.locator("#welcome").waitFor();
  assert.equal(await two.locator("#title").textContent(), "New conversation");
  assert.deepEqual(errors, []);
  console.log("CONVERSATION_SYNC_UI_OK: two devices, independent runs, snapshot/delta recovery, ownership fencing, idempotency, live metadata/deletion");
} finally {
  for (const gate of gates.values()) gate.release.resolve();
  await browser?.close(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
