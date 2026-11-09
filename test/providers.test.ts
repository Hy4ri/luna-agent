import { test } from "bun:test";
import assert from "node:assert/strict";
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
  for (const [input, want] of cases) assert.equal(normalizeBaseUrl(input), want);
});

import { customProvider, detectModels, reasoningInfo } from "../src/providers.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

test("reasoning support is read from OpenRouter, Nous, and ZenMux model lists", () => {
  // ZenMux
  assert.deepEqual(reasoningInfo({ id: "openai/gpt-5.2", capabilities: { reasoning: true } }), { reasoning: true });
  assert.deepEqual(reasoningInfo({ id: "x", capabilities: { reasoning: false } }), { reasoning: false });
  // OpenRouter / Nous: listed efforts only; a mandatory model cannot turn reasoning off.
  assert.deepEqual(reasoningInfo({ id: "a", reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low"] } }), {
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  });
  assert.deepEqual(reasoningInfo({ id: "b", reasoning: { mandatory: false } }), { reasoning: true });
  assert.deepEqual(reasoningInfo({ id: "c", reasoning: null, supported_parameters: ["reasoning", "tools"] }), { reasoning: true });
  assert.deepEqual(reasoningInfo({ id: "d", reasoning: null, supported_parameters: ["tools"] }), { reasoning: false });
  // Missing metadata stays unknown.
  assert.deepEqual(reasoningInfo({ id: "e" }), {});
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
  assert.deepEqual(levels["anthropic/claude-opus-4.6"], ["off", "low", "medium", "high", "max"]);
  assert.deepEqual(levels["openai/gpt-5.2"], ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(levels["plain/chat"], ["off"]);
});
