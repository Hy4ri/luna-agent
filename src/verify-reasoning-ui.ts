// Browser regression gate: production composer, native slider, and real session persistence.
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
const { chromium } = createRequire(import.meta.url)(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-reasoning-"));
const models = createModels(); models.setProvider(fauxProvider({ models: [{ id: "main", reasoning: true }] }).provider);
const model = { provider: "faux", modelId: "main" };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models: rt.models, agent: { model, thinkingLevel: "medium" }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator("#model").click();
  await page.locator('#model-picker details summary').click();
  await page.locator('#model-picker [data-model="faux/main"]').click();
  await page.locator("#model-picker").waitFor({ state: "hidden" });
  // The empty picker no longer creates a session. Seed an existing session for persistence checks.
  const created = await (await app.request("/v1/sessions", { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ model, thinkingLevel: "off" }) })).json() as { id: number };
  await page.evaluate((id: number) => (globalThis as any).openSession(String(id)), created.id);
  await page.waitForFunction(() => !!localStorage.getItem("luna.session"));
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  const readAgent = async (id: number) => (await (await app.request(`/v1/sessions/${id}`, { headers })).json() as any).agent;
  assert.equal((await readAgent(created.id)).thinkingLevel, "off", "Explicit off overrides the server default");
  const inherited = await (await app.request("/v1/sessions", { method: "POST", headers, body: "{}" })).json() as { id: number };
  assert.equal((await readAgent(inherited.id)).thinkingLevel, "medium", "Omitted reasoning retains the server default");
  const invalid = await app.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({ thinkingLevel: "invalid" }) });
  assert.equal(invalid.status, 400);
  const sid = await page.evaluate(() => localStorage.getItem("luna.session"));
  assert.ok(sid);
  const trigger = page.locator("#think"), picker = page.locator("#reasoning-picker"), slider = page.locator("#reasoning-slider");
  const open = async () => { await trigger.click(); await picker.waitFor({ state: "visible" }); };
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const state = async () => (await (await app.request(`/v1/sessions/${sid}`, { headers: { authorization: "Bearer test" } })).json() as any).agent.thinkingLevel;
  const waitState = async (level: string) => {
    for (let i = 0; i < 100; i++) { if (await state() === level) return; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(await state(), level);
  };
  await open(); await slider.focus(); await page.keyboard.press("Home");
  const colors = new Set<string>();
  for (let i = 0; i < levels.length; i++) {
    if (i) { await page.keyboard.press("ArrowRight"); await waitState(levels[i]!); }
    const label = levels[i]![0]!.toUpperCase() + levels[i]!.slice(1);
    assert.equal(await slider.inputValue(), String(i));
    assert.equal(await slider.getAttribute("aria-valuetext"), label);
    assert.equal(await trigger.getAttribute("aria-label"), `Reasoning level: ${label}`);
    assert.equal(await trigger.locator('[data-active="true"]').count(), i + 1);
    colors.add(await trigger.evaluate((el: any) => (globalThis as any).getComputedStyle(el).color));
  }
  assert.equal(colors.size, 7, "Each reasoning level has a distinct color");
  await page.keyboard.press("Escape"); await picker.waitFor({ state: "hidden" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await trigger.evaluate((el: any) => (globalThis as any).document.activeElement === el), true);
  await page.reload(); await trigger.waitFor();
  await page.waitForFunction(`document.querySelector("#think")?.getAttribute("aria-label") === "Reasoning level: Max"`);
  await open(); assert.equal(await slider.inputValue(), "6");
  await slider.focus(); await page.keyboard.press("Home"); await waitState("off");
  await page.keyboard.press("Escape");
  // A pointer change uses the same session API, with no submit or additional button.
  await open();
  const box = await slider.boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitState("medium");
  await page.locator("#title").click(); await picker.waitFor({ state: "hidden" });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 }); await open();
    const bounds = await picker.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height < 844);
    assert.ok((await trigger.boundingBox())!.width >= 32);
    if (width === 390) await page.screenshot({ path: "/tmp/luna-reasoning-mobile.png" });
    await page.keyboard.press("Escape");
  }
  await open(); await page.screenshot({ path: "/tmp/luna-reasoning-desktop.png" });
  assert.deepEqual(errors, []);
  console.log("REASONING_UI_OK: seven levels, colors, ticks, keyboard, pointer, persistence, dismissal, mobile bounds");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
