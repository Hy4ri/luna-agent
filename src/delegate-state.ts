// Shared delegation state. Documents own identity; transcript scans are for legacy rows only.
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { isRunning, newestInputBoundary, readSessionHandoff, readSessionStatus } from "./session-status.js";

export const DELEGATE_MESSAGE = "delegate.msg";
export const DELEGATE_CHILD = "delegate.child";
export type ChildRow = {
  id: number; spawnKey: string; task: string; stopped?: "stopped" | "timeout"; deadline?: number; cwd?: string;
  requests?: string[]; notify?: boolean; profile?: string; brief?: string; collected?: { noticeId: string; taskId: number }; stopping?: boolean; deadlineTask?: number; cancelDeadlines?: number[];
};
export const Children = defineDoc<{ children: ChildRow[] }>({
  checkpointWhen: () => false, kind: "luna.delegate.children", version: 1,
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({ children: [] }),
});
export const ChildResult = defineDoc<{
  schema: Record<string, JsonValue> | null;
  result: { boundary: number; value: JsonValue } | null;
}>({
  checkpointWhen: () => false, kind: "luna.delegate.result", version: 1,
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({ schema: null, result: null }),
});

/** Lazily migrate old children, skipping inherited parent entries and following every page. */
export async function childRequests(tx: Tx, parent: ConversationId, id: number): Promise<string[]> {
  const row = (await tx.doc(Children, parent)).children.find(c => c.id === id);
  if (!row) return [];
  if (row.requests) return [...row.requests];
  const requests: string[] = [];
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: id as ConversationId, order: "ascending" }, 200, cursor);
    for (const entry of page.items) {
      if (Number(entry.conversationId) !== id || entry.kind !== DELEGATE_MESSAGE) continue;
      const request = (entry.data as { requestId?: string } | undefined)?.requestId;
      if (request && !requests.includes(request)) requests.push(request);
    }
    cursor = page.next;
  } while (cursor);
  row.requests = requests;
  return requests;
}

export type ChildReport = {
  id: number; state: "running" | "done" | "failed" | "unanswered" | "idle" | "needs_input" | "needs_approval" | "stopped";
  answer?: string; reason?: string; cwd?: string; requestId?: string; boundary?: number;
  result?: JsonValue; resultStatus: "valid" | "missing" | "not_requested";
};
/** Shared identity for proactive notices and results already collected by a durable parent tool. */
export function childNotificationId(report: ChildReport): string | undefined {
  if (report.state === "running" || report.state === "idle") return undefined;
  return report.state === "needs_input" || report.state === "needs_approval"
    ? `subagent-block:${report.id}:${report.boundary ?? 0}`
    : `subagent-term:${report.id}:${report.requestId ?? "none"}:${report.state}`;
}
export async function readChildReport(tx: Tx, parent: ConversationId, id: number): Promise<ChildReport> {
  const cid = id as ConversationId;
  const row = (await tx.doc(Children, parent)).children.find(c => c.id === id);
  const base: ChildReport = { id, state: "idle", resultStatus: "not_requested", ...(row?.cwd ? { cwd: row.cwd } : {}) };
  if (!row || !await tx.conversation(cid)) return { ...base, state: "failed", reason: "Child conversation no longer exists." };
  const requests = await childRequests(tx, parent, id);
  const latest = requests.at(-1);
  if (latest) base.requestId = latest;
  let pending = false;
  for (const request of requests) {
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
  const status = await readSessionStatus(tx, cid, running);
  const handoff = await readSessionHandoff(tx, cid);
  const latestSubmission = latest ? await tx.submissionByRequest(cid, latest) : undefined;
  if (handoff && latestSubmission?.entry !== undefined && handoff.boundary >= Number(latestSubmission.entry)) {
    base.state = handoff.status; base.reason = handoff.reason; base.boundary = handoff.boundary;
  }
  else if (!running && ["failed", "limit_reached", "stopped"].includes(status.status)) {
    base.state = status.status === "stopped" ? "stopped" : "failed";
    base.reason = status.statusReason ?? status.status;
  }
  const contract = await tx.doc(ChildResult, cid);
  if (contract.schema) {
    // A result belongs to the placed input boundary, not a previous steering turn.
    const input = latestSubmission?.entry;
    if (contract.result && input !== undefined && contract.result.boundary >= Number(input) && contract.result.boundary === await newestInputBoundary(tx, cid)) {
      base.resultStatus = "valid"; base.result = JSON.parse(JSON.stringify(contract.result.value)) as JsonValue;
    } else {
      base.resultStatus = "missing";
      if (base.state === "done") { base.state = "failed"; base.reason = "Child ended without a validated delegate_result for this input."; }
    }
  }
  if (row.stopped) {
    base.state = "stopped";
    base.reason = row.stopped === "timeout" ? "stopped: time budget exceeded" : "stopped by the parent";
  }
  return base;
}
