// Contract: models without their own price (custom endpoints, OpenCode) take the rates of the priced
// built-in model with the same name. Expected rates are the published per-million prices in the pinned catalog.
import { test, expect } from "bun:test";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { estimatedCost, priceKey } from "../src/model-pricing.js";
import { customProvider } from "../src/providers.js";
import { listedCost } from "../src/opencode-cli.js";

const rates = (id: string) => { const c = estimatedCost(id); return c && [c.input, c.output]; };

test("model IDs from proxies and gateways match the built-in model of the same name", () => {
  expect(rates("anthropic/claude-sonnet-4.6")).toEqual([3, 15]);
  expect(rates("claude-opus-4-6-thinking")).toEqual([5, 25]);
  expect(rates("gemini-3.1-flash-lite")).toEqual([0.25, 1.5]);
  expect(rates("openai/gpt-5.2")).toEqual([1.75, 14]);
  expect(priceKey("Anthropic/Claude-Opus-4.6-Thinking-High")).toBe("claude-opus-4-6");
});

test("free, unknown, and unpriced IDs get no estimate", () => {
  expect(estimatedCost("z-ai/glm-4.7-flash-free")).toBe(undefined);
  expect(estimatedCost("opencode/big-pickle")).toBe(undefined);
  expect(estimatedCost("acme/never-heard-of-it")).toBe(undefined);
});

test("an estimate is a copy: changing it never changes the catalog", () => {
  estimatedCost("anthropic/claude-sonnet-4.6")!.input = 999;
  expect(rates("anthropic/claude-sonnet-4.6")).toEqual([3, 15]);
});

test("OpenCode's listed price wins, including an explicit zero", () => {
  expect(listedCost([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(listedCost([{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }])).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(listedCost(undefined)).toBe(undefined);
  expect(listedCost([{ input: "3" }])).toBe(undefined);
});

test("a custom endpoint response is priced at the matched catalog rates", async () => {
  // One streamed chat completion that reports 1M input and 1M output tokens.
  const chunks = [
    { id: "r", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
    { id: "r", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 } },
  ];
  const server = Bun.serve({ port: 0, fetch: () => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }) });
  try {
    const provider = customProvider({ id: "gw", name: "gw", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [{ id: "anthropic/claude-sonnet-4.6" }, { id: "acme/unknown" }] });
    const models = createModels();
    models.setProvider(provider);
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
    const cost = async (id: string) => {
      const model = provider.getModels().find(m => m.id === id)!;
      const message = await models.complete(model, context, { apiKey: "k" });
      expect(message.stopReason).toBe("stop") /* message.errorMessage ?? "" */;
      return message.usage.cost.total;
    };
    expect(await cost("anthropic/claude-sonnet-4.6")).toBe(18); // $3 + $15
    expect(await cost("acme/unknown")).toBe(0);
  } finally {
    server.stop(true);
  }
});
