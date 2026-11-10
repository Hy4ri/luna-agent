import { LiveDoc, UsageDoc, type ConversationId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { classifyLimit } from "./limit-reset.js";
import { type ScheduledMessagesService } from "./scheduled-messages.js";
import { RecoveryStateDoc, compactRecoveryState, recoveryCandidate, recoveryKey, recoveryResetFloor, type RecoveryAttempt } from "./recovery-state.js";
import type { ResetTimeInput, ResetTimeResult } from "./reset-time-parser.js";
import { migrateLimitWaits } from "./limit-continue.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type LimitRecoveryPolicy = { enabled: boolean; maxWaitHours: number; resetGraceSeconds?: number };
export const RESET_TIME_MARGIN_MS = 60_000;

export class LimitRecoveryService {
  private observation: { detach(): void } | undefined;
  private closed = false;
  private work: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();

  constructor(private readonly o: {
    harness: Harness;
    scheduledMessages: ScheduledMessagesService;
    log: (m: string) => void;
    policy: () => LimitRecoveryPolicy;
    /** Main-session fallback, used only to verify the failed route. */
    defaultModel: () => ModelRef;
    /** Same provider/model defaults used by an unprofiled subagent. */
    parserModel?: (failedModel: ModelRef) => ModelRef;
    parseResetTime?: (input: ResetTimeInput) => Promise<ResetTimeResult | undefined>;
    now?: () => number;
    skip?: (id: number) => boolean;
  }) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  private enqueue(fn: () => Promise<void>) {
    this.work = this.work.catch(() => {}).then(async () => { if (!this.closed) await fn(); });
    void this.work.catch(e => this.o.log(`limit-recovery: ${(e as Error).message}`));
    return this.work;
  }

  async start(): Promise<void> {
    await migrateLimitWaits(this.o.harness, this.o.scheduledMessages, this.o.policy(), this.o.defaultModel(), this.now(), this.o.skip);
    this.observation = this.o.harness.observeCommits({
      advance: p => {
        const failures = new Map<number, number>();
        for (const ch of p.changes) {
          if (ch.type === "task" && ch.value.kind === "pi.generation" && ch.value.state.status === "terminal") {
            failures.set(Number(ch.value.conversationId), Number(ch.value.id));
          }
        }
        // An aborted queued submission must not reawaken an older failed generation.
        for (const [id, generation] of failures) queueMicrotask(() => { void this.enqueue(() => this.check(id, generation)).catch(() => {}); });
      },
      end: () => { queueMicrotask(() => void this.close()); },
    });
    // Reconcile a claimed parser cut off by a crash using captured evidence only; never re-call it.
    await this.enqueue(async () => {
      const claims = await this.o.harness.commit(async tx => {
        const state = await tx.doc(RecoveryStateDoc);
        compactRecoveryState(state, this.now());
        return JSON.parse(JSON.stringify(Object.values(state.attempts).filter(a => a.status === "parsing"))) as RecoveryAttempt[];
      }, context);
      for (const claim of claims) await this.finish(claim, undefined);
      // Only persisted claims/schedules resume at boot. Historical failures without a
      // claim require new user intent, not a new paid interpretation of old error text.
    });
    await this.o.scheduledMessages.scheduleChanged();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.observation?.detach();
    for (const c of this.controllers) c.abort();
    await this.work.catch(() => {});
  }

  private async check(id: number, generation: number): Promise<void> {
    if (this.closed || !this.o.policy().enabled || this.o.skip?.(id)) return;
    const cid = id as ConversationId;
    const now = this.now();
    const claim = await this.o.harness.commit(async tx => {
      const failure = await recoveryCandidate(tx, cid, this.o.defaultModel());
      if (!failure || failure.generation !== generation) return;
      const state = await tx.doc(RecoveryStateDoc);
      const key = recoveryKey(id, failure.boundary);
      if (state.attempts[key] || (state.claimedThrough?.[String(id)] ?? -1) >= failure.boundary) return;
      const failedAt = failure.limit?.receivedAt ?? failure.failedAt ?? now;
      const error = failure.limit?.response ?? failure.message;
      const cls = classifyLimit(error, failedAt);
      if (cls.kind === "fatal" || failure.limit?.kind === "fatal" || (cls.kind !== "wait" && failure.limit?.kind !== "wait")) return;
      // The run's actual submission receipts handle batching, many tool rounds, and restarts.
      const inputs = (await tx.doc(LiveDoc, cid)).runFailure?.inputs ?? [];
      let recursive = false;
      for (const input of inputs) {
        const submission = await tx.submission(input);
        const entry = submission && "entry" in submission && submission.entry !== undefined ? await tx.entry(submission.entry) : undefined;
        if (entry?.kind === "luna.scheduled-message" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) && entry.data.source === "limit_recovery") {
          recursive = true; break;
        }
      }
      const windows = failure.limit?.windows ?? [];
      const knownResets = windows.flatMap(w => w.resetAt === null ? [] : [w.resetAt]);
      if (cls.kind === "wait" && cls.resetAt !== undefined) knownResets.push(cls.resetAt);
      const provider = failure.provider ?? this.o.defaultModel().provider;
      const model = failure.model ?? this.o.defaultModel().modelId;
      const ownEvidence = knownResets.length ? Math.max(...knownResets) : 0;
      const evidenceAt = Math.max(ownEvidence, recoveryResetFloor(state, provider, model)) || undefined;
      const staleReason = now - failedAt > this.o.policy().maxWaitHours * 3_600_000
        ? "Failure is older than maxWaitHours. Retry or schedule manually."
        : ownEvidence > 0 && ownEvidence <= now ? "Known reset time already passed. Retry or schedule manually." : undefined;
      const exactEvidence = ownEvidence > 0 && !windows.some(w => w.resetAt === null) && (windows.length > 0 || (cls.kind === "wait" && !!cls.exact));
      const attempt: RecoveryAttempt = {
        conversationId: id, boundary: failure.boundary, generation: failure.generation,
        provider, model,
        status: recursive ? "consumed" : staleReason ? "stopped" : "parsing",
        ...(recursive ? { reason: "Automatic recovery already attempted. Retry or schedule manually." } : staleReason ? { reason: staleReason } : {}),
        ...(evidenceAt !== undefined ? { evidenceAt } : {}),
        exact: exactEvidence && evidenceAt === ownEvidence,
      };
      state.attempts[key] = attempt;
      compactRecoveryState(state, now);
      return { attempt: JSON.parse(JSON.stringify(attempt)) as RecoveryAttempt, error, failedAt, windows, exactEvidence };
    }, context);
    if (!claim || claim.attempt.status !== "parsing") return;
    if (claim.exactEvidence) { await this.finish(claim.attempt, undefined); return; }

    const failedModel = { provider: claim.attempt.provider, modelId: claim.attempt.model };
    const parserModel = this.o.parserModel?.(failedModel) ?? failedModel;
    const controller = new AbortController();
    this.controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), 15_000);
    let parsed: ResetTimeResult | undefined;
    try {
      // Admission was durably claimed above. Exceptions/unknown output get evidence fallback, not another call.
      parsed = await this.o.parseResetTime?.({ error: claim.error.slice(0, 6000), now, failedAt: claim.failedAt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", model: parserModel, windows: claim.windows, signal: controller.signal });
      if (parsed?.usage) await this.o.harness.commit(async tx => {
        const totals = (await tx.doc(UsageDoc, cid)).models;
        const key = `${parserModel.provider}/${parserModel.modelId}`;
        const usage = parsed!.usage!;
        if (!Object.hasOwn(totals, key)) { totals[key] = JSON.parse(JSON.stringify(usage)); return; }
        const total = totals[key]!;
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[field] += usage[field];
        for (const field of ["cacheWrite1h", "reasoning"] as const) if (usage[field] !== undefined) total[field] = (total[field] ?? 0) + usage[field]!;
        for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[field] += usage.cost[field];
      }, context);
    } catch (e) { this.o.log(`limit-recovery ${id}: parser unavailable; using reset evidence (${(e as Error).message})`); }
    finally { clearTimeout(deadline); this.controllers.delete(controller); }
    if (!this.closed) await this.finish(claim.attempt, parsed);
  }

  private async finish(claim: RecoveryAttempt, parsed: ResetTimeResult | undefined): Promise<void> {
    const now = this.now();
    await this.o.harness.commit(async (tx: Tx) => {
      const state = await tx.doc(RecoveryStateDoc);
      const current = state.attempts[recoveryKey(claim.conversationId, claim.boundary)];
      if (!current || current.status !== "parsing") return;
      const policy = this.o.policy();
      const failure = await recoveryCandidate(tx, claim.conversationId as ConversationId, this.o.defaultModel());
      if (!policy.enabled || this.o.skip?.(claim.conversationId) || !failure ||
        failure.boundary !== claim.boundary || failure.generation !== claim.generation) {
        current.status = "stopped"; current.reason = "Recovery invalidated by session activity or settings."; return;
      }
      const parsedAt = parsed?.resetAt;
      const validParse = typeof parsedAt === "number" && Number.isFinite(parsedAt) && parsedAt > now && parsedAt <= 8.64e15;
      // Even incomplete structured windows carry a known lower bound that a parser must not shorten.
      const resetAt = Math.ceil(Math.max(claim.evidenceAt ?? 0, recoveryResetFloor(state, claim.provider, claim.model), validParse ? parsedAt : 0));
      if (!resetAt || resetAt + (policy.resetGraceSeconds ?? 60) * 1000 <= now) {
        current.status = "stopped";
        current.reason = resetAt ? "Known reset time already passed. Retry or schedule manually." : "Cannot determine reset time. Schedule a message or retry manually.";
        return;
      }
      const dueAt = resetAt + (policy.resetGraceSeconds ?? 60) * 1000;
      if (dueAt - now > policy.maxWaitHours * 3_600_000) {
        current.status = "stopped"; current.reason = "Reset time exceeds maxWaitHours."; return;
      }
      const exact = !!claim.exact && resetAt === claim.evidenceAt;
      await this.o.scheduledMessages.create(tx, {
        conversationId: claim.conversationId, content: "Continue", dueAt,
        requestId: `limit-recovery:${claim.conversationId}:${claim.boundary}`,
        source: { kind: "limit_recovery", boundary: claim.boundary, generation: claim.generation,
          provider: claim.provider, model: claim.model, exact, resetSource: validParse && parsedAt > (claim.evidenceAt ?? 0) ? "model_parse" : "provider_evidence" },
      });
      current.status = "scheduled";
    }, context);
    await this.o.scheduledMessages.scheduleChanged();
  }
}
