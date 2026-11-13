// Contract: models without their own price (custom endpoints, OpenCode) take the rates of the priced
// built-in model with the same name. Expected rates are the published per-million prices in the pinned catalog.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { clearOpenRouterPricingForTest, estimatedCost, loadOpenRouterPricingCache, priceKey, refreshOpenRouterPricing } from "../src/model-pricing.js";
import { customProvider, ProviderManager } from "../src/providers.js";
import { listedCost } from "../src/opencode-cli.js";

const dirs: string[] = [];
afterEach(() => {
  clearOpenRouterPricingForTest();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

test("live OpenRouter fallback prices uncatalogued models, caches to disk, and keeps built-in prices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-pricing-"));
  dirs.push(dir);
  const cacheFile = join(dir, "openrouter-pricing.json");
  let fetches = 0;
  const mockFetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({
      data: [
        { id: "google/gemini-4-hydrogen", pricing: { prompt: "0.0000015", completion: "0.0000075", input_cache_read: "0.000000075", input_cache_write: "0.0000000833333333333333" } },
        // Built-in catalog must still win over OpenRouter for known models:
        { id: "anthropic/claude-sonnet-4.6", pricing: { prompt: "0.000099", completion: "0.000099" } },
        // Sentinels and free routes are ignored:
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "vendor/model:free", pricing: { prompt: "0.000001", completion: "0.000002" } },
      ],
    }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  expect(await refreshOpenRouterPricing({ fetchImpl: mockFetch, cacheFile })).toBe(true);
  expect(fetches).toBe(1);
  expect(estimatedCost("gemini-4-hydrogen-medium")).toEqual({ input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0.0833333333333 });
  expect(rates("anthropic/claude-sonnet-4.6")).toEqual([3, 15]);
  expect(estimatedCost("openrouter/auto")).toBe(undefined);
  expect(estimatedCost("vendor/model:free")).toBe(undefined);

  // Within TTL: no second fetch.
  expect(await refreshOpenRouterPricing({ fetchImpl: mockFetch, cacheFile })).toBe(false);
  expect(fetches).toBe(1);

  // Fresh process simulation: disk cache restores prices without network.
  clearOpenRouterPricingForTest();
  expect(estimatedCost("gemini-4-hydrogen-medium")).toBe(undefined);
  expect(loadOpenRouterPricingCache(cacheFile)).toBe(true);
  expect(estimatedCost("gemini-4-hydrogen-medium")?.input).toBe(1.5);

  // ProviderManager.refreshCatalog updates custom provider models when pricing refreshes.
  clearOpenRouterPricingForTest();
  const dir2 = mkdtempSync(join(tmpdir(), "luna-pricing-pm-"));
  dirs.push(dir2);
  const pm = new ProviderManager({
    dataDir: dir2,
    fallbackModel: { provider: "cp", modelId: "gemini-4-hydrogen-medium" },
    fetch: mockFetch,
  });
  await pm.addCustom({ id: "cp", name: "cp", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9/v1", key: "k", models: [{ id: "gemini-4-hydrogen-medium" }] });
  expect(pm.models.getModel("cp", "gemini-4-hydrogen-medium")?.cost.input).toBe(0);
  await pm.refreshCatalog(true);
  expect(pm.models.getModel("cp", "gemini-4-hydrogen-medium")?.cost.input).toBe(1.5);
});

test("OpenRouter fetch failure is best-effort and never throws", async () => {
  const failFetch = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
  expect(await refreshOpenRouterPricing({ fetchImpl: failFetch, force: true })).toBe(false);
});
