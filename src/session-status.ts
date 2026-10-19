import { defineDoc, defineExtension, defineTool, section, type ConversationId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { AskDoc } from "./ask.js";
import { GoalDoc } from "./goal.js";

export type SessionStatus = "ready" | "running" | "finished" | "needs_approval" | "needs_input" | "limit_reached" | "failed" | "stopped";
export interface SessionState { status: SessionStatus; statusReason: string | null }
type Handoff = { status: "needs_approval" | "needs_input"; reason: string; boundary: number };
export const SessionHandoffDoc = defineDoc<{ handoff: Handoff | null }>({
  kind: "luna.session-handoff", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ handoff: null }),
});

/** Entry IDs, not model timestamps, define the current input or reset boundary. */
async function sessionTail(tx: Tx, id: ConversationId) {
  let cursor;
  let assistant: EntryRecord | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: id, order: "descending" }, 100, cursor);
    for (const entry of page.items) {
      if (entry.kind === "pi.reset" || entry.kind === "luna.context-start") return { boundary: Number(entry.id), reset: true, assistant };
      if (entry.kind === "pi.user") return { boundary: Number(entry.id), reset: false, assistant };
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
  sections: [section("session-status", () => "Before returning control to the user because you need permission or information, call session_handoff with needs_approval or needs_input and a short reason. For structured questions, use ask_user_question (purpose: approval for permission). These tools only report state; they never grant permission. A normal final answer is marked Finished, not verified task completion.")],
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
  return /\b(?:rate[_ -]?limit(?:ed)?|quota(?:[_ -]exceeded)?|insufficient_quota|usage[_ -]limit|token[_ -](?:budget|limit)|context[_ -](?:window|length|limit)|max(?:imum)?[_ -](?:tokens|context)|too many requests)\b|\b429\b|\b(?:budget|capacity) (?:exceeded|exhausted)|\bcontext.{0,30}(?:exceeded|too (?:large|long))|\bhit your (?:usage )?limit/i.test(message);
}
const state = (status: SessionStatus, statusReason: string | null = null): SessionState => ({ status, statusReason });

export async function readSessionStatus(tx: Tx, id: ConversationId, running: boolean): Promise<SessionState> {
  const ask = await tx.doc(AskDoc, id);
  // An accepted answer is no longer actionable, even before the waiting tool consumes it.
  const pending = ask.pending.find(question => !ask.answers[question.callId]);
  if (running && pending) return state(pending.purpose === "approval" ? "needs_approval" : "needs_input", pending.questions[0]?.question ?? "Waiting for your answer.");
  if (running) return state("running");

  const tail = await sessionTail(tx, id);
  if (tail.reset && !tail.assistant) return state("ready");
  // Only the foreground generation owns the session outcome. Tool errors and queue edits do not.
  const generation = (await tx.scanTasks({ conversationId: id, kind: "pi.generation", background: false, order: "descending" }, 1)).items[0];
  const outcome = generation?.state.outcome;
  if (outcome?.status === "aborted") return state("stopped", "Stopped by the user.");
  if (outcome?.status === "failed" || outcome?.status === "faulted") {
    const reason = outcome.error.message;
    return state(isLimitError(reason) ? "limit_reached" : "failed", reason.slice(0, 500));
  }
  if (outcome?.status === "orphaned") return state("failed", outcome.reason.slice(0, 500));

  const message = tail.assistant?.model?.find(message => message.role === "assistant");
  if (message?.role === "assistant") {
    if (message.stopReason === "aborted") return state("stopped", "The response was stopped.");
    if (message.stopReason === "length") return state("limit_reached", "The response reached the model output limit.");
    if (message.stopReason === "error") return state(isLimitError(message.errorMessage ?? "") ? "limit_reached" : "failed", (message.errorMessage || "The model request failed.").slice(0, 500));
  }

  const goal = (await tx.doc(GoalDoc, id)).goal;
  if (goal && goal.limitInput === tail.boundary && (goal.status === "budget_limited" || goal.status === "paused" && /^run allowance \d+ reached$/.test(goal.statusReason ?? ""))) {
    return state("limit_reached", goal.statusReason ?? "The goal reached its token budget.");
  }
  const handoff = (await tx.doc(SessionHandoffDoc, id)).handoff;
  if (handoff && handoff.boundary === tail.boundary) return state(handoff.status, handoff.reason);
  return state(message ? "finished" : "ready");
}
