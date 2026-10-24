import { defineDoc, defineExtension, defineTool, section, type ConversationId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { AskDoc } from "./ask.js";
import { GoalDoc } from "./goal.js";
import { classifyLimit } from "./limit-reset.js";
import { readProviderLimit, type ProviderLimit } from "./provider-limits.js";

export type SessionStatus = "ready" | "running" | "reviewing" | "review_finished" | "finished" | "needs_approval" | "needs_input" | "limit_reached" | "failed" | "stopped";
export interface SessionState { status: SessionStatus; statusReason: string | null }

/** Tracks when the user last opened (read) this session. */
export const SessionReadDoc = defineDoc<{ at: number | null }>({
  checkpointWhen: () => false,
  kind: "luna.session-read", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ at: null }),
});

/** Record the current wall-clock time as the read timestamp. Call inside a commit that also reads status. */
export async function markSessionRead(tx: Tx, id: ConversationId): Promise<void> {
  const doc = await tx.doc(SessionReadDoc, id);
  doc.at = Date.now();
}
type Handoff = { status: "needs_approval" | "needs_input"; reason: string; boundary: number };
export const SessionHandoffDoc = defineDoc<{ handoff: Handoff | null }>({
  checkpointWhen: () => false,
  kind: "luna.session-handoff", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ handoff: null }),
});

// Review jobs run outside foreground pi tasks. Their document also invalidates session lists.
const reviewOwner = randomUUID();
type ReviewResult = { boundary: number; at: number; status: "complete" | "failed"; reason: string | null };
export const SessionReviewDoc = defineDoc<{
  owner: string | null; active: { id: string; boundary: number; at: number }[]; result: ReviewResult | null;
}>({
  checkpointWhen: () => false,
  kind: "luna.session-review", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ owner: null, active: [], result: null }),
});

export async function startSessionReview(tx: Tx, id: ConversationId, jobId: string, boundary: number): Promise<void> {
  const doc = await tx.doc(SessionReviewDoc, id);
  if (doc.owner !== reviewOwner) { doc.active = []; doc.owner = reviewOwner; }
  doc.active.push({ id: jobId, boundary, at: Date.now() });
}

export async function finishSessionReview(tx: Tx, id: ConversationId, jobId: string, error?: string): Promise<void> {
  const doc = await tx.doc(SessionReviewDoc, id);
  if (doc.owner !== reviewOwner) return;
  const job = doc.active.find(job => job.id === jobId);
  if (!job) return;
  doc.active = doc.active.filter(job => job.id !== jobId);
  doc.result = { boundary: job.boundary, at: Date.now(), status: error === undefined ? "complete" : "failed",
    reason: error === undefined ? null : error.slice(0, 500) };
}

/** Entry IDs, not model timestamps, define the current input or reset boundary. */
async function sessionTail(tx: Tx, id: ConversationId) {
  // The boundary is usually a few entries back. Start small: tool results make entries large to parse.
  let cursor, size = 16;
  let assistant: EntryRecord | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: id, order: "descending" }, size, cursor);
    size = Math.min(size * 4, 200);
    for (const entry of page.items) {
      if (entry.kind === "pi.reset" || entry.kind === "luna.context-start") return { boundary: Number(entry.id), reset: true, assistant };
      if ((entry.kind === "pi.user" || entry.kind === "luna.xsession.msg")) return { boundary: Number(entry.id), reset: false, assistant };
      if (!assistant && entry.kind === "pi.assistant") assistant = entry;
    }
    cursor = page.next;
  } while (cursor);
  return { boundary: 0, reset: false, assistant };
}
export async function newestInputBoundary(tx: Tx, id: ConversationId): Promise<number> {
  return (await sessionTail(tx, id)).boundary;
}
export async function readSessionHandoff(tx: Tx, id: ConversationId): Promise<Handoff | null> {
  const handoff = (await tx.doc(SessionHandoffDoc, id)).handoff;
  return handoff && handoff.boundary === await newestInputBoundary(tx, id) ? JSON.parse(JSON.stringify(handoff)) as Handoff : null;
}

export const SessionStatusExtension = defineExtension({
  name: "session-status",
  sections: [section("session-status", () => "Before returning control to the user because you need permission or information, call session_handoff with needs_approval or needs_input and a short reason. For structured questions, use ask_user_question (purpose: approval for permission). Without ask_user_question (subagents), use session_handoff. A subagent handoff wakes the session that spawned it. These tools only report state; they never grant permission. A normal final answer is marked Finished, not verified task completion.")],
  tools: [defineTool({
    name: "session_handoff",
    description: "Mark that your final response needs human approval or input. Call before the final response, then stop work until the user replies. This records state only: it does not grant approval, abort tools, or verify completion. Use ask_user_question for a structured question instead.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("needs_approval"), Type.Literal("needs_input")]),
      reason: Type.String({ minLength: 1, maxLength: 500, description: "Short reason explaining the permission or information needed." }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const reason = args.reason.trim();
      if (!reason) return { output: [{ type: "text", text: "A nonempty reason is required." }], isError: true };
      await api.commit(async tx => {
        (await tx.doc(SessionHandoffDoc, api.conversationId)).handoff = { status: args.status, reason, boundary: await newestInputBoundary(tx, api.conversationId) };
      }, context);
      return { output: [{ type: "text", text: "Handoff recorded. Return your final response and wait for the user." }] };
    },
  })],
});

// Only failure metadata is inspected. Ordinary response text must never change session state.
function isLimitError(message: string) {
  return classifyLimit(message).kind === "wait" || /\b(?:rate[_ -]?limit(?:ed)?|quota(?:[_ -]exceeded)?|insufficient_quota|usage[_ -]limit|token[_ -](?:budget|limit)|context[_ -](?:window|length|limit)|max(?:imum)?[_ -](?:tokens|context)|too many requests)\b|\b429\b|\b(?:budget|capacity) (?:exceeded|exhausted)|\bcontext.{0,30}(?:exceeded|too (?:large|long))|\bhit your (?:usage )?limit/i.test(message);
}
const state = (status: SessionStatus, statusReason: string | null = null): SessionState => ({ status, statusReason });

export type TurnFailure = {
  boundary: number; generation: number; message: string; failedAt?: number;
  provider?: string; model?: string; limit?: ProviderLimit;
};

/** Inspect failure metadata only, tied to the newest generation and input. */
export async function readTurnFailure(tx: Tx, id: ConversationId): Promise<TurnFailure | undefined> {
  const tail = await sessionTail(tx, id);
  if (tail.reset && !tail.assistant) return undefined;
  const generation = (await tx.scanTasks({ conversationId: id, kind: "pi.generation", background: false, order: "descending" }, 1)).items[0];
  if (!generation || generation.state.status !== "terminal" || tail.assistant?.byTaskId !== generation.id) return undefined;
  const outcome = generation.state.outcome;
  if (outcome.status === "aborted" || outcome.status === "orphaned") return undefined;
  const message = tail.assistant.model?.find(message => message.role === "assistant");
  if (outcome.status !== "failed" && outcome.status !== "faulted" && message?.stopReason !== "error") return undefined;
  const detail = outcome.status === "failed" || outcome.status === "faulted" ? outcome.error.detail : undefined;
  const requested = detail && typeof detail === "object" && !Array.isArray(detail) ? detail.requestModel : undefined;
  const requestModel = requested && typeof requested === "object" && !Array.isArray(requested) &&
    typeof requested.provider === "string" && typeof requested.modelId === "string"
    ? { provider: requested.provider, modelId: requested.modelId } : undefined;
  return {
    boundary: tail.boundary, generation: Number(generation.id), failedAt: generation.endedAt,
    message: outcome.status === "failed" || outcome.status === "faulted" ? outcome.error.message : message?.errorMessage ?? "",
    ...(message?.stopReason === "error" ? { provider: requestModel?.provider ?? message.provider,
      model: requestModel?.modelId ?? message.model, limit: readProviderLimit(message) } : {}),
  };
}

/** True while a foreground task of the conversation is pending, running, waiting or completing. */
export async function isRunning(tx: Tx, id: ConversationId) {
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    if ((await tx.scanTasks({ conversationId: id, status, background: false }, 1)).items.length) return true;
  }
  return false;
}

export async function readSessionStatus(tx: Tx, id: ConversationId, running: boolean): Promise<SessionState> {
  const ask = await tx.doc(AskDoc, id);
  // An accepted answer is no longer actionable, even before the waiting tool consumes it.
  const pending = ask.pending.find(question => !ask.answers[question.callId]);
  if (running && pending) return state(pending.purpose === "approval" ? "needs_approval" : "needs_input", pending.questions[0]?.question ?? "Waiting for your answer.");
  const review = await tx.doc(SessionReviewDoc, id);
  if (review.owner === reviewOwner && review.active.length) return state("reviewing");
  if (running) return state("running");

  const tail = await sessionTail(tx, id);
  if (tail.reset && !tail.assistant) return state("ready");
  const generation = (await tx.scanTasks({ conversationId: id, kind: "pi.generation", background: false, order: "descending" }, 1)).items[0];
  const lastMessageAt = Math.max(tail.assistant?.model?.find(message => message.role === "assistant")?.timestamp ?? 0, generation?.endedAt ?? 0);
  const interrupted = review.owner !== reviewOwner ? review.active.at(-1) : undefined;
  if (interrupted && interrupted.boundary === tail.boundary && interrupted.at >= lastMessageAt)
    return state("failed", "Review interrupted by a daemon restart.");
  const result = review.result;
  if (result && result.boundary === tail.boundary && result.at >= lastMessageAt) {
    if (result.status === "failed") return state("failed", result.reason || "Review failed.");
    const readAt = (await tx.doc(SessionReadDoc, id)).at;
    return state(readAt !== null && readAt >= result.at ? "ready" : "review_finished");
  }
  // Only the foreground generation owns the session outcome. Tool errors and queue edits do not.
  const outcome = generation?.state.outcome;
  const message = tail.assistant?.model?.find(message => message.role === "assistant");
  const providerLimited = tail.assistant?.byTaskId === generation?.id && message?.stopReason === "error" && readProviderLimit(message)?.kind === "wait";
  if (outcome?.status === "aborted") return state("stopped", "Stopped by the user.");
  if (outcome?.status === "failed" || outcome?.status === "faulted") {
    const reason = outcome.error.message;
    return state(providerLimited || isLimitError(reason) ? "limit_reached" : "failed", reason.slice(0, 500));
  }
  if (outcome?.status === "orphaned") return state("failed", outcome.reason.slice(0, 500));

  if (message?.role === "assistant") {
    if (message.stopReason === "aborted") return state("stopped", "The response was stopped.");
    if (message.stopReason === "length") return state("limit_reached", "The response reached the model output limit.");
    if (message.stopReason === "error") return state(providerLimited || isLimitError(message.errorMessage ?? "") ? "limit_reached" : "failed", (message.errorMessage || "The model request failed.").slice(0, 500));
  }

  const goal = (await tx.doc(GoalDoc, id)).goal;
  if (goal && goal.limitInput === tail.boundary && (goal.status === "budget_limited" || goal.status === "paused" && /^run allowance \d+ reached$/.test(goal.statusReason ?? ""))) {
    return state("limit_reached", goal.statusReason ?? "The goal reached its token budget.");
  }
  const handoff = (await tx.doc(SessionHandoffDoc, id)).handoff;
  if (handoff && handoff.boundary === tail.boundary) return state(handoff.status, handoff.reason);
  if (!message) return state("ready");

  // Finished: clear to ready once the user opens the session after the response arrived.
  const readDoc = await tx.doc(SessionReadDoc, id);
  const readAt = readDoc.at;
  if (readAt !== null && readAt >= (message.timestamp ?? 0)) return state("ready");

  return state("finished");
}
