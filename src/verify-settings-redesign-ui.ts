// Full settings redesign test suite: full width at 1920 & 1440 vs shell, all 7 sections (general, models, context, images, tools, automation, system),
// image settings saved/reloaded, structured profile entry creation + rename + boolean + remove, optional auxiliary enable/remove,
// all thinking values (off, minimal, low, medium, high, xhigh, max), custom model IDs, secret masks, 375px + landscape no horizontal overflow,
// keyboard Arrow navigation changes AND focuses selected tab, sticky save accessible on long forms, contextual manager links.
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
import { sections as settingsSections } from "../web/src/pages/settings/catalog.js";

const mappedKeys = settingsSections.flatMap(section => [...section.keys]);
assert.equal(new Set(mappedKeys).size, mappedKeys.length, "Each setting has exactly one section");
assert.deepEqual([...mappedKeys].sort(), Object.keys(ConfigSchema.toJSONSchema().properties!).sort(), "Every schema setting is mapped");

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");
const dir = mkdtempSync(join(tmpdir(), "luna-settings-redesign-"));
const path = join(dir, "config.json");
const raw = {
  dataDir: join(dir, "data"),
  provider: "faux",
  model: "main",
  thinkingLevel: "medium",
  subagents: { thinkingLevel: "low", provider: "faux", model: "child" },
  providers: [],
  extensions: ["delegate", "cron", "memory", "skills"],
  mcpServers: [{ name: "primary", transport: "http", url: "http://localhost/mcp", enabled: false, headers: { Authorization: "secret-token-redesign" } }],
  web: { searchProvider: "disabled", extractProvider: "disabled" },
  vision: { image_mode: "native", profiles: { default: { tool_result_images: true } } },
  auxiliary: {}
};
writeFileSync(path, JSON.stringify(raw));

const faux = fauxProvider({ models: [{ id: "main" }, { id: "child" }] });
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: "faux", modelId: "main" };
const rt = await startRuntime({ ...parseConfig(raw, dir, {}), configPath: path }, { models, model });
const app = createApp({ harness: rt.harness, settings: rt.settings, models: rt.models, providers: rt.providers, memory: rt.memory, skillDirs: rt.skillDirs, mcp: rt.mcp, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));

let browser: any;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"]
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.setDefaultTimeout(12000);
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("dialog", (d: any) => d.accept());

  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.goto(base);
  await page.locator("#token").fill("test");
  await page.locator("#loginForm button").click();
  await page.locator("#login").waitFor({ state: "hidden" });

  const openSettingsTab = async (tabName: string) => {
    await page.locator('[data-panel="settings"]').click();
    const tabEl = page.locator(`[data-settings-tab="${tabName}"]`);
    await tabEl.waitFor();
    await tabEl.click();
    await page.locator(".settings-body").waitFor({ state: "attached" }); await expandAll();
  };

  const field = (p: string) => page.locator(`[data-setting="${p}"]`);
  const expandAll = async () => {
    await page.locator(".settings-body details").evaluateAll((items: any[]) => items.forEach(d => d.open = true));
  };

  // 1. Verify 1920px & 1440px full-width shell vs available container layout
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openSettingsTab("general");
  const shellBox1920 = await page.locator("#settings-screen").boundingBox();
  assert.ok(shellBox1920 && shellBox1920.width > 1200, "Full width shell should scale wide on 1920 viewport");

  await page.setViewportSize({ width: 1440, height: 900 });
  const shellBox1440 = await page.locator("#settings-screen").boundingBox();
  assert.ok(shellBox1440 && shellBox1440.width > 1000, "Full width shell should scale appropriately on 1440 viewport");

  // 2. Verify all 7 sections (general, models, context, images, tools, automation, system)
  const sections = ["general", "models", "context", "images", "tools", "automation", "system"];
  for (const s of sections) {
    await openSettingsTab(s);
    await page.locator(`[data-settings-tab="${s}"]`).waitFor();
    assert.equal(await page.locator(`[data-settings-tab="${s}"]`).getAttribute("aria-selected"), "true");
  }

  // Live model writes refresh the Settings revision, and pending writes block navigation.
  await openSettingsTab("models");
  await page.locator('[data-settings-view="providers"]').click();
  const manager = page.locator("#settings-management");
  await manager.locator('[data-manager-form="provider-default"] > summary').click();
  await manager.getByRole("combobox", { name: "Model", exact: true }).selectOption("faux/child");
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let requested!: () => void;
  const writeRequested = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/v1/models/default", async (route: any) => {
    requested(); await writeGate; await route.continue();
  });
  await manager.getByRole("button", { name: "Save", exact: true }).click();
  await writeRequested;
  assert.equal(await page.locator("[data-settings-save]").isDisabled(), true);
  assert.equal(await page.locator('[data-settings-tab="general"]').isDisabled(), true);
  assert.equal(await page.locator('[data-settings-view="configuration"]').isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Back to chat", exact: true }).isDisabled(), true);
  await page.evaluate(() => { (globalThis as any).location.hash = "settings/context"; });
  await page.waitForURL("**/#settings/models");
  assert.equal(await page.locator('[data-settings-view="providers"]').getAttribute("aria-selected"), "true", "A hash change cannot unmount a pending live write");
  releaseWrite();
  await page.waitForFunction(() => (globalThis as any).document.querySelector('[aria-label="Main default model"]')?.value === 'faux/child');
  await page.locator('[data-settings-view="configuration"]').click(); await expandAll();
  assert.equal(await page.getByRole("combobox", { name: "Main default model", exact: true }).inputValue(), "faux/child", "Live write reloads the draft");
  await page.locator("[data-settings-save]").click();
  await page.getByText("Settings saved. Compaction changes apply now. New sessions and subagents use the new defaults.", { exact: true }).waitFor();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).model, "child", "Settings Save cannot revert the live write");
  await page.unroute("**/v1/models/default");

  // OAuth keeps its inline view mounted until completion or cancellation.
  await page.locator('[data-settings-view="providers"]').click();
  const loginState = { id: "inline-login", providerId: "anthropic", status: "running", events: [] };
  await page.route("**/v1/providers/anthropic/login", (route: any) => route.fulfill({ json: loginState }));
  await page.route("**/v1/logins/inline-login", (route: any) => route.fulfill({ json: route.request().method() === "DELETE" ? { ok: true } : loginState }));
  const anthropic = manager.locator(".card").filter({ has: page.getByText("Anthropic", { exact: true }) });
  await anthropic.locator(":scope > summary").click();
  await anthropic.getByRole("button", { name: "Sign in with subscription", exact: true }).click();
  await manager.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  assert.equal(await page.locator('[data-settings-view="configuration"]').isDisabled(), true);
  assert.equal(await page.locator('[data-settings-tab="general"]').isDisabled(), true);
  await manager.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator('[data-settings-view="configuration"]').click(); await expandAll();
  await page.unroute("**/v1/providers/anthropic/login");
  await page.unroute("**/v1/logins/inline-login");

  // Unsaved configuration cannot be overwritten by live MCP actions. Failures unlock the form.
  await openSettingsTab("tools");
  await field("web.searchProvider").selectOption("ddgs");
  await page.locator('[data-settings-view="mcp"]').click();
  await manager.locator('[data-manager-form="mcp-add"] > summary').click();
  assert.equal(await manager.getByRole("button", { name: "Connect and save", exact: true }).isDisabled(), true);
  await page.locator('[data-settings-view="configuration"]').click(); await expandAll();
  await field("web.searchProvider").selectOption("disabled");
  await page.locator('[data-settings-view="mcp"]').click();
  await manager.locator('[data-manager-form="mcp-add"] > summary').click();
  await page.route("**/v1/mcp", (route: any) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "Inline MCP failure" } }) : route.continue());
  await manager.getByRole("button", { name: "Connect and save", exact: true }).click();
  await manager.getByText("Inline MCP failure", { exact: true }).waitFor();
  await page.locator('[data-settings-view="configuration"]').click(); await expandAll();
  assert.equal(await field("web.searchProvider").inputValue(), "disabled");
  await page.unroute("**/v1/mcp");

  // 3. Verify Thinking values: off, minimal, low, medium, high, xhigh, max
  await openSettingsTab("models");
  const thinkingSelect = field("thinkingLevel");
  await thinkingSelect.waitFor();
  const options = await thinkingSelect.locator("option").evaluateAll((opts: any[]) => opts.map(o => o.value));
  for (const val of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.ok(options.includes(val), `Thinking level should support ${val}`);
  }
  await thinkingSelect.selectOption("max");
  await field("subagents.thinkingLevel").selectOption("xhigh");

  // 4. Verify Custom Model IDs and provider management (custom provider add shows restart status)
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await expandAll();
  await field("providers.0.id").fill("custom-prov");
  await field("providers.0.name").fill("Custom Provider");
  await field("providers.0.api").selectOption("openai-responses");
  await field("providers.0.baseUrl").fill("http://localhost:11434/v1");
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await expandAll();
  await field("providers.0.models.0.id").fill("custom/deepseek-r1");
  await field("providers.0.models.0.name").fill("DeepSeek R1 Custom");

  // 5. Verify Images settings saved and reloaded, structured profile entry creation + rename + boolean + remove
  await openSettingsTab("images");
  await expandAll();
  await field("vision.image_mode").selectOption("auxiliary");
  await field("vision.history_budget_bytes").fill("131072");
  await field("vision.long_edge").fill("1600");
  await field("vision.max_calls_per_image").fill("2");
  await field("image_gen.provider").selectOption("openai-codex");
  await field("image_gen.openai-codex.quality").selectOption("high");
  assert.equal(await field("image_gen.openai-codex.model").getAttribute("readonly"), "");
  await page.getByRole("button", { name: "Add vision profile", exact: true }).click();
  await expandAll();
  const profileKeyBox = page.getByRole("textbox", { name: "Vision profiles key", exact: true }).last();
  await profileKeyBox.fill("expert");
  await profileKeyBox.press("Tab");
  const toolResultCheckbox = field("vision.profiles.expert.tool_result_images");
  await toolResultCheckbox.check();

  // 6. Optional auxiliary enable/remove (auxiliary.side_question)
  await openSettingsTab("models");
  await expandAll();
  await page.getByRole("button", { name: "Set Side questions", exact: true }).click();
  await expandAll();
  await field("auxiliary.side_question.provider").fill("faux");
  await field("auxiliary.side_question.model").fill("main");

  // 7. Secret masks & header security
  await openSettingsTab("tools");
  await expandAll();
  const secretHeader = field("mcpServers.0.headers.Authorization");
  assert.equal(await secretHeader.getAttribute("type"), "password");
  assert.equal(await secretHeader.inputValue(), "<secret: unchanged>");
  assert.ok(!(await page.locator(".settings-body").textContent()).includes("secret-token-redesign"));

  // 8. Management tabs are grouped by task; existing full pages keep their links.
  await openSettingsTab("models");
  const modelManagerLink = page.locator('#settings-screen [data-settings-view="providers"]');
  assert.ok(await modelManagerLink.isVisible(), "Provider accounts tab should be present in Models section");

  await openSettingsTab("context");
  const memoryManagerLink = page.locator('#settings-screen [data-settings-view="memory"]');
  assert.ok(await memoryManagerLink.isVisible(), "Saved memory tab should be present in Context section");

  await openSettingsTab("tools");
  const mcpManagerLink = page.locator('#settings-screen [data-settings-view="mcp"]');
  assert.ok(await mcpManagerLink.isVisible(), "MCP connections tab should be present in Tools section");

  await openSettingsTab("automation");
  const cronManagerLink = page.locator('#settings-screen [data-panel="cron"]');
  assert.ok(await cronManagerLink.isVisible(), "Lessons and cron jobs manager link should be present in Automation section");

  await openSettingsTab("system");
  const analyticsManagerLink = page.locator('#settings-screen [data-panel="analytics"]');
  assert.ok(await analyticsManagerLink.isVisible(), "Analytics manager link should be present in System section");

  // Management content stays inside Settings, even with unsaved configuration edits.
  await openSettingsTab("context");
  await page.locator('[data-settings-view="memory"]').click();
  await page.locator("#settings-management").waitFor();
  assert.equal(await page.locator("#panel").isVisible(), false, "Memory must not open a drawer");
  assert.equal(await page.locator("#settings-screen").isVisible(), true);
  await page.locator('[data-settings-view="configuration"]').click(); await expandAll();
  await openSettingsTab("models");
  assert.equal(await thinkingSelect.inputValue(), "max", "Inline manager navigation keeps settings drafts");
  await page.locator('[data-settings-view="providers"]').click();
  await page.locator('[data-manager-form="provider-default"] > summary').click();
  await page.getByText("Save or reload your settings draft before changing accounts or connections. Your edits are kept.", { exact: true }).waitFor();
  assert.equal(await page.locator("#settings-management").getByRole("button", { name: "Save", exact: true }).isDisabled(), true, "Live model writes cannot overwrite unsaved configuration");
  await page.locator('[data-settings-view="configuration"]').click(); await expandAll();

  // 9. Keyboard Arrow Navigation changes AND focuses selected tab
  await openSettingsTab("general");
  const tabGeneral = page.locator('[data-settings-tab="general"]');
  await tabGeneral.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('[data-settings-tab="models"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('[data-settings-tab="models"]').evaluate((el: any) => el === (globalThis as any).document.activeElement), true);

  // 10. Sticky save accessible on long forms & save execution (restart required status for providers)
  const saveBtn = page.getByRole("button", { name: "Save settings", exact: true });
  await page.locator(".settings-scroll").evaluate((el: any) => { el.scrollTop = el.scrollHeight; });
  const saveBox = await saveBtn.boundingBox();
  assert.ok(saveBox && saveBox.y >= 0 && saveBox.y + saveBox.height <= 900, "Save stays in view without scrolling the page");
  await saveBtn.click();
  await page.getByText("Saved. Restart Luna to apply runtime changes.", { exact: true }).waitFor();

  // Reload and verify persistence
  let disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.thinkingLevel, "max");
  assert.equal(disk.vision.image_mode, "auxiliary");
  assert.equal(disk.vision.profiles.expert.tool_result_images, true);
  assert.equal(disk.auxiliary.side_question.provider, "faux");
  assert.equal(disk.providers[0].id, "custom-prov");
  assert.equal(disk.providers[0].models[0].id, "custom/deepseek-r1");
  assert.equal(disk.subagents.thinkingLevel, "xhigh");
  assert.equal(disk.vision.history_budget_bytes, 131072);
  assert.equal(disk.vision.long_edge, 1600);
  assert.equal(disk.vision.max_calls_per_image, 2);
  assert.equal(disk.image_gen.provider, "openai-codex");
  assert.equal(disk.image_gen["openai-codex"].quality, "high");
  assert.equal(disk.mcpServers[0].headers.Authorization, "secret-token-redesign");
  await page.reload();
  await field("thinkingLevel").waitFor({ state: "attached" });
  await openSettingsTab("images");
  await expandAll();
  assert.equal(await field("vision.image_mode").inputValue(), "auxiliary");
  assert.equal(await field("vision.profiles.expert.tool_result_images").isChecked(), true);
  assert.equal(await field("image_gen.openai-codex.quality").inputValue(), "high");
  const expertKey = page.getByRole("textbox", { name: "Vision profiles key", exact: true }).last();
  await expertKey.fill("faux/main"); await expertKey.press("Tab");
  await field("vision.profiles.faux/main.tool_result_images").uncheck();
  await saveBtn.click();
  await page.getByText("Saved. Restart Luna to apply runtime changes.", { exact: true }).waitFor();
  disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.vision.profiles.expert, undefined);
  assert.equal(disk.vision.profiles["faux/main"].tool_result_images, false);
  await page.getByRole("button", { name: "Remove faux/main", exact: true }).click();
  await openSettingsTab("models"); await expandAll();
  await field("auxiliary.side_question").selectOption("");
  await saveBtn.click();
  await page.getByText("Saved. Restart Luna to apply runtime changes.", { exact: true }).waitFor();
  disk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(disk.vision.profiles["faux/main"], undefined);
  assert.equal(disk.auxiliary.side_question, undefined);
  await page.reload(); await field("thinkingLevel").waitFor({ state: "attached" }); await expandAll(); await field("thinkingLevel").waitFor();
  await page.getByRole("button", { name: "Set Side questions", exact: true }).waitFor();
  // All manager entry points are in their task-related sections, not a Workspace bucket.
  for (const [section, ids] of Object.entries({models: ["providers", "agents"], context: ["memory", "skills"], tools: ["mcp"], automation: ["lessons", "cron"], system: ["analytics"]})) {
    await openSettingsTab(section);
    for (const id of ids) assert.equal(await page.locator(`#settings-screen [${["cron", "analytics"].includes(id) ? "data-panel" : "data-settings-view"}="${id}"]`).isVisible(), true, id);
  }
  assert.equal(await page.locator('[data-settings-tab="workspace"]').count(), 0);

  // All inline views stay in Settings at desktop and phone widths, without a modal/focus trap.
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [sectionId, ids] of Object.entries({ models: ["providers", "agents"], context: ["memory", "skills"], tools: ["mcp"] })) {
      await page.locator(`[data-settings-tab="${sectionId}"]`).click();
      for (const id of ids) {
        await page.locator(`[data-settings-view="${id}"]`).click();
        await page.locator("#settings-management").waitFor();
        await page.locator('#settings-management [role="status"]').filter({ hasText: "Loading…" }).waitFor({ state: "hidden" });
        assert.equal(await page.locator("#settings-management .msg.err").count(), 0, id + " manager loaded");
        assert.equal(await page.locator("#panel").isVisible(), false, id + " has no drawer");
        assert.equal(await page.locator("#settings-management").evaluate((el: any) => el.scrollWidth <= el.clientWidth + 1), true, id + " inline overflow at " + width);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#settings-management").isVisible(), true, "Inline view is not a modal");
        await page.screenshot({ path: `/tmp/luna-settings-inline-${id}-${width}.png` });
      }
    }
  }
  await page.locator('[data-settings-view="configuration"]').focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('[data-settings-view="mcp"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('[data-settings-view="mcp"]').evaluate((el: any) => el === (globalThis as any).document.activeElement), true);

  // 11. Mobile Viewport 375px & landscape no horizontal overflow
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('[data-settings-tab="system"]').click();
  assert.equal(await page.evaluate(() => {
    const doc = (globalThis as any).document;
    return doc.documentElement.scrollWidth <= doc.documentElement.clientWidth;
  }), true);
  assert.equal(await page.locator("#settings-screen").evaluate((el: any) => el.scrollWidth <= el.clientWidth), true);
  // Mobile section navigation scrolls; use the already open page rather than the hidden app sidebar.
  for (const id of sections) {
    await page.locator(`[data-settings-tab="${id}"]`).click();
    await expandAll();
    assert.equal(await page.locator(".settings-content").evaluate((el: any) => el.scrollWidth <= el.clientWidth), true, id + " mobile overflow");
  }
  await page.locator('[data-settings-tab="images"]').click();
  await page.screenshot({ path: "/tmp/luna-settings-redesign-mobile.png" });
  await page.setViewportSize({ width: 812, height: 375 });
  assert.equal(await page.locator("#settings-screen").evaluate((el: any) => el.scrollWidth <= el.clientWidth), true, "landscape overflow");
  await page.getByRole("button", {name: "Save settings", exact: true}).waitFor();

  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettingsTab("general");
  await page.screenshot({ path: "/tmp/luna-settings-redesign-desktop.png" });

  assert.deepEqual(errors, []);
  console.log("SETTINGS_REDESIGN_UI_OK");
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
}
