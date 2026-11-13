// Crew state: a lead session and the full top-level sessions it created with session_crew.
// The lead owns the member list. Each member records its lead. Neither document passes to a fork.
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { classifyLimit } from "./limit-reset.js";
import { readCommonSessionReport } from "./session-status.js";

export type CrewRow = {
  id: number; spawnKey: string; task: string; requests: string[]; brief?: string;
  stopped?: boolean; collected?: { noticeId: string; taskId: number };
};
export const Crew = defineDoc<{ members: CrewRow[] }>({
  checkpointWhen: () => false, kind: "luna.crew", version: 1,
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({ members: [] }),
});
export const CrewLead = defineDoc<{ lead: number | null }>({
  checkpointWhen: () => false, kind: "luna.crew.lead", version: 1,
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({ lead: null }),
});

/** The lead of `id`, only while the lead still lists it as a member. */
export async function crewLead(tx: Tx, id: ConversationId): Promise<ConversationId | undefined> {
  const lead = (await tx.doc(CrewLead, id)).lead;
  if (lead === null || !await tx.conversation(lead as ConversationId)) return undefined;
  return (await tx.doc(Crew, lead as ConversationId)).members.some(m => m.id === Number(id)) ? lead as ConversationId : undefined;
}
/** A lead and its member talk without a hop limit, in both directions. */
export async function crewLinked(tx: Tx, a: number, b: number): Promise<boolean> {
  return Number(await crewLead(tx, b as ConversationId)) === a || Number(await crewLead(tx, a as ConversationId)) === b;
}

export type CrewReport = {
  id: number; state: "running" | "done" | "failed" | "unanswered" | "idle" | "needs_input" | "needs_approval" | "stopped";
  answer?: string; reason?: string; requestId?: string; boundary?: number;
  /** Set for failed and unanswered states. `detail` keeps the full error text for show. */
  error?: { class: ErrorClass; resetAt?: number; detail: string };
};
export type ErrorClass = "quota" | "transient" | "fatal" | "deleted" | "error";

const TRANSIENT = /\b(?:abort(?:ed)?|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|network|connection (?:abort|reset|closed|error|refused)|timed? ?out|502|503|504|bad gateway|service unavailable|stream (?:ended|closed))\b/i;

/** One readable line from an error: the JSON `message` field when the text is a provider body, else the first line. */
export function shortError(text: string, max = 200): string {
  const json = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]?.replace(/\\(.)/g, "$1");
  const line = (json ?? text.split("\n").map(l => l.trim()).find(Boolean) ?? "").replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max)}...` : line;
}
/** quota: waits for a reset; transient: retry now; fatal: auth, billing, or context size; deleted: session gone. */
export function classifyError(text: string, now = Date.now()): { class: ErrorClass; resetAt?: number } {
  const limit = classifyLimit(text, now);
  if (limit.kind === "wait") return { class: "quota", ...(limit.resetAt !== undefined ? { resetAt: limit.resetAt } : {}) };
  if (limit.kind === "fatal") return { class: "fatal" };
  return TRANSIENT.test(text) ? { class: "transient" } : { class: "error" };
}
/** Shared identity for automatic reports and results the lead already collected with wait or show. */
export function crewNoticeId(r: CrewReport): string | undefined {
  if (r.state === "running" || r.state === "idle") return undefined;
  return r.state === "needs_input" || r.state === "needs_approval"
    ? `crew-block:${r.id}:${r.boundary ?? 0}` : `crew-term:${r.id}:${r.requestId ?? "none"}:${r.state}`;
}

/** State of the lead's latest task in member `id`. Turns the user starts directly in the member do not count as done. */
export async function readCrewReport(tx: Tx, lead: ConversationId, id: number): Promise<CrewReport> {
  const cid = id as ConversationId;
  const row = (await tx.doc(Crew, lead)).members.find(m => m.id === id);
  const base: CrewReport = { id, state: "idle" };
  if (!row || !await tx.conversation(cid)) return { ...base, state: "failed", reason: "Session no longer exists.", error: { class: "deleted", detail: "Session no longer exists." } };
  const { report } = await readCommonSessionReport(tx, cid, row.requests);
  Object.assign(base, report);
  if (row.stopped) { base.state = "stopped"; base.reason = "stopped by the lead"; }
  if ((base.state === "failed" || base.state === "unanswered") && base.reason) {
    const detail = base.reason;
    base.error = { ...classifyError(detail), detail };
    base.reason = shortError(detail);
  }
  return base;
}

/** A settled result the lead has not seen: not collected by wait or show, and no automatic report delivered. */
export async function crewUnseen(tx: Tx, lead: ConversationId, r: CrewReport): Promise<boolean> {
  const noticeId = crewNoticeId(r);
  if (!noticeId || r.state === "running") return false;
  const row = (await tx.doc(Crew, lead)).members.find(m => m.id === r.id);
  if (row?.collected?.noticeId === noticeId) {
    const task = await tx.task(row.collected.taskId as never);
    if (task?.state.status === "terminal" && task.state.outcome.status === "completed") return false;
  }
  const report = await tx.submissionByRequest(lead, noticeId);
  return !report || report.status !== "done";
}
