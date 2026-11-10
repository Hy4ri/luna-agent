// Migration-only reader for the retired continuation engine. No observer, timer, or delivery path.
import { defineDoc, type ConversationId, type ModelRef } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { RecoveryStateDoc, recoveryCandidate, recoveryKey, type RecoveryAttempt } from "./recovery-state.js";
import type { ScheduledMessagesService } from "./scheduled-messages.js";
import type { LimitRecoveryPolicy } from "./limit-recovery.js";

type LegacyWait = {
  boundary: number; resumeAt: number; attempt: number; exact: boolean;
  generation?: number; provider?: string; model?: string; nextDeliveryAt?: number;
  deadline?: number; firstFailedAt?: number; resetSource?: string;
};
type LegacyChain = {
  boundary: number; generation: number; provider: string; model: string;
  requestId: string; attemptsAdmitted: number; cancelled?: boolean;
  lastOutcome?: string; deliveryPausedReason?: string;
};
export const LimitWaitsDoc = defineDoc<{
  waits: Record<string, LegacyWait>;
  chains?: Record<string, LegacyChain>;
  routes?: Record<string, { activeSessionId?: number; activeRequestId?: string; claimedAt?: number; cooldownUntil?: number }>;
}>({ checkpointWhen: () => false, kind: "luna.limit-waits", version: 1, scope: "session", initial: () => ({ waits: {}, chains: {}, routes: {} }) });

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export async function migrateLimitWaits(harness: Harness, schedules: ScheduledMessagesService,
  policy: LimitRecoveryPolicy, fallback: ModelRef, now: number, skip?: (id: number) => boolean): Promise<void> {
  await harness.commit(async tx => {
    const state = await tx.doc(RecoveryStateDoc);
    if (state.legacyMigrated) return;
    const legacy = await tx.doc(LimitWaitsDoc);
    const ids = new Set([...Object.keys(legacy.waits), ...Object.keys(legacy.chains ?? {})]);
    for (const sid of ids) {
      const id = Number(sid), cid = id as ConversationId;
      const wait = legacy.waits[sid], chain = legacy.chains?.[sid];
      const boundary = wait?.boundary ?? chain!.boundary;
      const key = recoveryKey(id, boundary);
      if (state.attempts[key]) continue;
      const generation = wait?.generation ?? chain?.generation ?? 0;
      const provider = wait?.provider ?? chain?.provider ?? fallback.provider;
      const model = wait?.model ?? chain?.model ?? fallback.modelId;
      const oldRequest = chain?.requestId ?? `limit-continue-${id}-${boundary}-${generation}`;
      const prior = await tx.submissionByRequest(cid, oldRequest);
      const initial: RecoveryAttempt = { conversationId: id, boundary, generation, provider, model, status: "stopped" };
      state.attempts[key] = initial;
      // Mutate the durable draft, not the plain object copied into it.
      const attempt = state.attempts[key]!;
      if (prior || (chain?.attemptsAdmitted ?? 0) > 0 || chain?.lastOutcome === "admitted") {
        attempt.status = "consumed"; attempt.reason = "Legacy automatic recovery was already admitted."; continue;
      }
      if (!await tx.conversation(cid) || skip?.(id) || !policy.enabled || !wait || chain?.cancelled ||
        chain?.lastOutcome === "paused" || wait.attempt !== 1 || !wait.generation || !wait.provider || !wait.model) {
        attempt.reason = "Legacy wait is cancelled, disabled, missing, or cannot prove unused recovery entitlement."; continue;
      }
      const failure = await recoveryCandidate(tx, cid, fallback);
      const dueAt = Math.max(wait.resumeAt, wait.nextDeliveryAt ?? 0);
      if (!failure || failure.boundary !== boundary || failure.generation !== generation ||
        failure.provider !== provider || failure.model !== model || !Number.isSafeInteger(dueAt) || dueAt <= 0 || dueAt > 8.64e15 ||
        dueAt - now > policy.maxWaitHours * 3_600_000 || now > (wait.deadline ?? Infinity) ||
        dueAt > (wait.deadline ?? Infinity)) {
        attempt.reason = "Legacy wait no longer matches the failed turn, model, or wait horizon."; continue;
      }
      await schedules.create(tx, { conversationId: id, content: "Continue", dueAt, allowPast: true,
        requestId: `legacy-limit-recovery:${id}:${boundary}:${generation}`,
        source: { kind: "limit_recovery", boundary, generation, provider, model, exact: wait.exact,
          resetSource: wait.resetSource ?? "legacy_wait" } });
      attempt.status = "scheduled";
    }
    // Mark conversion atomically; the old state has no remaining owner or active dispatcher.
    legacy.waits = {}; legacy.chains = {}; legacy.routes = {};
    state.legacyMigrated = true;
  }, context);
}
