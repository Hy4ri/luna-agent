// Real browser gate: select a machine for a draft session, then explicitly move execution to main.
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
const dir = mkdtempSync(join(tmpdir(), "luna-workers-ui-"));
const faux = fauxProvider(); faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("test reply")));
const models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux", extensions: [] }, dir, {}), { models, model });
const w = rt.workers.store.create("Desktop").worker;
const app = createApp({ harness: rt.harness, conversations: rt.conversations, workers: rt.workers, models: rt.models, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once("listening", r));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator("#more").click();
  await page.getByLabel("Target machine", { exact: true }).selectOption(String(w.id));
  await page.getByLabel("Target working directory").fill("/home/m57/work");
  await page.getByRole("button", { name: "Select execution machine", exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem("luna.session")), null);
  await page.locator("#pclose").click();
  await page.locator("#machine-status").waitFor();
  assert.match(await page.locator("#machine-status").textContent(), /Desktop.*Offline/);
  // Send the first message through the real composer, then read back its execution target.
  const created = page.waitForResponse((r: any) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v1/sessions");
  await page.locator("#input").fill("hello"); await page.locator("#input").press("Enter");
  const id = String((await (await created).json()).id);
  const read = () => page.evaluate(async (sid: string) => (await fetch(`/v1/sessions/${sid}?limit=1`, { headers: { authorization: "Bearer test" } })).json(), id);
  assert.equal((await read()).machine.id, w.id);
  assert.equal((await read()).agent.cwd, "/home/m57/work");
  // Viewing the session did not move it. Transfer is a distinct explicit operation.
  await page.locator("#more").click();
  await page.getByLabel("Target machine", { exact: true }).selectOption("");
  await page.getByLabel("Target working directory").fill(dir);
  await page.getByRole("button", { name: "Move future execution", exact: true }).click();
  await page.waitForFunction(async (sid: string) => {
    const r = await fetch(`/v1/sessions/${sid}/machine`, { headers: { authorization: "Bearer test" } });
    return ((await r.json()) as { machine: unknown }).machine === null;
  }, id);
  assert.equal((await read()).machine, null);
  assert.equal((await read()).agent.cwd, dir);
  await page.locator("#pclose").click();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-settings-tab="tools"]').click();
  await page.locator('[data-settings-view="workers"]').click();
  await page.getByLabel("Machine name", { exact: true }).fill("Second desk");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.locator("#worker-token").waitFor();
  assert.match(await page.locator("#worker-token").textContent(), /LUNA_WORKER_TOKEN=lw_/);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await page.locator("#worker-token").count(), 0);
  page.once("dialog", (d: any) => d.accept());
  await page.getByRole("button", { name: "Remove Second desk", exact: true }).click();
  await page.getByRole("button", { name: "Remove Second desk", exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("WORKERS_UI_OK");
} finally { await browser?.close(); await new Promise<void>(r => server.close(() => r())); await rt.close(); rmSync(dir, { recursive: true, force: true }); }
