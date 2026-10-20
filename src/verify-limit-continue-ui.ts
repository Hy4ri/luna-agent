// Browser verification: a real limit failure through the full runtime shows the scheduled resume time; Cancel removes it.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
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
const dir = mkdtempSync(join(tmpdir(), "luna-limit-continue-ui-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux", autoContinue: { enabled: true } }, dir, {}), { models, model, log: () => {} });
const app = createApp({ harness: rt.harness, models, conversations: rt.conversations, limitContinuer: rt.limitContinuer, agent: { model }, token: "test" });
const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
const detail = async () => (await (await app.request(`/v1/sessions/${conv.id}`, { headers: { authorization: "Bearer test" } })).json()) as any;
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "UTC" });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript((id: string) => { localStorage.setItem("luna.token", "test"); localStorage.setItem("luna.session", id); }, String(conv.id));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);

  // Reset two hours ahead, on the hour, named in UTC like the Claude subscription message.
  const reset = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 3_600_000) * 3_600_000);
  const h = reset.getUTCHours(), clock = `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: `You've hit your session limit · resets ${clock} (UTC)` })]);
  await page.locator("#input").fill("Please work"); await page.locator("#send").click();
  await conv.waitForIdle(context);
  await page.locator('#session-status[data-status="limit_reached"]').waitFor();
  const label = await page.locator("#limit-wait").innerText();
  const expected = new Date(reset.getTime() + 60_000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  assert.match(label, new RegExp(`Resumes .*${expected.replace(/\s/g, "\\s")}`), label);
  assert.equal((await detail()).resumeAt, reset.getTime() + 60_000, "reset plus one minute of grace");
  console.log(`OK header shows "${label.replace(/\s+/g, " ").trim()}" for a real limit failure`);

  if (process.env.LUNA_SHOT) await page.locator("#top").screenshot({ path: process.env.LUNA_SHOT });
  await page.locator("#cancel-limit-wait").click();
  await page.locator("#limit-wait").waitFor({ state: "hidden" });
  assert.equal((await detail()).resumeAt, null);
  await page.reload(); await page.locator('#session-status[data-status="limit_reached"]').waitFor();
  assert.equal(await page.locator("#limit-wait").count(), 0);
  console.log("OK Cancel removes the scheduled continuation and it stays removed after reload");

  assert.deepEqual(errors, []);
  console.log("LIMIT_CONTINUE_UI_OK");
} finally {
  await browser?.close();
  server.close();
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
}
