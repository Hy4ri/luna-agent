// Full settings form browser gate. Uses an installed browser and an isolated faux runtime.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ConfigSchema, parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
declare const document: any;
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-settings-ui-"));
const path = join(dir, "config.json");
const raw = { dataDir: join(dir, "data"), provider: "faux", model: "main", providers: [], extensions: ["delegate", "cron", "improve"],
  mcpServers: [{ name: "private", transport: "http", url: "http://localhost/mcp", enabled: false, headers: { Authorization: "secret-test-token" } }] };
writeFileSync(path, JSON.stringify(raw));
const faux = fauxProvider({ models: [{ id: "main" }, { id: "child" }] });
const models = createModels(); models.setProvider(faux.provider);
const model = { provider: "faux", modelId: "main" };
const rt = await startRuntime({ ...parseConfig(raw, dir, {}), configPath: path }, { models, model });
const app = createApp({ harness: rt.harness, settings: rt.settings, models: rt.models, providers: rt.providers, mcp: rt.mcp, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("dialog", (d: any) => d.accept());
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator("#token").fill("test"); await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });
  const open = async () => { await page.locator('[data-panel="settings"]').click(); await page.getByLabel("Main thinking level", { exact: true }).waitFor(); };
  const field = (path: string) => page.locator(`[data-setting="${path}"]`);
  const expand = async () => { await page.locator("#pbody details").evaluateAll((items: any[]) => items.forEach(d => d.open = true)); };
  await open();
  await page.getByLabel("Main thinking level", { exact: true }).selectOption("high");
  await page.getByLabel("Subagent thinking level", { exact: true }).selectOption("low");
  await page.getByLabel("Subagent default model", { exact: true }).selectOption("faux/child");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Settings saved. Compaction changes apply now. New sessions and subagents use the new defaults.", { exact: true }).waitFor();
  let disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.thinkingLevel, "high"); assert.equal(disk.subagents.thinkingLevel, "low"); assert.equal(disk.subagents.model, "child");
  await page.keyboard.press("Escape"); await open();
  assert.equal(await page.getByLabel("Main thinking level", { exact: true }).inputValue(), "high");
  assert.equal(await page.getByLabel("Subagent thinking level", { exact: true }).inputValue(), "low");
  if (process.env.LUNA_UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.LUNA_UI_SCREENSHOTS, "luna-settings-desktop.png") });
  await expand();
  await field("dataDir").fill("./data-next");
  await page.getByLabel("coding", { exact: true }).check();
  await field("cwd").fill("./work"); await field("instructions").fill("Configured from the form");
  await field("subagents.cwd").fill("./children");
  await field("cron.notifyUrl").fill("https://ntfy.sh/test-topic"); await field("cron.runTimeoutMinutes").fill("9.5");
  await field("improve.schedule").fill("0 2 * * *"); await field("improve.allowCommandBenchmarks").check();
  await field("server.host").fill("127.0.0.1"); await field("server.port").fill("9234");
  await page.getByRole("button", { name: "Add skill directory", exact: true }).click(); await expand();
  await field("skillDirs.0").fill("./skills");
  // Every provider/model property has a typed form field, not a JSON-only escape hatch.
  await page.getByRole("button", { name: "Add provider", exact: true }).click(); await expand();
  await field("providers.0.id").fill("local"); await field("providers.0.name").fill("Local");
  await field("providers.0.api").selectOption("openai-responses"); await field("providers.0.baseUrl").fill("http://localhost:9999/v1");
  await page.getByRole("button", { name: "Add model", exact: true }).click(); await expand();
  await field("providers.0.models.0.id").fill("local-model"); await field("providers.0.models.0.name").fill("Local model");
  await field("providers.0.models.0.contextWindow").fill("32000"); await field("providers.0.models.0.maxTokens").fill("4000");
  await field("providers.0.models.0.reasoning").selectOption("true"); await field("providers.0.models.0.vision").selectOption("false");
  await field("mcpServers.0.timeoutMs").fill("12345"); await field("mcpServers.0.defer").selectOption("false");
  assert.ok(!(await page.locator("#pbody").textContent()).includes("secret-test-token"));
  await page.getByRole("button", { name: "Add header", exact: true }).click(); await expand();
  const headerKey = page.getByRole("textbox", { name: "Headers key", exact: true }).last();
  await headerKey.fill("X-Test"); await headerKey.press("Tab");
  await field("mcpServers.0.headers.X-Test").fill("header-value");
  await page.getByRole("button", { name: "Add MCP server", exact: true }).click(); await expand();
  await field("mcpServers.1.transport").selectOption("stdio"); await expand();
  await field("mcpServers.1.name").fill("local-fs"); await field("mcpServers.1.command").fill("node");
  await field("mcpServers.1.enabled").selectOption("false"); await field("mcpServers.1.cwd").fill("./mcp");
  await page.getByRole("button", { name: "Add argument", exact: true }).click(); await expand(); await field("mcpServers.1.args.0").fill("server.js");
  await page.getByRole("button", { name: "Add environment variable", exact: true }).click(); await expand();
  await field("mcpServers.1.env.VARIABLE_1").fill("env-value");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Saved. Restart Luna to apply runtime changes.", { exact: true }).waitFor();
  disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.dataDir, "./data-next"); assert.ok(disk.extensions.includes("coding"));
  assert.equal(disk.mcpServers[0].headers["X-Test"], "header-value");
  assert.equal(disk.cwd, "./work"); assert.equal(disk.instructions, "Configured from the form"); assert.equal(disk.subagents.cwd, "./children");
  assert.equal(disk.cron.runTimeoutMinutes, 9.5); assert.equal(disk.improve.allowCommandBenchmarks, true); assert.equal(disk.server.port, 9234);
  assert.deepEqual(disk.skillDirs, ["./skills"]); assert.equal(disk.providers[0].models[0].contextWindow, 32000);
  assert.equal(disk.providers[0].models[0].reasoning, true); assert.equal(disk.providers[0].models[0].vision, false);
  assert.equal(disk.mcpServers[0].headers.Authorization, "secret-test-token"); assert.equal(disk.mcpServers[0].timeoutMs, 12345);
  assert.equal(disk.mcpServers[1].transport, "stdio"); assert.deepEqual(disk.mcpServers[1].args, ["server.js"]); assert.equal(disk.mcpServers[1].env.VARIABLE_1, "env-value");
  // Match every schema leaf to a real control, including nested providers, transports, and maps.
  const expected: string[] = [];
  function leaves(schema: any, value: any, path: (string | number)[] = []) {
    const variants = schema.oneOf || schema.anyOf;
    if (variants) { leaves(variants.find((s: any) => s.properties.transport.const === value.transport), value, path); return; }
    if (schema.type === "object") {
      if (schema.properties) for (const [key, s] of Object.entries(schema.properties)) leaves(s, value?.[key], [...path, key]);
      else for (const key of Object.keys(value || {})) expected.push([...path, key].join("."));
    } else if (schema.type === "array" && !schema.items.enum) (value || []).forEach((v: any, i: number) => leaves(schema.items, v, [...path, i]));
    else expected.push(path.join("."));
  }
  leaves(ConfigSchema.toJSONSchema(), disk);
  for (const path of expected) assert.equal(await field(path).count(), 1, `missing form control: ${path}`);
  console.log(`OK ${expected.length} schema-backed setting controls`);
  // Optional values can be removed, and transport changes discard incompatible properties.
  await expand(); await field("subagents.thinkingLevel").selectOption(""); await field("thinkingLevel").selectOption("off");
  await field("cron.runTimeoutMinutes").fill("");
  await field("mcpServers.1.transport").selectOption("sse"); await expand(); await field("mcpServers.1.url").fill("http://localhost/events");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Saved. Restart Luna to apply runtime changes.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-setting="mcpServers.1.url"]')?.value === "http://localhost/events");
  // Wait for the request to finish before checking disk (the restart text was already visible).
  await page.waitForFunction(() => !document.querySelector('[data-settings-save]')?.disabled);
  disk = JSON.parse(readFileSync(path, "utf8")); assert.equal(disk.thinkingLevel, "off"); assert.equal(disk.subagents.thinkingLevel, undefined);
  assert.equal(disk.cron.runTimeoutMinutes, undefined); assert.equal(disk.mcpServers[1].command, undefined);
  // Schema validation does not destroy the draft or the saved file.
  const before = readFileSync(path, "utf8"); await expand(); await field("improve.schedule").fill("invalid cron");
  await page.getByRole("button", { name: "Save settings", exact: true }).click(); await page.getByRole("status").filter({ hasText: "invalid cron" }).waitFor();
  assert.equal(readFileSync(path, "utf8"), before); assert.equal(await field("improve.schedule").inputValue(), "invalid cron");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-setting="improve.schedule"]')?.value === "0 2 * * *"); await expand();
  assert.equal(await field("improve.schedule").inputValue(), "0 2 * * *");
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 }); await expand();
    assert.equal(await page.evaluate(() => { const p = document.getElementById("pbody"); return p.scrollWidth <= p.clientWidth + 1; }), true, `overflow at ${width}`);
    if (width === 390 && process.env.LUNA_UI_SCREENSHOTS) {
      await page.locator("#pbody").evaluate((p: any) => p.scrollTop = 0);
      await page.screenshot({ path: join(process.env.LUNA_UI_SCREENSHOTS, "luna-settings-mobile.png") });
    }
  }
  assert.deepEqual(errors, []);
  console.log("SETTINGS_UI_OK: all field types, independent thinking defaults, persistence, secrets, transport switching, validation, mobile layout");
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
