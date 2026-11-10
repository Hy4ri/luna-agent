import { defineDoc, defineExtension, defineTool, LiveDoc, section, type ConversationId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { AnalyticsWaitDoc, closeOpenSessionStatusWaits, startWait } from "./analytics/waits.js";
import { AskDoc } from "./ask.js";
import { GoalDoc } from "./goal-doc.js";
import { classifyLimit } from "./limit-reset.js";
import { readProviderLimit, type ProviderLimit } from "./provider-limits.js";
import { StringEnum } from "./string-enum.js";

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
const reviewOwner = crypto.randomUUID();
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
      if ((entry.kind === "pi.user" || entry.kind === "luna.scheduled-message" || entry.kind === "luna.xsession.msg" || entry.kind === "luna.xsession.approved")) return { boundary: Number(entry.id), reset: false, assistant };
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
  sections: [section("session-status", () => "Before returning control to the user because you need permission or information, call session_status with needs_approval or needs_input and a short reason. For structured questions, use ask_user_question (purpose: approval for permission). Without ask_user_question (subagents), use session_status. A subagent handoff wakes the session that spawned it. These tools only report state; they never grant permission. A normal final answer is marked Finished, not verified task completion.")],
  tools: [defineTool({
    name: "session_status",
    description: "Mark that your final response needs human approval or input. Call before the final response, then stop work until the user replies. This records state only: it does not grant approval, abort tools, or verify completion. Use ask_user_question for a structured question instead.",
    parameters: Type.Object({
      status: StringEnum(["needs_approval", "needs_input"]),
      reason: Type.String({ minLength: 1, maxLength: 500, description: "Short reason explaining the permission or information needed." }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const reason = args.reason.trim();
      if (!reason) return { output: [{ type: "text", text: "A nonempty reason is required." }], isError: true };
      const callId = api.callId;
      const now = Date.now();
      await api.commit(async tx => {
        const wait = await tx.doc(AnalyticsWaitDoc, api.conversationId);
        if (wait.pending[callId] || wait.completed?.[callId]) return;
        (await tx.doc(SessionHandoffDoc, api.conversationId)).handoff = { status: args.status, reason, boundary: await newestInputBoundary(tx, api.conversationId) };
        await closeOpenSessionStatusWaits(tx, api.conversationId, "stopped", now);
        await startWait(tx, api.conversationId, {
          callId,
          kind: "session_status",
          purpose: args.status === "needs_approval" ? "approval" : "input",
          tool: "session_status",
          startedAt: now,
        });
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
  // Entry and task IDs share one monotonic allocator. A failure belongs to the current input only when its run
  // started at or after that input's boundary; a newer input or reset must not inherit it.
  const live = await tx.doc(LiveDoc, id);
  let failure = live.runFailure;
  if (failure && tail.boundary !== 0 && failure.first !== undefined && Number(failure.first) < tail.boundary) failure = undefined;
  const currentGeneration = generation && (Number(generation.id) >= tail.boundary || tail.assistant?.byTaskId === generation.id)
    ? generation : undefined;
  const outcome = currentGeneration?.state.outcome;
  const message = tail.assistant?.model?.find(message => message.role === "assistant");
  const providerLimited = tail.assistant?.byTaskId === currentGeneration?.id && message?.stopReason === "error" && readProviderLimit(message)?.kind === "wait";

  // An explicit Stop outranks an earlier handoff from the same input.
  if (failure?.reason === "aborted" || outcome?.status === "aborted")
    return state("stopped", failure?.detail || "Stopped by the user.");
  const goal = (await tx.doc(GoalDoc, id)).goal;
  if (goal && goal.limitInput === tail.boundary && (goal.status === "budget_limited" || goal.status === "paused" && /^run allowance \d+ reached$/.test(goal.statusReason ?? ""))) {
    return state("limit_reached", goal.statusReason ?? "The goal reached its token budget.");
  }
  const handoff = (await tx.doc(SessionHandoffDoc, id)).handoff;
  if (handoff && handoff.boundary === tail.boundary) return state(handoff.status, handoff.reason);

  if (failure) {
    const { reason, detail } = failure;
    switch (reason) {
      case "model_error": return state(providerLimited || detail && isLimitError(detail) ? "limit_reached" : "failed", detail || "The model request failed.");
      case "turn_limit": return state("limit_reached", detail ? `Turn limit reached (${detail}).` : "Tool round limit reached.");
      case "no_model": return state("failed", detail ? `No model available: ${detail}` : "No model is configured or available.");
      case "restart_limit": return state("failed", detail ? `Restart limit exceeded: ${detail}` : "Task restart limit reached.");
      case "interrupted": return state("failed", detail ? `Run interrupted: ${detail}` : "Run interrupted by daemon restart.");
      case "nothing_to_answer": return state("ready", detail || "Nothing to answer.");
      case "reset": return state("ready");
      case "faulted": case "orphaned": return state("failed", detail || `Task ${reason}.`);
    }
  }
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

  if (!message) return state("ready");

  // Finished: clear to ready once the user opens the session after the response arrived.
  const readDoc = await tx.doc(SessionReadDoc, id);
  const readAt = readDoc.at;
  if (readAt !== null && readAt >= (message.timestamp ?? 0)) return state("ready");

  return state("finished");
}

export type CommonSessionReport = {
  state: "running" | "done" | "failed" | "unanswered" | "idle" | "needs_input" | "needs_approval" | "stopped";
  requestId?: string;
  answer?: string;
  reason?: string;
  boundary?: number;
};

/** Shared resolution of child/member session status over a list of request IDs. */
export async function readCommonSessionReport(
  tx: Tx,
  cid: ConversationId,
  requests: string[],
): Promise<{ report: CommonSessionReport; running: boolean; latestSubmission?: Awaited<ReturnType<Tx["submissionByRequest"]>> }> {
  const base: CommonSessionReport = { state: "idle" };
  const latest = requests.at(-1);
  if (latest) base.requestId = latest;

  let pending = false;
  for (const request of requests) {
    const submission = await tx.submissionByRequest(cid, request);
    if (!submission || submission.status === "queued" || submission.status === "placed") pending = true;
    if (request !== latest || !submission) continue;
    if (submission.status === "unanswered") {
      base.state = "unanswered";
      base.reason = submission.reason;
    } else if (submission.type === "input" && submission.status === "done") {
      base.state = "done";
      const entry = await tx.entry(submission.answer);
      base.answer = (entry?.model ?? []).flatMap(m => m.role === "assistant" ? m.content : [])
        .flatMap(c => c.type === "text" ? [c.text] : []).join("\n");
    }
  }

  const running = pending || await isRunning(tx, cid);
  if (running) base.state = "running";

  const handoff = await readSessionHandoff(tx, cid);
  const status = await readSessionStatus(tx, cid, running);
  const latestSubmission = latest ? await tx.submissionByRequest(cid, latest) : undefined;

  const handoffMatches = handoff && (
    !latestSubmission
      ? true
      : latestSubmission.type === "input" && latestSubmission.entry !== undefined && handoff.boundary >= Number(latestSubmission.entry)
  );

  if (handoffMatches) {
    base.state = handoff.status;
    base.reason = handoff.reason;
    base.boundary = handoff.boundary;
  } else if (!running && ["failed", "limit_reached", "stopped"].includes(status.status)) {
    base.state = status.status === "stopped" ? "stopped" : "failed";
    base.reason = status.statusReason ?? status.status;
  }

  return { report: base, running, latestSubmission };
}
