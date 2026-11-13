// Housekeeping on other sessions, for the steward tool: finish todos, cancel open questions, clear a stale status, and pause or clear a goal.
// Each function runs inside one transaction and changes only the session it is given. The tool decides which sessions m57 named.
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { AskDoc } from "../ask.js";
import { closeWait } from "../analytics/waits.js";
import { GoalDoc } from "../goal-doc.js";
import { SessionHandoffDoc, SessionReadDoc } from "../session-status.js";
import { TodoDoc } from "../todo.js";

const cid = (id: number) => id as ConversationId;

export interface SessionView {
  todos: { id: number; subject: string; status: string }[];
  questions: { callId: string; purpose: "input" | "approval"; question: string }[];
  goal: { objective: string; status: string; reason?: string; tasksOpen: number } | null;
  handoff: { status: string; reason: string } | null;
}

/** What a session holds that Steward can clean: open todos, unanswered questions, the goal, and a handoff status. */
export async function viewSession(tx: Tx, id: number): Promise<SessionView> {
  const todo = await tx.doc(TodoDoc, cid(id)), ask = await tx.doc(AskDoc, cid(id)), goal = (await tx.doc(GoalDoc, cid(id))).goal;
  const handoff = (await tx.doc(SessionHandoffDoc, cid(id))).handoff;
  return {
    todos: todo.tasks.filter(t => t.status === "pending" || t.status === "in_progress").map(t => ({ id: t.id, subject: t.subject, status: t.status })),
    questions: ask.pending.filter(p => !ask.answers[p.callId]).map(p => ({ callId: p.callId, purpose: p.purpose ?? "input", question: p.questions[0]?.question ?? "" })),
    goal: goal && { objective: goal.objective, status: goal.status, ...(goal.statusReason ? { reason: goal.statusReason } : {}), tasksOpen: goal.tasks.filter(t => t.status === "pending").length },
    handoff: handoff && { status: handoff.status, reason: handoff.reason },
  };
}

/** Mark open todos completed. `ids` undefined means every open todo. Unknown or closed ids are reported, not guessed. */
export async function finishTodos(tx: Tx, id: number, ids?: number[]): Promise<{ done: number[]; missing: number[] }> {
  const doc = await tx.doc(TodoDoc, cid(id));
  const open = doc.tasks.filter(t => t.status === "pending" || t.status === "in_progress");
  const pick = ids ? open.filter(t => ids.includes(t.id)) : open;
  for (const t of pick) t.status = "completed";
  return { done: pick.map(t => t.id), missing: ids ? ids.filter(i => !pick.some(t => t.id === i)) : [] };
}

/** Cancel every unanswered ask_user_question in the session. The waiting tool gets "declined" and the turn goes on. */
export async function cancelQuestions(tx: Tx, id: number, note?: string): Promise<number> {
  const doc = await tx.doc(AskDoc, cid(id));
  let n = 0;
  for (const p of doc.pending) {
    if (doc.answers[p.callId]) continue;
    doc.answers[p.callId] = { answers: [], cancelled: true, ...(note?.trim() ? { globalNote: note.trim().slice(0, 500) } : {}) };
    await closeWait(tx, cid(id), { callId: p.callId, outcome: "cancelled" });
    n++;
  }
  return n;
}

/** Drop a needs_input or needs_approval handoff and mark the session read, so a finished one shows as ready. */
export async function clearStatus(tx: Tx, id: number, now = Date.now()): Promise<boolean> {
  const handoff = await tx.doc(SessionHandoffDoc, cid(id));
  const had = !!handoff.handoff;
  handoff.handoff = null;
  (await tx.doc(SessionReadDoc, cid(id))).at = now;
  return had;
}

export type GoalChange = "pause" | "complete" | "clear";
/** Pause, complete, or clear a session's goal. Returns an error text, or "". Resuming needs a turn, so it stays in the session. */
export async function changeGoal(tx: Tx, id: number, change: GoalChange, reason?: string): Promise<string> {
  const doc = await tx.doc(GoalDoc, cid(id));
  if (!doc.goal) return "the session has no goal";
  if (change === "clear") { doc.goal = null; return ""; }
  if (doc.goal.status === "complete") return "the goal is already complete";
  doc.goal.status = change === "pause" ? "paused" : "complete";
  doc.goal.statusReason = (reason?.trim() || (change === "pause" ? "paused by Steward for m57" : "completed by Steward for m57")).slice(0, 300);
  return "";
}
