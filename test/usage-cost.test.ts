// Contract: a cost total is provider-reported only when every priced part is. A missing flag is an estimate.
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("the session ledger and delegation summary are provider-reported only when every response is", async () => {
  const allReported = await ledgerAfter([true, true]);
  assert.equal(allReported.cost.totalFromProvider, true);
  assert.equal(allReported.delegate.costReported, true);
  assert.equal(allReported.cost.total, 1);

  const mixed = await ledgerAfter([true, false]);
  assert.equal(mixed.cost.totalFromProvider, false, "one catalog estimate makes the whole total an estimate");
  assert.equal(mixed.delegate.costReported, false);

  const lateEstimate = await ledgerAfter([false, true]);
  assert.equal(lateEstimate.cost.totalFromProvider, false);
});

test("a response without a flag is never reported as billed", async () => {
  const unflagged = await ledgerAfter([undefined, undefined]);
  assert.notEqual(unflagged.cost.totalFromProvider, true);
  assert.equal(unflagged.delegate.costReported, false);
  const partlyFlagged = await ledgerAfter([true, undefined]);
  assert.notEqual(partlyFlagged.cost.totalFromProvider, true);
  assert.equal(partlyFlagged.delegate.costReported, false);
});

test("/usage names the cost source", () => {
  const model = (flag?: boolean) => ({ models: { "p/m": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25, ...(flag === undefined ? {} : { totalFromProvider: flag }) } } }, tools: {} });
  assert.match(usageNotice(model(true) as never), /provider-reported cost \$0\.2500/);
  assert.match(usageNotice(model(true) as never), /^(?!.*not an invoice)/s);
  assert.match(usageNotice(model(false) as never), /estimated cost.*not an invoice.*\$0\.2500/s);
  assert.match(usageNotice(model() as never), /estimated cost/);
});
