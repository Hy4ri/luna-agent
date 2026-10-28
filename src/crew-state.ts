// Crew state: a lead session and the full top-level sessions it created with session_crew.
// The lead owns the member list. Each member records its lead. Neither document passes to a fork.
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { isRunning, readSessionHandoff, readSessionStatus } from "./session-status.js";

export type CrewRow = {
  id: number; spawnKey: string; task: string; requests: string[];
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
};
/** Shared identity for automatic reports and results the lead already collected with wait or show. */
export function crewNoticeId(r: CrewReport): string | undefined {
  if (r.state === "running" || r.state === "idle") return undefined;
  return r.state === "needs_input" || r.state === "needs_approval"
    ? `crew-block:${r.id}:${r.boundary ?? 0}` : `crew-term:${r.id}:${r.requestId ?? "none"}:${r.state}`;
}

/** State of the lead's latest task in member `id`. Turns m57 starts directly in the member do not count as done. */
export async function readCrewReport(tx: Tx, lead: ConversationId, id: number): Promise<CrewReport> {
  const cid = id as ConversationId;
  const row = (await tx.doc(Crew, lead)).members.find(m => m.id === id);
  const base: CrewReport = { id, state: "idle" };
  if (!row || !await tx.conversation(cid)) return { ...base, state: "failed", reason: "Session no longer exists." };
  const latest = row.requests.at(-1);
  if (latest) base.requestId = latest;
  let pending = false;
  for (const request of row.requests) {
    const submission = await tx.submissionByRequest(cid, request);
    if (!submission || submission.status === "queued" || submission.status === "placed") pending = true;
    if (request !== latest || !submission) continue;
    if (submission.status === "unanswered") { base.state = "unanswered"; base.reason = submission.reason; }
    else if (submission.type === "input" && submission.status === "done") {
      base.state = "done";
      const entry = await tx.entry(submission.answer);
      base.answer = (entry?.model ?? []).flatMap(m => m.role === "assistant" ? m.content : [])
        .flatMap(c => c.type === "text" ? [c.text] : []).join("\n");
    }
  }
  const running = pending || await isRunning(tx, cid);
  if (running) base.state = "running";
  const latestSubmission = latest ? await tx.submissionByRequest(cid, latest) : undefined;
  const handoff = await readSessionHandoff(tx, cid);
  const status = await readSessionStatus(tx, cid, running);
  if (handoff && latestSubmission?.entry !== undefined && handoff.boundary >= Number(latestSubmission.entry)) {
    base.state = handoff.status; base.reason = handoff.reason; base.boundary = handoff.boundary;
  } else if (!running && ["failed", "limit_reached", "stopped"].includes(status.status)) {
    base.state = status.status === "stopped" ? "stopped" : "failed";
    base.reason = status.statusReason ?? status.status;
  }
  if (row.stopped) { base.state = "stopped"; base.reason = "stopped by the lead"; }
  return base;
}
