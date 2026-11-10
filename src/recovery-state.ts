import { AgentDoc, InboxDoc, defineDoc, type ConversationId, type EntryId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import { AskDoc } from "./ask.js";
import { isRunning, readTurnFailure, SessionHandoffDoc, type TurnFailure } from "./session-status.js";

export type RecoveryAttempt = {
  conversationId: number;
  boundary: number;
  generation: number;
  provider: string;
  model: string;
  status: "parsing" | "scheduled" | "stopped" | "consumed";
  reason?: string;
  evidenceAt?: number;
  exact?: boolean;
};

/** A claim is persisted BEFORE a parser call. An interrupted claim never calls the model again. */
export const RecoveryStateDoc = defineDoc<{
  attempts: Record<string, RecoveryAttempt>;
  blockedThrough: Record<string, number>;
  legacyMigrated: boolean;
}>({
  kind: "luna.scheduled-recovery", version: 1, scope: "session", checkpointWhen: () => false,
  initial: () => ({ attempts: {}, blockedThrough: {}, legacyMigrated: false }),
});

export const recoveryKey = (id: number, boundary: number) => `${id}:${boundary}`;

/** Same configured route can share provider reset evidence, never another model's guessed timing. */
export function recoveryResetFloor(attempts: Record<string, RecoveryAttempt>, provider: string, model: string): number {
  return Math.max(0, ...Object.values(attempts)
    .filter(a => a.provider === provider && a.model === model && a.evidenceAt !== undefined)
    .map(a => a.evidenceAt!));
}

/** Read only: all admission guards must run before the harness writes tables. */
export async function recoveryCandidate(tx: Tx, id: ConversationId, fallback: ModelRef): Promise<TurnFailure | undefined> {
  const conv = await tx.conversation(id);
  if (!conv || conv.owner || await isRunning(tx, id)) return undefined;
  // Historical forks may contain a delegate marker, but only this conversation's own marker owns it.
  const ownHead = await tx.scanEntries({ conversationId: id, order: "ascending",
    ...(conv.parent ? { minEntryId: (Number(conv.parent.at) + 1) as EntryId } : {}) }, 30);
  if (ownHead.items.some(e => e.kind === "delegate.child" || e.kind === "luna.side-question")) return undefined;
  const failure = await readTurnFailure(tx, id);
  if (!failure || conv.parent && failure.boundary <= Number(conv.parent.at)) return undefined;
  if ((await tx.doc(InboxDoc, id)).items.length) return undefined;
  const ask = await tx.doc(AskDoc, id);
  if (ask.pending.some(q => !ask.answers[q.callId])) return undefined;
  if ((await tx.doc(SessionHandoffDoc, id)).handoff?.boundary === failure.boundary) return undefined;
  const model = (await tx.doc(AgentDoc, id)).model ?? fallback;
  if (failure.provider && (failure.provider !== model.provider || failure.model !== model.modelId)) return undefined;
  const state = await tx.doc(RecoveryStateDoc);
  if (failure.boundary <= (state.blockedThrough[String(id)] ?? -1)) return undefined;
  return failure;
}
