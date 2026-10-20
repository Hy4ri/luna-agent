// Lessons review inbox in a real browser: groups, diff, evidence pointers, approve/reject, mobile width, no page errors.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");

const dir = mkdtempSync(join(tmpdir(), "luna-learn-ui-"));
const skill = join(dir, "data", "skills", "deploy", "SKILL.md");
mkdirSync(join(dir, "data", "skills", "deploy"), { recursive: true });
const v0 = "---\nname: deploy\ndescription: Use when deploying services.\n---\nBuild, then deploy with the deploy script.\n";
const v1 = "---\nname: deploy\ndescription: Use when deploying services.\n---\nDeploy to staging first, verify, then production.\nBuild, then deploy with the deploy script.\n";
writeFileSync(skill, v0);
const faux = fauxProvider({ models: [{ id: "main" }] }); const models = createModels(); models.setProvider(faux.provider);
const model = { provider: "faux", modelId: "main" };
const rt = await startRuntime(parseConfig({ dataDir: join(dir, "data"), provider: "faux", model: "main", providers: [], extensions: ["improve", "learn"] }, dir, {}), { models, model });
const L = rt.learn!;
const turn = (text: string) => [{ entry: 1, role: "assistant" as const, text: "", ts: Date.now(), calls: [] }, { entry: 2, role: "user" as const, text, ts: Date.now(), calls: [] }];
const sig = (conv: number, text: string) => L.ingest(conv, turn(text), 2);
const proposed = L.record({ claim: "Deploy to staging before production.", cause: "missing", skill: "deploy", signal_ids: [...sig(11, "No, staging first."), ...sig(12, "Wrong, staging first please.")] });
await L.propose(rt.improver!, { lesson_id: proposed.id, content: v1, must_contain: ["staging first"] });
const guard = L.record({ claim: "Never push to main.", cause: "ignored", skill: "deploy", signal_ids: [...sig(13, "No, don't push to main."), ...sig(14, "Stop, wrong branch.")] });
const weak = L.record({ claim: "Check the file path first.", cause: "missing", signal_ids: sig(15, "No, that's the wrong file.") });
sig(16, "No, the other one.");

const app = createApp({ harness: rt.harness, models: rt.models, agent: { model }, token: "test", memory: rt.memory, learn: { store: L, improver: rt.improver!, scan: rt.learnScan } });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.listening ? r() : server.once("listening", r));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.goto(base); await page.locator("#token").fill("test"); await page.locator("#loginForm button").click(); await page.locator("#login").waitFor({ state: "hidden" });
  await page.locator('[data-panel="settings"]').click();
  await page.locator('[data-settings-tab="automation"]').click();
  await page.locator('#settings-screen [data-settings-view="lessons"]').click();
  const card = (id: number) => page.locator(`[data-lesson="${id}"]`);
  await card(proposed.id).waitFor();
  assert.equal(await page.locator('[data-group="review"] [data-lesson]').count(), 1);
  assert.equal(await page.locator(`[data-group="guard"] [data-lesson="${guard.id}"]`).count(), 1);
  assert.equal(await page.locator(`[data-group="evidence"] [data-lesson="${weak.id}"]`).count(), 1);
  assert.match(await page.textContent("body"), /1 signal waiting for the daily pass/);
  const diffText = await card(proposed.id).locator(".lesson-diff").textContent();
  assert.match(diffText, /\+ Deploy to staging first, verify, then production\./);
  assert.match(await card(proposed.id).textContent(), /must contain "staging first"/);
  await card(proposed.id).getByRole("button", { name: "Evidence (2)" }).click();
  assert.match(await card(proposed.id).locator(".evidence").textContent(), /session 11 · message 2[\s\S]*session 12 · message 2/);
  await page.screenshot({ path: process.env.LEARN_UI_SHOT || join(dir, "lessons.png"), fullPage: true });

  await card(proposed.id).getByRole("button", { name: "Approve" }).click();
  await page.locator(`[data-group="watch"] [data-lesson="${proposed.id}"]`).waitFor();
  assert.equal(readFileSync(skill, "utf8"), v1, "approve applied the skill");
  assert.equal(await card(proposed.id).getByRole("button", { name: "Roll back" }).count(), 1);

  page.once("dialog", (d: any) => d.accept("not a real rule"));
  await card(weak.id).getByRole("button", { name: "Dismiss" }).click();
  await page.getByRole("button", { name: /Show rejected and retired \(1\)/ }).click();
  assert.match(await card(weak.id).textContent(), /rejected[\s\S]*not a real rule/);
  assert.equal(L.lesson(weak.id)!.status, "rejected");

  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal overflow at 360px");
  if (process.env.LEARN_UI_SHOT) await page.screenshot({ path: process.env.LEARN_UI_SHOT.replace(/\.png$/, "-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("LEARN_UI_OK: groups, diff, regression phrases, evidence pointers, approve applies, dismiss remembers reason, 360px, no page errors");
} finally {
  await browser?.close(); await new Promise<void>((r) => server.close(() => r())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
