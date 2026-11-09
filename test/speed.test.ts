import { describe, expect, test } from "bun:test";
import { effectiveSpeed, supportedSpeeds } from "../src/speed.js";

const m = (id: string, provider = "openai", api = "openai-responses") => ({ id, provider, api });

describe("speed tiers", () => {
  test("ultrafast only on gpt-6-astra and gpt-6.1-sol", () => {
    expect(supportedSpeeds(m("gpt-6.1-sol"))).toEqual(["fast", "ultrafast"]);
    expect(supportedSpeeds(m("gpt-6-astra", "openai-codex", "openai-codex-responses"))).toEqual(["fast", "ultrafast"]);
    expect(supportedSpeeds(m("gpt-5.5"))).toEqual(["fast"]);
  });
  test("non-OpenAI models have no speeds", () => {
    expect(supportedSpeeds(m("claude-opus-5", "anthropic", "anthropic-messages"))).toEqual([]);
    expect(supportedSpeeds(m("gpt-5.5", "openrouter", "openai-completions"))).toEqual([]);
    expect(supportedSpeeds(undefined)).toEqual([]);
  });
  test("ultrafast falls back to fast; unsupported runs standard", () => {
    expect(effectiveSpeed(m("gpt-5.5"), "ultrafast")).toBe("fast");
    expect(effectiveSpeed(m("gpt-6.1-sol"), "ultrafast")).toBe("ultrafast");
    expect(effectiveSpeed(m("x", "anthropic", "anthropic-messages"), "fast")).toBeUndefined();
    expect(effectiveSpeed(m("gpt-5.5"), null)).toBeUndefined();
  });
});
