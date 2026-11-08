// Contract: Luna projects retained Pi run failures, not previous answers, onto the current input.
// These are valid persisted-state fixtures, not a test of provider execution or Pi's recovery loop.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createRegistry, createSession, Harness, LiveDoc, MemoryStorage,
  type ConversationId, type EntryId, type RunFailureReason, type SubmissionId, type TaskId,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { readCommonSessionReport, readSessionStatus, readTurnFailure, SessionHandoffDoc } from "../src/session-status.js";

async function failureFixture(reason: RunFailureReason, withQuotaAnswer = false) {
  const storage = new MemoryStorage();
  const id = await storage.mintId<ConversationId>();
  const user = await storage.mintId<EntryId>();
  const submission = await storage.mintId<SubmissionId>();
  const task = await storage.mintId<TaskId<JsonValue>>();
  const detail = withQuotaAnswer ? "429 rate limit exceeded" : `Run ended: ${reason}`;
  await commitWrites(storage, [
    { type: "conversation", value: { id } },
    { type: "entry", value: { id: user, conversationId: id, kind: "pi.user", model: [{ role: "user", content: "work", timestamp: 100 }] } },
    { type: "submission", value: { id: submission, conversationId: id, type: "input", requestId: "request", status: "unanswered", entry: user, reason } },
    { type: "task", value: {
      id: task, conversationId: id, kind: "pi.generation", version: 2, input: {}, background: false,
      abortRequested: false, endedAt: 200,
      state: { status: "terminal", outcome: reason === "aborted" ? { status: "aborted" } : {
        status: "failed", error: { message: detail, detail: {
          reason, requestModel: { provider: "selected-provider", modelId: "selected-model" },
        } },
      } },
    } },
  ], context);
  if (withQuotaAnswer) {
    const assistant = await storage.mintId<EntryId>();
    const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: detail, timestamp: 200 });
    message.provider = "transport-provider";
    message.model = "upstream-alias";
    message.diagnostics = [{ type: "luna.usage-limit", timestamp: 200, details: { kind: "wait", windows: [{ id: "quota", resetAt: 10_000 }] } }];
    await commitWrites(storage, [{ type: "entry", value: { id: assistant, conversationId: id, byTaskId: task, kind: "pi.assistant", model: [message] } }], context);
  }
  const session = createSession(storage);
  await session.commit(async tx => {
    Object.assign(await tx.doc(LiveDoc, id), { runFailure: { taskId: task, inputs: [submission], first: user, reason, detail } });
  }, context);
  return { session, id, user, task };
}

test("no-answer run failures have explicit states rather than inheriting a previous answer", async () => {
  for (const [reason, expected] of [
    ["interrupted", "failed"], ["restart_limit", "failed"], ["no_model", "failed"],
    ["turn_limit", "limit_reached"], ["nothing_to_answer", "ready"], ["aborted", "stopped"],
  ] as const) {
    const { session, id } = await failureFixture(reason);
    try {
      const status = await session.commit(tx => readSessionStatus(tx, id, false), context);
      assert.equal(status.status, expected, reason);
      assert.ok(status.statusReason, `${reason} needs an explanation`);
      assert.equal(await session.commit(tx => readTurnFailure(tx, id), context), undefined, "no assistant error is not quota evidence");
    } finally { await session.close(context); }
  }
});

test("a newer input or reset does not inherit a retained run failure", async () => {
  const { session, id } = await failureFixture("interrupted");
  try {
    await session.commit(tx => tx.appendEntry(id, { kind: "pi.user", model: [{ role: "user", content: "new work", timestamp: 300 }] }), context);
    assert.equal((await session.commit(tx => readSessionStatus(tx, id, false), context)).status, "ready");
    await session.commit(tx => tx.appendEntry(id, { kind: "pi.reset", head: "self" }), context);
    assert.deepEqual(await session.commit(tx => readSessionStatus(tx, id, false), context), { status: "ready", statusReason: null });
  } finally { await session.close(context); }
});

test("quota failure uses selected request identity, and a current handoff takes precedence", async () => {
  const { session, id, user, task } = await failureFixture("model_error", true);
  try {
    const failure = await session.commit(tx => readTurnFailure(tx, id), context);
    assert.ok(failure);
    assert.equal(failure.generation, task);
    assert.equal(failure.provider, "selected-provider");
    assert.equal(failure.model, "selected-model");
    assert.equal(failure.limit?.kind, "wait");
    assert.equal((await session.commit(tx => readSessionStatus(tx, id, false), context)).status, "limit_reached");
    await session.commit(async tx => {
      (await tx.doc(SessionHandoffDoc, id)).handoff = { status: "needs_approval", reason: "Confirm the next action", boundary: user };
    }, context);
    assert.equal((await session.commit(tx => readSessionStatus(tx, id, false), context)).status, "needs_approval");
    const { report } = await session.commit(tx => readCommonSessionReport(tx, id, ["request"]), context);
    assert.equal(report.state, "needs_approval");
    assert.equal(report.reason, "Confirm the next action");
  } finally { await session.close(context); }
});

test("a run that reaches maxTurns ends unanswered and the session shows limit reached", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("never reached")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  try {
    const model = faux.getModel();
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, maxTurns: 1 } }, context);
    const settled = await (await conv.submit({ type: "input", content: "use a tool" }, context)).wait(context);
    assert.equal(settled.status, "unanswered");
    assert.equal(settled.reason, "turn_limit");
    const status = await harness.commit(tx => readSessionStatus(tx, conv.id, false), context);
    assert.equal(status.status, "limit_reached");
    assert.equal(faux.getPendingResponseCount(), 1, "the second model request was never sent");
  } finally { await harness.close(context); }
});
