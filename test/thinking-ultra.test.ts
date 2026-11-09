import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openLuna, context } from "../src/luna.js";
import { clampLevel, requestLevel, resolveThinkingLevel, supportedThinkingLevels, ultraEffort, withUltraModels, ULTRA_SECTION } from "../src/thinking.js";
import { withUltra } from "../src/openai-context.js";
import { reasoningInfo } from "../src/providers.js";

const codex = (id: string) => openaiCodexProvider().getModels().find(m => m.id === id) as Model<Api>;
const openai = (id: string) => openaiProvider().getModels().find(m => m.id === id) as Model<Api>;

test("ultra follows the Codex catalog: listed GPT models get it, others clamp to their highest level", () => {
  assert.equal(ultraEffort(codex("gpt-6-sol")), "max");
  assert.equal(ultraEffort(codex("gpt-6.1-sol")), "xhigh");
  assert.equal(ultraEffort(openai("gpt-5.6-terra")), "max");
  assert.equal(ultraEffort({ ...openai("gpt-5.6-terra"), id: "gpt-5.6-terra-long-context" }), "max");
  // Luna models support max but not ultra.
  assert.equal(ultraEffort(codex("gpt-6-luna")), undefined);
  assert.equal(ultraEffort(openai("gpt-5.2")), undefined);
  assert.deepEqual(supportedThinkingLevels(codex("gpt-6-sol"))?.slice(-2), ["max", "ultra"]);
  assert.ok(!supportedThinkingLevels(codex("gpt-6-luna"))?.includes("ultra"));
  assert.equal(clampLevel(codex("gpt-6-sol"), "ultra"), "ultra");
  assert.equal(clampLevel(codex("gpt-6-luna"), "ultra"), "max");
  assert.equal(clampLevel(openai("gpt-5.2"), "ultra"), "xhigh");
  assert.equal(requestLevel(codex("gpt-6.1-sol"), "ultra"), "xhigh");
  assert.equal(requestLevel(codex("gpt-6.1-sol"), "high"), "high");
  const models = createModels();
  models.setProvider(openaiCodexProvider());
  assert.equal(resolveThinkingLevel(models, { provider: "openai-codex", modelId: "gpt-6-sol" }, { thinkingLevel: "ultra" }), "ultra");
  assert.equal(resolveThinkingLevel(models, { provider: "openai-codex", modelId: "gpt-6-luna" }, { thinkingLevel: "ultra" }), "max");
});

test("catalog metadata enables or disables ultra", () => {
  const base = openai("gpt-6-luna");
  const listed = withUltra(base, { supported_reasoning_levels: [{ effort: "max" }, { effort: "ultra" }], multi_agent_reasoning_effort: "xhigh" });
  assert.equal(ultraEffort(listed), "xhigh");
  const fallback = withUltra(base, { supported_reasoning_levels: [{ effort: "ultra" }], multi_agent_reasoning_effort: null });
  assert.equal(ultraEffort(fallback), "max");
  // A live catalog without ultra overrides the static default.
  assert.equal(ultraEffort(withUltra(openai("gpt-6-sol"), { supported_reasoning_levels: [{ effort: "max" }] })), undefined);
  assert.equal(withUltra(base, {}), base);
  const custom = reasoningInfo({ id: "x", reasoning: { supported_efforts: ["low", "high", "ultra"] } });
  assert.equal(custom.thinkingLevelMap?.ultra, "max");
  assert.equal(ultraEffort({ ...base, ...custom } as Model<Api>), "high");
});

test("an ultra session sends its effort to the provider and adds the proactive delegation section", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-ultra-"));
  const faux = fauxProvider({ models: [{ id: "deep", reasoning: true }] });
  const seen: { reasoning?: string; system: string }[] = [];
  faux.setResponses([(request, options) => {
    seen.push({ reasoning: options?.reasoning, system: JSON.stringify(request) });
    return fauxAssistantMessage("done");
  }]);
  const model = faux.getModel("deep")!;
  model.thinkingLevelMap = { ...model.thinkingLevelMap, ultra: "high" } as Model<Api>["thinkingLevelMap"];
  const base = createModels();
  base.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: withUltraModels(base), memory: false, coding: false });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" },
      agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel: "ultra" as never } }, context);
    await (await conv.submit({ type: "input", content: "go" }, context)).wait(context);
    assert.equal(seen[0]?.reasoning, "high");
    assert.ok(seen[0]?.system.includes("proactive multi-agent delegation is on"));
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(ULTRA_SECTION.includes("subagent"));
});
