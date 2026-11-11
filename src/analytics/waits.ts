import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

export type PendingWaitKind = "ask_user_question" | "session_status";
export type PendingWaitPurpose = "input" | "approval";
export type WaitOutcome = "answered" | "cancelled" | "timeout" | "stopped";

export type PendingWaitItem = {
  callId: string;
  startAt: number;
  purpose: PendingWaitPurpose;
  kind: PendingWaitKind;
}

export type AnalyticsWaitDocValue = {
  pending: Record<string, PendingWaitItem>;
  completed?: Record<string, true>;
}

export const AnalyticsWaitDoc = defineDoc<AnalyticsWaitDocValue>({
  checkpointWhen: () => false,
  kind: "luna.analytics.wait-doc",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: {} }),
});

export interface StartWaitOptions {
  callId: string;
  kind: PendingWaitKind;
  purpose: PendingWaitPurpose;
  tool: string;
  startedAt?: number;
}

export interface CloseWaitOptions {
  callId: string;
  outcome: WaitOutcome;
  endedAt?: number;
}

export interface AnalyticsWaitPayload {
  callId: string;
  startedAt: number;
  endedAt: number | null;
  purpose: PendingWaitPurpose;
  tool: string;
  outcome: WaitOutcome | null;
}

export async function startWait(
  tx: Tx,
  conversationId: ConversationId,
  options: StartWaitOptions,
): Promise<boolean> {
  const doc = await tx.doc(AnalyticsWaitDoc, conversationId);
  if (doc.pending[options.callId] || doc.completed?.[options.callId]) return false;

  const startedAt = options.startedAt ?? Date.now();
  doc.pending[options.callId] = {
    callId: options.callId,
    startAt: startedAt,
    purpose: options.purpose,
    kind: options.kind,
  };

  const payload: AnalyticsWaitPayload = {
    callId: options.callId,
    startedAt,
    endedAt: null,
    purpose: options.purpose,
    tool: options.tool,
    outcome: null,
  };

  await tx.appendEntry(conversationId, {
    kind: "luna.analytics.wait",
    data: payload as never,
  });

  return true;
}

export async function closeWait(
  tx: Tx,
  conversationId: ConversationId,
  options: CloseWaitOptions,
): Promise<boolean> {
  const doc = await tx.doc(AnalyticsWaitDoc, conversationId);
  const pending = doc.pending[options.callId];
  if (!pending) return false;

  delete doc.pending[options.callId];
  doc.completed = { ...doc.completed, [options.callId]: true };
  const endedAt = options.endedAt ?? Date.now();

  const payload: AnalyticsWaitPayload = {
    callId: options.callId,
    startedAt: pending.startAt,
    endedAt,
    purpose: pending.purpose,
    tool: pending.kind,
    outcome: options.outcome,
  };

  await tx.appendEntry(conversationId, {
    kind: "luna.analytics.wait",
    data: payload as never,
  });

  return true;
}

export async function closeOpenSessionStatusWaits(
  tx: Tx,
  conversationId: ConversationId,
  outcome: WaitOutcome = "answered",
  endedAt?: number,
): Promise<string[]> {
  const doc = await tx.doc(AnalyticsWaitDoc, conversationId);
  const closedCallIds: string[] = [];
  const now = endedAt ?? Date.now();

  for (const [callId, item] of Object.entries(doc.pending)) {
    if (item.kind === "session_status") {
      delete doc.pending[callId];
      doc.completed = { ...doc.completed, [callId]: true };
      closedCallIds.push(callId);
      const payload: AnalyticsWaitPayload = {
        callId,
        startedAt: item.startAt,
        endedAt: now,
        purpose: item.purpose,
        tool: item.kind,
        outcome,
      };
      await tx.appendEntry(conversationId, {
        kind: "luna.analytics.wait",
        data: payload as never,
      });
    }
  }

  return closedCallIds;
}
