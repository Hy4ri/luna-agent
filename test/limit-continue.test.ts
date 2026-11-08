// Contract: after a usage limit resets, recovery resumes the stored run with Pi's native continue. It adds no
// synthetic user message, uses a stable request ID, and a repeated delivery cannot admit a second run.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { LimitContinuer, readLimitWait } from "../src/limit-continue.js";

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("a reset quota resumes with a native continue, once, without a synthetic user message", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Please try again in 1s." }),
    fauxAssistantMessage([fauxText("recovered")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
  let skew = 0;
  const continuer = new LimitContinuer({
    harness, log: () => {}, defaultModel: () => ref, now: () => Date.now() + skew, graceMs: 0, backoffMs: [1000],
    policy: () => ({ enabled: true, maxWaitHours: 168, maxAttempts: 5 }),
  });
  try {
    await continuer.start();
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const failed = await (await conv.submit({ type: "input", content: "work" }, context)).wait(context);
    assert.equal(failed.status, "unanswered");

    const wait = await until(() => harness.commit(tx => readLimitWait(tx, conv.id as ConversationId), context), "the recovery wait");
    skew = 2 * 86_400_000; // the reset time has passed
    assert.equal(await continuer.fire(Number(conv.id), wait.boundary), true);

    const requestId = `limit-continue-${Number(conv.id)}-${wait.boundary}-${wait.generation}`;
    const continued = await until(async () => {
      const record = await harness.commit(tx => tx.submissionByRequest(conv.id, requestId), context);
      return record?.status === "done" ? record : undefined;
    }, "the continue run");
    assert.equal(continued.type, "continue", "recovery uses the native continue, not an input");
    assert.equal(faux.getPendingResponseCount(), 0, "the second model response was consumed");

    const entries = (await conv.entries({}, 50, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === "pi.user").length, 1, "no synthetic recovery message was added");
    const answer = entries.find(entry => entry.id === continued.answer)?.model?.[0];
    assert.equal(answer?.role === "assistant" && answer.content.some(block => block.type === "text" && block.text === "recovered"), true);

    assert.equal(await continuer.fire(Number(conv.id), wait.boundary), false, "a repeated delivery admits nothing");
    assert.equal(await harness.commit(tx => continuer.recovery(tx, conv.id as ConversationId), context), undefined, "no stale recovery state remains");
  } finally {
    await continuer.close();
    await harness.close(context);
  }
});

test("a continued run that hits the limit again counts as the next attempt in the same chain", async () => {
  const limit = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Please try again in 1s." });
  const faux = fauxProvider();
  faux.setResponses([limit(), limit(), fauxAssistantMessage([fauxText("recovered")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
  let skew = 0;
  const continuer = new LimitContinuer({
    harness, log: () => {}, defaultModel: () => ref, now: () => Date.now() + skew, graceMs: 0, backoffMs: [1000],
    policy: () => ({ enabled: true, maxWaitHours: 10_000, maxAttempts: 5 }),
  });
  try {
    await continuer.start();
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    await (await conv.submit({ type: "input", content: "work" }, context)).wait(context);
    const first = await until(() => harness.commit(tx => readLimitWait(tx, conv.id as ConversationId), context), "the first wait");
    assert.equal(first.attempt, 1);
    skew += 2 * 86_400_000;
    assert.equal(await continuer.fire(Number(conv.id), first.boundary), true);

    // The continued run fails again at the SAME input boundary. It must continue the chain, not start a new one.
    const second = await until(async () => {
      const wait = await harness.commit(tx => readLimitWait(tx, conv.id as ConversationId), context);
      return wait && wait.generation !== first.generation ? wait : undefined;
    }, "the second wait");
    assert.equal(second.boundary, first.boundary, "a continue does not move the input boundary");
    assert.equal(second.attempt, 2, "the second failure is attempt 2 of the same chain");
    assert.equal(second.firstFailedAt, first.firstFailedAt, "the recovery lifetime is not reset");

    skew += 2 * 86_400_000;
    assert.equal(await continuer.fire(Number(conv.id), second.boundary), true);
    await until(async () => {
      const entries = (await conv.entries({}, 50, undefined, context)).items;
      return entries.some(entry => entry.model?.[0]?.role === "assistant" && entry.model[0].stopReason === "stop") ? true : undefined;
    }, "the recovered answer");
    const users = (await conv.entries({}, 50, undefined, context)).items.filter(entry => entry.kind === "pi.user");
    assert.equal(users.length, 1);
  } finally {
    await continuer.close();
    await harness.close(context);
  }
});
