// Real durable lifecycle transitions with a deterministic provider; no external model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationHandle } from "@earendil-works/pi-durable";
import { createModels, context, openLuna } from "./luna.js";
import { createApp } from "./server.js";
import { createAskExtension } from "./ask.js";
import { createGoalExtension, GoalDoc } from "./goal.js";

const dir = mkdtempSync(join(tmpdir(), "luna-session-status-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
let harnessRef: Awaited<ReturnType<typeof openLuna>> | undefined;
const open = () => openLuna({ dbPath: join(dir, "test.db"), models, memory: false, coding: false,
  extensions: [createAskExtension({ pollMs: 10 }), createGoalExtension({ harness: () => harnessRef })] });
let harness = await open(); harnessRef = harness;
let app = createApp({ harness, agent: { model } });
const read = async (id: number) => {
  const res = await app.request(`/v1/sessions/${id}`); assert.equal(res.status, 200); return await res.json() as any;
};
const check = async (id: number, status: string) => {
  const detail = await read(id); assert.equal(detail.status, status, JSON.stringify({ status: detail.status, reason: detail.statusReason, goal: detail.goal }));
  const list = await (await app.request("/v1/sessions")).json() as any;
  const row = list.sessions.find((row: any) => row.id === id);
  // After a detail GET that returns "finished", the mark-read commit has already fired,
  // so the list may immediately show "ready". Both are correct — assert accordingly.
  const expectedListStatus = status === "finished" ? ["finished", "ready"] : [status];
  assert.ok(expectedListStatus.includes(row.status), `list status ${row.status} not in [${expectedListStatus}]`);
  return detail;
};
async function until<T>(fn: () => Promise<T>, accepts: (value: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < end);
  throw new Error("Session status deadline exceeded");
}
const create = () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
const send = async (conv: ConversationHandle, content = "Work on the request") => {
  const res = await app.request(`/v1/sessions/${conv.id}/messages?async=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  assert.equal(res.status, 202); return res.json();
};
const idle = (conv: ConversationHandle) => conv.waitForIdle(context);
const handoff = (status: "needs_input" | "needs_approval", reason: string) => [
  fauxAssistantMessage([fauxToolCall("session_handoff", { status, reason })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Please answer before I continue."),
];
let release: (() => void) | undefined;
try {
  const conv = await create();
  assert.equal((await check(conv.id, "ready")).statusReason, null);
  let entered!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("Quota exceeded and approval needed are example text, not status events."); }]);
  await send(conv); await started;
  assert.equal((await check(conv.id, "running")).running, true);
  release!(); await idle(conv); await check(conv.id, "finished");
  await check(conv.id, "ready"); // second GET marks read; list should now show ready
  console.log("OK ready -> running -> finished -> read -> ready; prose does not create attention or limit states");

  faux.setResponses(handoff("needs_approval", "Permission to merge PR #42"));
  await send(conv); await idle(conv);
  assert.equal((await check(conv.id, "needs_approval")).statusReason, "Permission to merge PR #42");
  // A real reopen proves that attention is durable, not transient web state.
  const persistedId = conv.id;
  await harness.close(context); harness = await open(); harnessRef = harness; app = createApp({ harness, agent: { model } });
  await check(persistedId, "needs_approval");
  const resumed = (await harness.conversation(persistedId, context))!;
  faux.setResponses([fauxAssistantMessage("New request completed.")]);
  await send(resumed, "Do not merge. Explain the code instead."); await idle(resumed); await check(persistedId, "finished");
  faux.setResponses(handoff("needs_input", "Which directory should I use?"));
  await send(resumed); await idle(resumed); await check(persistedId, "needs_input");
  await app.request(`/v1/sessions/${persistedId}/reset`, { method: "POST" }); await check(persistedId, "ready");
  console.log("OK explicit handoffs persist across reopen; new input/reset invalidate them");

  const questions = [{ header: "Target", question: "Which target?", options: [{ label: "Local", description: "Use local target" }, { label: "Remote", description: "Use remote target" }] }];
  for (const purpose of ["input", "approval"] as const) {
    const ask = await create();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask_user_question", { purpose, questions })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Answer received."),
    ]);
    await send(ask);
    const waiting = await until(() => read(ask.id), value => value.status === (purpose === "approval" ? "needs_approval" : "needs_input"));
    assert.equal(waiting.running, true, "human wait remains busy for mutation guards");
    if (purpose === "input") {
      const response = await app.request(`/v1/sessions/${ask.id}/questions/${waiting.questions[0].callId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [{ questionIndex: 0, kind: "option", answer: "Local" }], cancelled: false }) });
      assert.equal(response.status, 200);
      assert.notEqual((await read(ask.id)).status, "needs_input", "accepted answer no longer needs attention");
      await idle(ask); await check(ask.id, "finished");
    } else {
      assert.equal((await app.request(`/v1/sessions/${ask.id}/abort`, { method: "POST" })).status, 200);
      await idle(ask); await check(ask.id, "stopped");
      faux.setResponses([fauxAssistantMessage("Recovered.")]);
      await send(ask); await idle(ask); await check(ask.id, "finished");
    }
  }
  console.log("OK input/approval questionnaires, accepted answers, stop and recovery");

  const failed = await create();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid API key" })]);
  await send(failed); await idle(failed); await check(failed.id, "failed");
  faux.setResponses([fauxAssistantMessage("A truncated reply", { stopReason: "length" })]);
  await send(failed); await idle(failed); await check(failed.id, "limit_reached");
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Account quota exhausted" })]);
  await send(failed); await idle(failed); await check(failed.id, "limit_reached");
  await app.request(`/v1/sessions/${failed.id}/reset`, { method: "POST" }); await check(failed.id, "ready");
  console.log("OK model failure, output and quota limits, reset after failure");

  const goal = await create();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Finish the requested task", audit: false, max_runs: 1 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("First turn."), fauxAssistantMessage("Continuation."),
  ]);
  await send(goal); await idle(goal);
  assert.match((await check(goal.id, "limit_reached")).statusReason, /run allowance 1 reached/);
  faux.setResponses([fauxAssistantMessage("A separate manual response.")]);
  await send(goal); await idle(goal); await check(goal.id, "finished");
  const budget = await create();
  const costed = fauxAssistantMessage("Budget exhausted."); costed.usage.totalTokens = 100;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Stay within budget", audit: false, token_budget: 1 })], { stopReason: "toolUse" }), costed, fauxAssistantMessage("Budget check on the next yield."),
  ]);
  await send(budget); await idle(budget); await check(budget.id, "limit_reached");
  const permission = await create();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Wait for permission", audit: false, max_runs: 3 })], { stopReason: "toolUse" }),
    ...handoff("needs_approval", "Approve the next step"),
  ]);
  await send(permission); await idle(permission); await check(permission.id, "needs_approval");
  assert.equal((await harness.snapshot(GoalDoc, permission.id, context))!.goal!.runs, 0, "goals must not auto-continue past a human handoff");
  console.log("OK goal run/token limits; manual input clears stale limit; human handoff prevents automatic continuation");

  // Long tool histories cannot hide an input boundary or stale status after the next turn.
  await resumed.commit(async tx => { for (let i = 0; i < 225; i++) await tx.appendEntry(resumed.id, { kind: "test.bookkeeping" }); }, context);
  await check(resumed.id, "ready");
  faux.setResponses(handoff("needs_input", "Pick a file")); await send(resumed); await idle(resumed);
  await resumed.commit(async tx => { for (let i = 0; i < 225; i++) await tx.appendEntry(resumed.id, { kind: "test.bookkeeping" }); }, context);
  await check(resumed.id, "needs_input");
  console.log("SESSION_STATUS_OK");
} finally {
  release?.();
  await harness.close(context);
  rmSync(dir, { recursive: true, force: true });
}
