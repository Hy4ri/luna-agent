import { defineDoc, defineDocFamily, type ConversationId, type SubmissionId, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { newestInputBoundary } from "./session-status.js";
import { RecoveryStateDoc, recoveryCandidate, recoveryKey, recoveryResetFloor } from "./recovery-state.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export type ScheduledMessageStatus = "scheduled" | "queued" | "delivered" | "cancelled" | "failed";

export type ScheduledMessageSource =
  | { kind: "user" }
  | {
      kind: "limit_recovery";
      boundary: number;
      generation: number;
      provider: string;
      model: string;
      exact: boolean;
      resetSource?: string;
    };

export type ScheduledMessageRecord = {
  id: string;
  conversationId: number;
  createdAt: number;
  dueAt: number;
  content: string;
  status: ScheduledMessageStatus;
  source: ScheduledMessageSource;
  requestId: string;
  submissionId?: string;
  entryId?: number;
  terminalReason?: string;
  deliveryAttempts?: number;
  nextDeliveryAt?: number;
  lastError?: string;
};

export type ScheduledMessagesDocValue = {
  schedules: Record<string, ScheduledMessageRecord>;
  requests: Record<string, { scheduleId: string; fingerprint: string }>;
};

export const ScheduledMessagesDoc = defineDoc<ScheduledMessagesDocValue>({
  checkpointWhen: () => false,
  kind: "luna.scheduled-messages",
  version: 1,
  scope: "session",
  initial: () => ({ schedules: {}, requests: {} }),
});

/** Cold terminal history and indefinite request receipts, partitioned by conversation. */
export const ScheduledMessagesHistoryDoc = defineDocFamily<ScheduledMessagesDocValue, null>({
  checkpointWhen: () => false, kind: "luna.scheduled-messages-history", version: 1, scope: "session", family: true,
  initial: () => ({ schedules: {}, requests: {} }),
});

function applySubmission(rec: ScheduledMessageRecord, sub: SubmissionRecord): void {
  if (sub.status === "done" || ("entry" in sub && sub.entry !== undefined)) {
    rec.status = "delivered";
    if ("entry" in sub && sub.entry !== undefined) rec.entryId = Number(sub.entry);
  } else if (sub.status === "unanswered") {
    rec.status = sub.reason === "run_failed" ? "failed" : "cancelled";
    rec.terminalReason = sub.reason || "unanswered";
  } else rec.status = "queued";
}

export class ScheduledMessageError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

const MAX_TIMER = 2 ** 31 - 1;
const DELIVERY_BACKOFFS = [30_000, 120_000, 600_000];

function fingerprintOf(conversationId: number, content: string, dueAt: number, source: ScheduledMessageSource): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ conversationId, content, dueAt, source }))
    .digest("hex");
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareDue(a: ScheduledMessageRecord, b: ScheduledMessageRecord): number {
  return a.dueAt - b.dueAt || a.id.localeCompare(b.id);
}

export type RecoverySummary = { active: boolean; resumeAt?: number; exact: boolean; source?: string; pausedReason?: string; provider?: string; model?: string };

export class ScheduledMessagesService {
  private readonly paused = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observation: { detach(): void } | undefined;
  private closed = false;
  private work: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly o: {
      harness: Harness;
      log: (m: string) => void;
      now?: () => number;
      skip?: (id: number) => boolean;
      recoveryPolicy?: () => { enabled: boolean; maxWaitHours: number; resetGraceSeconds?: number };
      defaultModel?: () => { provider: string; modelId: string };
    },
  ) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  private enqueueWork(fn: () => Promise<void>): Promise<void> {
    this.work = this.work.catch(() => {}).then(async () => {
      if (this.closed) return;
      await fn();
    });
    return this.track(this.work);
  }

  async start(): Promise<void> {
    this.observation = this.o.harness.observeCommits({
      advance: (p) => {
        const relevant = p.changes.some(
          (ch) => ch.type === "submission" || ch.type === "document" &&
            ["luna.ask", "luna.session-handoff", "pi.agent", "luna.scheduled-recovery"].includes(ch.record.kind),
        );
        if (relevant) {
          queueMicrotask(() => {
            if (this.closed) return;
            void this.enqueueWork(() => this.reconcileAndArm()).catch((e) =>
              this.o.log(`scheduled-messages: ${(e as Error).message}`),
            );
          });
        }
      },
      end: () => {
        this.closed = true;
        queueMicrotask(() => void this.close());
      },
    });

    await this.enqueueWork(() => this.reconcileAndArm());
  }

  async withDeliveryPaused<T>(id: number, fn: () => Promise<T>): Promise<T> {
    this.paused.add(id);
    try { return await fn(); }
    finally { this.paused.delete(id); await this.scheduleChanged(); }
  }

  async recovery(tx: Tx, id: ConversationId): Promise<RecoverySummary | undefined> {
    const pending = Object.values((await tx.doc(ScheduledMessagesDoc)).schedules)
      .filter(s => s.conversationId === Number(id) && s.source.kind === "limit_recovery" && (s.status === "scheduled" || s.status === "queued"))
      .sort(compareDue)[0];
    if (pending && pending.source.kind === "limit_recovery") return {
      active: true, resumeAt: Math.max(pending.dueAt, pending.nextDeliveryAt ?? 0), exact: pending.source.exact,
      source: pending.source.resetSource, provider: pending.source.provider, model: pending.source.model,
    };
    const boundary = await newestInputBoundary(tx, id);
    const attempt = (await tx.doc(RecoveryStateDoc)).attempts[recoveryKey(Number(id), boundary)];
    if (attempt && (attempt.status === "stopped" || attempt.status === "consumed") && attempt.reason) return {
      active: false, exact: false, pausedReason: attempt.reason, provider: attempt.provider, model: attempt.model,
    };
    return undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.observation?.detach();
    this.observation = undefined;
    await Promise.allSettled([...this.pending]);
  }

  async create(
    tx: Tx,
    input: {
      conversationId: number;
      content: string;
      dueAt: number;
      requestId: string;
      source: ScheduledMessageSource;
      allowPast?: boolean;
    },
  ): Promise<{ schedule: ScheduledMessageRecord; created: boolean }> {
    const content = input.content.trim();
    if (!content) throw new ScheduledMessageError("Message content is required.", 400);
    if (content.startsWith("/")) throw new ScheduledMessageError("Scheduled messages cannot execute slash commands.", 400);
    if (!Number.isSafeInteger(input.dueAt) || input.dueAt <= 0 || input.dueAt > 8.64e15) {
      throw new ScheduledMessageError("Invalid dueAt timestamp.", 400);
    }
    if (!input.requestId || !input.requestId.trim()) {
      throw new ScheduledMessageError("requestId is required.", 400);
    }

    const doc = await tx.doc(ScheduledMessagesDoc);
    const reqKey = `${input.conversationId}:${input.requestId}`;
    const fp = fingerprintOf(input.conversationId, content, input.dueAt, input.source);
    const history = await tx.doc(ScheduledMessagesHistoryDoc, String(input.conversationId), null);
    const existingReq = doc.requests[reqKey] ?? history.requests[reqKey];
    if (existingReq) {
      if (existingReq.fingerprint !== fp) {
        throw new ScheduledMessageError("requestId already belongs to another scheduled message.", 409);
      }
      const existing = doc.schedules[existingReq.scheduleId] ?? history.schedules[existingReq.scheduleId];
      if (existing) return { schedule: cloneRecord(existing), created: false };
    }

    if (!await tx.conversation(input.conversationId as ConversationId) || this.o.skip?.(input.conversationId)) {
      throw new ScheduledMessageError("Conversation is missing, archived, or unavailable for scheduling.", 409);
    }
    const now = this.now();
    if (!input.allowPast && input.dueAt <= now) {
      throw new ScheduledMessageError("Scheduled time must be in the future.", 400);
    }

    const id = `sm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const record: ScheduledMessageRecord = {
      id,
      conversationId: input.conversationId,
      createdAt: now,
      dueAt: input.dueAt,
      content,
      status: "scheduled",
      source: input.source,
      requestId: `scheduled-message:${id}`,
    };
    doc.schedules[id] = record;
    doc.requests[reqKey] = { scheduleId: id, fingerprint: fp };
    return { schedule: cloneRecord(record), created: true };
  }

  async update(tx: Tx, conversationId: number, id: string, input: { content: string; dueAt: number }): Promise<ScheduledMessageRecord> {
    const doc = await tx.doc(ScheduledMessagesDoc);
    const rec = doc.schedules[id] ?? (await tx.doc(ScheduledMessagesHistoryDoc, String(conversationId), null)).schedules[id];
    if (!rec || rec.conversationId !== conversationId) throw new ScheduledMessageError("No such scheduled message.", 404);
    if (rec.source.kind !== "user") throw new ScheduledMessageError("Automatic recovery cannot be edited.", 409);
    const content = input.content.trim();
    if (!content || content.startsWith("/")) throw new ScheduledMessageError("Message must be nonempty text, not a slash command.");
    if (!Number.isSafeInteger(input.dueAt) || input.dueAt <= 0 || input.dueAt > 8.64e15) throw new ScheduledMessageError("Invalid dueAt timestamp.");
    // An identical replay is read-only, even if delivery happened after a lost response.
    if (rec.content === content && rec.dueAt === input.dueAt) return cloneRecord(rec);
    if (rec.status !== "scheduled") throw new ScheduledMessageError("Message has already been queued or settled; it can no longer be edited.", 409);
    if (this.o.skip?.(conversationId)) throw new ScheduledMessageError("Conversation is unavailable for scheduling.", 409);
    if (input.dueAt <= this.now()) throw new ScheduledMessageError("Scheduled time must be in the future.");
    rec.content = content;
    rec.dueAt = input.dueAt;
    delete rec.nextDeliveryAt; delete rec.lastError; delete rec.deliveryAttempts;
    return cloneRecord(rec);
  }

  async summary(tx: Tx, conversationId: number): Promise<{ count: number; version: string }> {
    const pending = Object.values((await tx.doc(ScheduledMessagesDoc)).schedules)
      .filter(s => s.conversationId === conversationId && (s.status === "scheduled" || s.status === "queued")).sort(compareDue);
    return { count: pending.length, version: pending.length ? new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(pending.map(s => [s.id, s.status, s.content, s.dueAt, s.nextDeliveryAt, s.lastError]))).digest("hex") : "" };
  }

  async list(tx: Tx, conversationId: number): Promise<ScheduledMessageRecord[]> {
    const doc = await tx.doc(ScheduledMessagesDoc);
    const history = await tx.doc(ScheduledMessagesHistoryDoc, String(conversationId), null);
    return [...Object.values(doc.schedules), ...Object.values(history.schedules)]
      .filter((s) => s.conversationId === conversationId)
      .sort(compareDue)
      .map((s) => cloneRecord(s));
  }

  async cancel(
    conversationId: number,
    scheduleId: string,
    reason = "Cancelled by the user.",
  ): Promise<{
    status: "cancelled" | "already_delivered" | "already_cancelled" | "not_found";
    schedule?: ScheduledMessageRecord;
  }> {
    const pre = await this.o.harness.commit(async (tx) => {
      const doc = await tx.doc(ScheduledMessagesDoc);
      const rec = doc.schedules[scheduleId] ?? (await tx.doc(ScheduledMessagesHistoryDoc, String(conversationId), null)).schedules[scheduleId];
      if (!rec || rec.conversationId !== conversationId) return { kind: "not_found" as const };
      if (rec.status === "delivered") return { kind: "already_delivered" as const, schedule: cloneRecord(rec) };
      if (rec.status === "cancelled" || rec.status === "failed") {
        return { kind: "already_cancelled" as const, schedule: cloneRecord(rec) };
      }
      if (rec.status === "scheduled") {
        rec.status = "cancelled";
        rec.terminalReason = reason;
        return { kind: "cancelled" as const, schedule: cloneRecord(rec) };
      }
      return { kind: "queued" as const, submissionId: rec.submissionId, requestId: rec.requestId };
    }, context);

    if (pre.kind !== "queued") {
      if (pre.kind === "not_found") return { status: "not_found" };
      if (pre.kind === "cancelled") await this.scheduleChanged();
      return { status: pre.kind, schedule: pre.schedule };
    }

    if (pre.submissionId) {
      await this.o.harness.abortSubmission(
        Number(pre.submissionId) as SubmissionId,
        context,
        conversationId as ConversationId,
      );
    }

    const post = await this.o.harness.commit(async (tx) => {
      const doc = await tx.doc(ScheduledMessagesDoc);
      const rec = doc.schedules[scheduleId] ?? (await tx.doc(ScheduledMessagesHistoryDoc, String(conversationId), null)).schedules[scheduleId];
      if (!rec || rec.conversationId !== conversationId) return { status: "not_found" as const };
      const sub = await tx.submissionByRequest(conversationId as ConversationId, rec.requestId);
      if (sub && (sub.status === "done" || ("entry" in sub && sub.entry !== undefined))) {
        rec.status = "delivered";
        if ("entry" in sub && sub.entry !== undefined) rec.entryId = Number(sub.entry);
        return { status: "already_delivered" as const, schedule: cloneRecord(rec) };
      }
      if (rec.status !== "cancelled") {
        rec.status = "cancelled";
        rec.terminalReason = reason;
      }
      return { status: "cancelled" as const, schedule: cloneRecord(rec) };
    }, context);

    await this.scheduleChanged();
    return post;
  }

  async cancelForConversation(
    conversationId: number,
    filter: "all" | "limit_recovery" | "queued_or_recovery",
    reason: string,
  ): Promise<number> {
    const queuedToAbort: { id: string; submissionId?: string }[] = [];
    let cancelledCount = 0;

    await this.o.harness.commit(async (tx) => {
      // Fence even an in-flight parser with no schedule yet, and delayed observer callbacks.
      const boundary = await newestInputBoundary(tx, conversationId as ConversationId);
      const state = await tx.doc(RecoveryStateDoc);
      state.blockedThrough[String(conversationId)] = Math.max(state.blockedThrough[String(conversationId)] ?? -1, boundary);
      for (const attempt of Object.values(state.attempts)) {
        if (attempt.conversationId === conversationId && (attempt.status === "parsing" || attempt.status === "scheduled")) {
          attempt.status = "stopped"; attempt.reason = reason;
        }
      }
      const doc = await tx.doc(ScheduledMessagesDoc);
      for (const rec of Object.values(doc.schedules)) {
        if (rec.conversationId !== conversationId) continue;
        if (rec.status !== "scheduled" && rec.status !== "queued") continue;
        const match =
          filter === "all" ||
          (filter === "limit_recovery" && rec.source.kind === "limit_recovery") ||
          (filter === "queued_or_recovery" && (rec.status === "queued" || rec.source.kind === "limit_recovery"));
        if (!match) continue;
        if (rec.status === "scheduled") {
          rec.status = "cancelled";
          rec.terminalReason = reason;
          cancelledCount++;
        } else {
          queuedToAbort.push({ id: rec.id, submissionId: rec.submissionId });
        }
      }
    }, context);

    for (const item of queuedToAbort) {
      const res = await this.cancel(conversationId, item.id, reason);
      if (res.status === "cancelled") cancelledCount++;
    }

    if (cancelledCount > 0) await this.scheduleChanged();
    return cancelledCount;
  }

  async scheduleChanged(): Promise<void> {
    if (this.closed) return;
    await this.enqueueWork(() => this.reconcileAndArm());
  }

  private async reconcileAndArm(): Promise<void> {
    if (this.closed) return;
    await this.reconcile();
    await this.deliverDue();
    await this.armNext();
  }

  /** Rechecked again at admission so a newer same-route reset cannot lose a timer race. */
  private async preserveResetFloor(tx: Tx, rec: ScheduledMessageRecord): Promise<void> {
    if (rec.source.kind !== "limit_recovery") return;
    const policy = this.o.recoveryPolicy?.();
    const state = await tx.doc(RecoveryStateDoc);
    const floor = recoveryResetFloor(state, rec.source.provider, rec.source.model);
    if (floor && floor + (policy?.resetGraceSeconds ?? 60) * 1000 > rec.dueAt) {
      rec.dueAt = Math.ceil(floor + (policy?.resetGraceSeconds ?? 60) * 1000);
      rec.source.exact = false; rec.source.resetSource = "shared_provider_evidence";
    }
    if (policy && rec.dueAt - this.now() > policy.maxWaitHours * 3_600_000) {
      rec.status = "cancelled"; rec.terminalReason = "Reset time exceeds maxWaitHours.";
      const attempt = state.attempts[recoveryKey(rec.conversationId, rec.source.boundary)];
      if (attempt) { attempt.status = "stopped"; attempt.reason = rec.terminalReason; }
    }
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    await this.o.harness.commit(async (tx) => {
      const doc = await tx.doc(ScheduledMessagesDoc);
      for (const rec of Object.values(doc.schedules)) {
        if (rec.status === "scheduled" && rec.source.kind === "limit_recovery") {
          const policy = this.o.recoveryPolicy?.();
          await this.preserveResetFloor(tx, rec);
          if (rec.status !== "scheduled") continue;
          const eligible = await recoveryCandidate(tx, rec.conversationId as ConversationId,
            this.o.defaultModel?.() ?? { provider: rec.source.provider, modelId: rec.source.model });
          if (policy?.enabled === false || this.o.skip?.(rec.conversationId) || !eligible ||
            eligible.boundary !== rec.source.boundary || eligible.generation !== rec.source.generation) {
            rec.status = "cancelled"; rec.terminalReason = "Automatic recovery no longer matches the session or settings.";
          }
        }
        if (rec.status !== "queued") continue;
        const sub = await tx.submissionByRequest(rec.conversationId as ConversationId, rec.requestId);
        if (!sub) continue;
        applySubmission(rec, sub);
      }
      // Retire terminal records from every timer/agent scan without erasing dedup or user history.
      const requests = new Map<string, [string, { scheduleId: string; fingerprint: string }][]>();
      for (const [key, receipt] of Object.entries(doc.requests)) {
        const group = requests.get(receipt.scheduleId) ?? [];
        group.push([key, receipt]); requests.set(receipt.scheduleId, group);
      }
      for (const rec of Object.values(doc.schedules)) {
        if (rec.status === "scheduled" || rec.status === "queued") continue;
        const history = await tx.doc(ScheduledMessagesHistoryDoc, String(rec.conversationId), null);
        history.schedules[rec.id] = cloneRecord(rec);
        for (const [key, receipt] of requests.get(rec.id) ?? []) {
          history.requests[key] = { ...receipt }; delete doc.requests[key];
        }
        delete doc.schedules[rec.id];
      }
    }, context);
  }

  async deliverDue(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const dueIds = await this.o.harness.commit(async (tx) => {
      const doc = await tx.doc(ScheduledMessagesDoc);
      return Object.values(doc.schedules)
        .filter((s) => s.status === "scheduled" && Math.max(s.dueAt, s.nextDeliveryAt ?? 0) <= now)
        .sort(compareDue)
        .map((s) => s.id);
    }, context);

    for (const id of dueIds) {
      if (this.closed) return;
      await this.fireOne(id);
    }
    if (dueIds.length) await this.reconcile();
  }

  async fireOne(id: string): Promise<boolean> {
    if (this.closed) return false;
    const now = this.now();

    const pre = await this.o.harness.commit(async (tx) => {
      const doc = await tx.doc(ScheduledMessagesDoc);
      const rec = doc.schedules[id];
      if (!rec || rec.status !== "scheduled") return undefined;
      if (Math.max(rec.dueAt, rec.nextDeliveryAt ?? 0) > now) return undefined;
      return cloneRecord(rec);
    }, context);

    if (!pre) return false;

    if (this.o.skip?.(pre.conversationId)) {
      await this.o.harness.commit(async (tx) => {
        const doc = await tx.doc(ScheduledMessagesDoc);
        const rec = doc.schedules[id];
        if (rec && rec.status === "scheduled") {
          rec.status = "cancelled";
          rec.terminalReason = "Conversation skipped or archived.";
        }
      }, context);
      return false;
    }

    const conv = await this.o.harness.conversation(pre.conversationId as ConversationId, context);
    if (!conv) {
      await this.o.harness.commit(async (tx) => {
        const doc = await tx.doc(ScheduledMessagesDoc);
        const rec = doc.schedules[id];
        if (rec && rec.status === "scheduled") {
          rec.status = "cancelled";
          rec.terminalReason = "Conversation not found.";
        }
      }, context);
      return false;
    }

    try {
      const result = await this.o.harness.commit(async (tx) => {
        const doc = await tx.doc(ScheduledMessagesDoc);
        const rec = doc.schedules[id];
        if (!rec || rec.status !== "scheduled" || this.paused.has(rec.conversationId)) return "skip" as const;
        if (Math.max(rec.dueAt, rec.nextDeliveryAt ?? 0) > this.now()) return "skip" as const;
        if (this.o.skip?.(rec.conversationId)) {
          rec.status = "cancelled"; rec.terminalReason = "Conversation skipped or archived."; return "skip" as const;
        }
        if (rec.source.kind === "limit_recovery") {
          await this.preserveResetFloor(tx, rec);
          if (rec.status !== "scheduled" || Math.max(rec.dueAt, rec.nextDeliveryAt ?? 0) > this.now()) return "skip" as const;
          const eligible = await recoveryCandidate(tx, rec.conversationId as ConversationId,
            this.o.defaultModel?.() ?? { provider: rec.source.provider, modelId: rec.source.model });
          if (this.o.recoveryPolicy?.().enabled === false || !eligible ||
            eligible.boundary !== rec.source.boundary || eligible.generation !== rec.source.generation) {
            rec.status = "cancelled"; rec.terminalReason = "Automatic recovery invalidated before delivery."; return "skip" as const;
          }
        }

        const existingSub = await tx.submissionByRequest(pre.conversationId as ConversationId, rec.requestId);
        if (existingSub) {
          rec.submissionId = String(existingSub.id);
          applySubmission(rec, existingSub);
          return "reconciled" as const;
        }

        // Submit before any table write in this tx (ReadAfterWrite contract).
        const subId: SubmissionId = await conv.submit(tx, {
          type: "input",
          content: rec.content,
          requestId: rec.requestId,
          whenBusy: "followUp",
          entry: {
            kind: "luna.scheduled-message",
            data: { scheduleId: rec.id, source: rec.source.kind },
          },
        });
        rec.status = "queued";
        rec.submissionId = String(subId);
        return "admitted" as const;
      }, context);

      if (result === "admitted") {
        await this.reconcile();
        return true;
      }
      return false;
    } catch (e) {
      const msg = (e as Error).message || "Delivery failed";
      await this.o.harness.commit(async (tx) => {
        const doc = await tx.doc(ScheduledMessagesDoc);
        const rec = doc.schedules[id];
        if (!rec || rec.status !== "scheduled") return;
        const attempts = (rec.deliveryAttempts ?? 0) + 1;
        rec.deliveryAttempts = attempts;
        rec.lastError = msg.slice(0, 300);
        if (attempts > DELIVERY_BACKOFFS.length) {
          rec.status = "failed";
          rec.terminalReason = `Delivery failed: ${rec.lastError}`;
        } else {
          rec.nextDeliveryAt = now + DELIVERY_BACKOFFS[attempts - 1]!;
        }
      }, context);
      return false;
    }
  }

  private async armNext(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;

    const nextAt = await this.o.harness.commit(async (tx) => {
      const doc = await tx.doc(ScheduledMessagesDoc);
      let earliest: number | undefined;
      for (const s of Object.values(doc.schedules)) {
        if (s.status !== "scheduled" || this.paused.has(s.conversationId)) continue;
        const t = Math.max(s.dueAt, s.nextDeliveryAt ?? 0);
        if (earliest === undefined || t < earliest) earliest = t;
      }
      return earliest;
    }, context);

    if (nextAt === undefined) return;
    const delay = Math.max(0, nextAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueueWork(() => this.reconcileAndArm()).catch((e) =>
        this.o.log(`scheduled-messages: ${(e as Error).message}`),
      );
    }, Math.min(delay, MAX_TIMER));
    this.timer.unref?.();
  }
}
