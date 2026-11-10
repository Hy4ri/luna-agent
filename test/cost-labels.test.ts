// Contract: stock pi-durable sums cost exactly but keeps only the first response's provider flag,
// so Luna labels every ledger total as an estimate.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, createModels, createProvider, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { readDelegateUsage } from "../src/delegate-usage.js";
import { usageNotice } from "../src/claude-usage.js";

/** A provider whose responses carry the given cost provenance, in order. `undefined` leaves the flag absent. */
function pricedProvider(flags: (boolean | undefined)[]) {
  let call = 0;
  const reply = (model: { provider: string; id: string; api: string }): AssistantMessage => {
    const flag = flags[call++];
    const cost: Usage["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5, ...(flag === undefined ? {} : { totalFromProvider: flag }) };
    return { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost } };
  };
  const stream = (model: { provider: string; id: string; api: string }) => {
    const events = createAssistantMessageEventStream();
    const message = reply(model);
    queueMicrotask(() => { events.push({ type: "start", partial: { ...message, content: [] } }); events.push({ type: "done", reason: "stop", message }); events.end(message); });
    return events;
  };
  return createProvider({
    id: "priced", name: "Priced", auth: { apiKey: { name: "none", resolve: async () => ({ auth: {}, source: "test" }) } },
    models: [{ id: "m", name: "m", api: "openai-completions", provider: "priced", baseUrl: "", input: ["text"], reasoning: false,
      contextWindow: 100_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    api: { stream, streamSimple: stream } as never,
  });
}

async function ledgerAfter(flags: (boolean | undefined)[]) {
  const models = createModels();
  models.setProvider(pricedProvider(flags));
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "priced", modelId: "m" } } }, context);
    for (let i = 0; i < flags.length; i++) await (await conv.submit({ type: "input", content: `turn ${i}` }, context)).wait(context);
    const usage = await harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(UsageDoc, conv.id))) as { models: Record<string, { cost: Usage["cost"] }> }, context);
    const delegate = await harness.commit(tx => readDelegateUsage(tx, conv.id as ConversationId), context);
    return { cost: usage.models["priced/m"]!.cost, delegate };
  } finally { await harness.close(context); }
}

test("the stock ledger sums cost exactly but keeps the first response's flag", async () => {
  const mixed = await ledgerAfter([true, false]);
  assert.equal(mixed.cost.total, 1);
  assert.equal(mixed.cost.totalFromProvider, true, "stock aggregation does not combine the flag; labels must not trust it");
  assert.equal(mixed.delegate.costUsd, 1);
  assert.equal("costReported" in mixed.delegate, false, "the delegation summary makes no provider claim");
  const late = await ledgerAfter([false, true]);
  assert.equal(late.cost.total, 1);
  assert.equal(late.cost.totalFromProvider, false);
});

test("/usage labels a ledger total as an estimate, even when its flag says provider-reported", () => {
  const model = (flag?: boolean) => ({ models: { "p/m": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25, ...(flag === undefined ? {} : { totalFromProvider: flag }) } } }, tools: {} });
  for (const flag of [true, false, undefined]) {
    const notice = usageNotice(model(flag) as never);
    assert.match(notice, /estimated cost \$0\.2500.*not an invoice/s);
    assert.doesNotMatch(notice, /provider-reported/);
  }
});
