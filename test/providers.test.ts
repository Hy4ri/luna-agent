import { test, expect } from "bun:test";
import { normalizeBaseUrl } from "../src/providers.js";

test("custom provider base URL accepts a pasted endpoint URL", () => {
  const cases: [string, string][] = [
    ["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
    ["https://api.example.com/v1/chat/completions/", "https://api.example.com/v1"],
    ["https://api.example.com/v1/responses", "https://api.example.com/v1"],
    ["https://api.example.com/v1/messages", "https://api.example.com/v1"],
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["https://api.example.com/v1", "https://api.example.com/v1"],
  ];
  for (const [input, want] of cases) expect(normalizeBaseUrl(input)).toBe(want);
});

import { customProvider, detectModels, reasoningInfo } from "../src/providers.js";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { supportedThinkingLevels } from "../src/thinking.js";
// Recorded public /models response, 2026-11-11; selected entries are unchanged.
import opencodeModels from "./fixtures/opencode-go-models.json" with { type: "json" };

test("OpenCode metadata survives catalog refresh and explicit saved overrides", async () => {
  const fetchImpl = (async () => Response.json(opencodeModels)) as unknown as typeof fetch;
  const models = createModels(); // In-memory credentials: never read production auth.
  models.setProvider(customProvider({
    id: "go", name: "Go", api: "openai-completions", baseUrl: "https://example.test/v1",
    models: [{ id: "deepseek-v4.1-flash" }],
  }, fetchImpl));
  await models.login("go", "api_key", { notify: () => {}, prompt: async () => "none" });
  const refreshed = await models.refresh({ allowNetwork: true, force: true });
  expect(refreshed.errors.size).toBe(0);
  const deepseek = models.getModel("go", "deepseek-v4.1-flash")!;
  expect(deepseek.reasoning).toBe(true);
  expect(deepseek.contextWindow).toBe(1_000_000);
  expect(deepseek.maxTokens).toBe(384_000);
  expect(deepseek.input).toEqual(["text", "image"]);
  expect(supportedThinkingLevels(deepseek)).toEqual(["low", "high", "max"]);
  const gpt = models.getModel("go", "gpt-6-luna")!;
  expect(supportedThinkingLevels(gpt)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  expect(gpt.thinkingLevelMap?.off).toBe("none");
  expect(supportedThinkingLevels(models.getModel("go", "qwen3.8-max"))).toEqual(["off", "low", "medium", "xhigh"]);
  expect(models.getModel("go", "longcat-2.5-free")!.input).toEqual(["text", "image"]);
  for (const id of ["mimo-v2.6-pro", "minimax-m3"]) {
    const model = models.getModel("go", id)!;
    expect(model.reasoning).toBe(true);
    // Reasoning output (even with a toggle) is not evidence of adjustable effort.
    expect(supportedThinkingLevels(model)).toEqual(["off"]);
  }

  models.setProvider(customProvider({
    id: "go", name: "Go", api: "openai-completions", baseUrl: "https://example.test/v1",
    models: [
      { id: "deepseek-v4.1-flash", contextWindow: 200_000, maxTokens: 32_000, reasoning: false, vision: false },
      { id: "gpt-6-luna", thinkingLevelMap: { off: null, low: null, medium: null, high: "high", xhigh: null, max: null, minimal: null } },
    ],
  }, fetchImpl));
  expect((await models.refresh({ allowNetwork: true, force: true })).errors.size).toBe(0);
  const saved = models.getModel("go", "deepseek-v4.1-flash")!;
  expect(saved.contextWindow).toBe(200_000);
  expect(saved.maxTokens).toBe(32_000);
  expect(saved.reasoning).toBe(false);
  expect(saved.input).toEqual(["text"]);
  expect(supportedThinkingLevels(models.getModel("go", "gpt-6-luna"))).toEqual(["high"]);
});

test("structured reasoning does not invent effort values or ignore explicit false", () => {
  expect(reasoningInfo({ capabilities: { reasoning: { supported: false, effort: ["high"] } } })).toEqual({ reasoning: false });
  expect(reasoningInfo({ reasoning: false, capabilities: { reasoning: { supported: true, effort: ["high"] } } })).toEqual({ reasoning: false });
  expect(reasoningInfo({ capabilities: { reasoning: {} } })).toEqual({});
  const info = reasoningInfo({ capabilities: { reasoning: { supported: true, effort: ["low", "unknown"] } } });
  expect(info.thinkingLevelMap?.low).toBe("low");
  expect(info.thinkingLevelMap?.high).toBe(null);
});

test("discovery preserves existing limit and input formats without inferring image output", async () => {
  const data = [
    { id: "router", context_length: 200_000, top_provider: { max_completion_tokens: 32_000 }, architecture: { input_modalities: ["text", "image"] } },
    { id: "vllm", max_model_len: "64000", max_tokens: 8_000, input_modalities: ["text"] },
    { id: "anthropic", max_input_tokens: 100_000, max_output_tokens: 16_000, supports_vision: true },
    { id: "camel", contextWindow: 128_000, maxTokens: 8_000, capabilities: { input: ["image/png"] } },
    { id: "explicit", vision: false, modalities: { input: ["image"] } },
    { id: "output-only", modalities: { input: ["text"], output: ["image/png"] } },
    { id: "wildcard", modalities: { input: ["image/*"] } },
    { id: "unknown", modalities: { output: ["image"] } },
  ];
  const fetchImpl = (async () => Response.json({ data })) as unknown as typeof fetch;
  const defs = await detectModels("https://example.test/v1", undefined, fetchImpl);
  expect(defs).toEqual([
    { id: "router", contextWindow: 200_000, maxTokens: 32_000, vision: true },
    { id: "vllm", contextWindow: 64_000, maxTokens: 8_000, vision: false },
    { id: "anthropic", contextWindow: 100_000, maxTokens: 16_000, vision: true },
    { id: "camel", contextWindow: 128_000, maxTokens: 8_000, vision: true },
    { id: "explicit", vision: false },
    { id: "output-only", vision: false },
    { id: "wildcard", vision: true },
    { id: "unknown" },
  ]);
});

test("reasoning support is read from OpenRouter, Nous, and ZenMux model lists", () => {
  // ZenMux
  expect(reasoningInfo({ id: "openai/gpt-5.2", capabilities: { reasoning: true } })).toEqual({ reasoning: true });
  expect(reasoningInfo({ id: "x", capabilities: { reasoning: false } })).toEqual({ reasoning: false });
  // OpenRouter / Nous: listed efforts only; a mandatory model cannot turn reasoning off.
  expect(reasoningInfo({ id: "a", reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low"] } })).toEqual({
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  });
  expect(reasoningInfo({ id: "b", reasoning: { mandatory: false } })).toEqual({ reasoning: true });
  expect(reasoningInfo({ id: "c", reasoning: null, supported_parameters: ["reasoning", "tools"] })).toEqual({ reasoning: true });
  expect(reasoningInfo({ id: "d", reasoning: null, supported_parameters: ["tools"] })).toEqual({ reasoning: false });
  // Missing metadata stays unknown.
  expect(reasoningInfo({ id: "e" })).toEqual({});
});

test("detected custom models expose their real thinking levels", async () => {
  const body = { data: [
    { id: "anthropic/claude-opus-4.6", context_length: 1_000_000, reasoning: { mandatory: false, supported_efforts: ["max", "high", "medium", "low", "none"] } },
    { id: "openai/gpt-5.2", context_length: 400_000, capabilities: { reasoning: true } },
    { id: "plain/chat", context_length: 128_000, capabilities: { reasoning: false } },
  ] };
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const defs = await detectModels("https://example.test/v1", "k", fetchImpl);
  const provider = customProvider({ id: "gw", name: "gw", api: "openai-completions", baseUrl: "https://example.test/v1", models: defs });
  const levels = Object.fromEntries(provider.getModels().map(m => [m.id, getSupportedThinkingLevels(m)]));
  expect(levels["anthropic/claude-opus-4.6"]).toEqual(["off", "low", "medium", "high", "max"]);
  expect(levels["openai/gpt-5.2"]).toEqual(["off", "minimal", "low", "medium", "high"]);
  expect(levels["plain/chat"]).toEqual(["off"]);
});
