import { type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { classifyLimit } from "./limit-reset.js";
import { ScheduledMessagesService } from "./scheduled-messages.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export type LimitRecoveryPolicy = {
  enabled: boolean;
  maxWaitHours: number;
};

export type LimitRecoveryFailure = {
  boundary: number;
  error: string;
  at: number;
  provider: string;
  model: string;
};

export type ResetTimeParseResult =
  | { kind: "reset_at"; resetAt: number; exact: boolean; source: "model_parse" | "deterministic" }
  | { kind: "no_reset_time"; reason: string };

export const RESET_TIME_MARGIN_MS = 60_000;

export class LimitRecoveryService {
  private observation: { detach(): void } | undefined;
  private closed = false;
  private work: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lastFailure = new Map<number, LimitRecoveryFailure>();

  constructor(
    private readonly o: {
      harness: Harness;
      scheduledMessages: ScheduledMessagesService;
      log: (m: string) => void;
      policy: () => LimitRecoveryPolicy;
      defaultModel: () => { provider: string; modelId: string };
      parseResetTime?: (input: {
        error: string;
        now: number;
        timezone: string;
        model: { provider: string; modelId: string };
      }) => Promise<{ resetAt?: number; exact?: boolean } | undefined>;
      now?: () => number;
      skip?: (id: number) => boolean;
      graceMs?: number;
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
        const failed = p.changes.filter(
          (ch) => ch.type === "submission" && ch.value.status === "unanswered",
        );
        if (failed.length === 0) return;
        for (const ch of failed) {
          if (ch.type !== "submission") continue;
          const convId = Number(ch.value.conversationId);
          queueMicrotask(() => {
            if (this.closed) return;
            void this.enqueueWork(() => this.handleFailedConversation(convId)).catch((e) =>
              this.o.log(`limit-recovery: ${(e as Error).message}`),
            );
          });
        }
      },
      end: () => {
        this.closed = true;
        queueMicrotask(() => void this.close());
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.observation?.detach();
    this.observation = undefined;
    await Promise.allSettled([...this.pending]);
  }

  lastFailureFor(conversationId: number): LimitRecoveryFailure | undefined {
    return this.lastFailure.get(conversationId);
  }

  private async handleFailedConversation(convId: number): Promise<void> {
    if (this.closed) return;
    if (this.o.skip?.(convId)) return;
    const policy = this.o.policy();
    if (!policy.enabled) return;

    const conv = await this.o.harness.conversation(convId as ConversationId, context);
    if (!conv) return;

    const entries = await conv.entries({}, 10, undefined, context);
    const latest = entries.items[0];
    // Prevent recovery chains: if the failed turn was itself triggered by a limit_recovery scheduled message, halt.
    for (const e of entries.items) {
      if (e.kind === "luna.scheduled-message") {
        const data = (e as { data?: { source?: string } }).data;
        if (data?.source === "limit_recovery") {
          this.lastFailure.set(convId, {
            boundary: Number(latest?.id ?? 0),
            error: "Limit recovery already attempted for this turn; halting to avoid retry chain.",
            at: this.now(),
            provider: this.o.defaultModel().provider,
            model: this.o.defaultModel().modelId,
          });
          return;
        }
        break;
      }
      if (e.kind === "input") break;
    }

    let errorMessage: string | undefined;
    let provider = this.o.defaultModel().provider;
    let model = this.o.defaultModel().modelId;

    const msg = entries.items
      .flatMap((e) => [...(e.model ?? [])] as { stopReason?: string; errorMessage?: string; provider?: string; model?: string }[])
      .find((m) => m.stopReason === "error" && m.errorMessage);
    if (msg?.errorMessage) {
      errorMessage = msg.errorMessage;
      provider = msg.provider ?? provider;
      model = msg.model ?? model;
    }
    if (!latest || !errorMessage) return;

    const now = this.now();
    const classified = classifyLimit(errorMessage, now);
    if (classified.kind !== "wait") {
      this.lastFailure.delete(convId);
      return;
    }

    const boundary = Number(latest.id);

    // Check if we already scheduled recovery for this boundary.
    const existing = await this.o.harness.commit((tx) => this.o.scheduledMessages.list(tx, convId), context);
    if (
      existing.some(
        (s) =>
          s.source.kind === "limit_recovery" &&
          s.source.boundary === boundary &&
          (s.status === "scheduled" || s.status === "queued" || s.status === "delivered"),
      )
    ) {
      return;
    }

    let parsed: ResetTimeParseResult;
    if (this.o.parseResetTime) {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const res = await this.o.parseResetTime({
          error: errorMessage,
          now,
          timezone: tz,
          model: this.o.defaultModel(),
        });
        if (res && typeof res.resetAt === "number" && Number.isFinite(res.resetAt) && res.resetAt > now) {
          parsed = { kind: "reset_at", resetAt: res.resetAt, exact: Boolean(res.exact), source: "model_parse" };
        } else if (classified.resetAt && classified.resetAt > now) {
          parsed = { kind: "reset_at", resetAt: classified.resetAt, exact: Boolean(classified.exact), source: "deterministic" };
        } else {
          parsed = { kind: "no_reset_time", reason: "No reset time could be parsed from the provider error." };
        }
      } catch {
        if (classified.resetAt && classified.resetAt > now) {
          parsed = { kind: "reset_at", resetAt: classified.resetAt, exact: Boolean(classified.exact), source: "deterministic" };
        } else {
          parsed = { kind: "no_reset_time", reason: "Reset-time parser failed and no deterministic reset time was present." };
        }
      }
    } else if (classified.resetAt && classified.resetAt > now) {
      parsed = { kind: "reset_at", resetAt: classified.resetAt, exact: Boolean(classified.exact), source: "deterministic" };
    } else {
      parsed = { kind: "no_reset_time", reason: "No reset time found in the provider error." };
    }

    if (parsed.kind === "no_reset_time") {
      this.lastFailure.set(convId, { boundary, error: parsed.reason, at: now, provider, model });
      return;
    }

    const dueAt = parsed.resetAt + (this.o.graceMs ?? RESET_TIME_MARGIN_MS);
    const maxWaitMs = policy.maxWaitHours * 3_600_000;
    if (dueAt - now > maxWaitMs) {
      this.lastFailure.set(convId, {
        boundary,
        error: `Reset time exceeds maxWaitHours (${policy.maxWaitHours}h).`,
        at: now,
        provider,
        model,
      });
      return;
    }

    if (this.closed || this.o.skip?.(convId)) return;
    const latestAfter = (await conv.entries({}, 1, undefined, context)).items[0];
    if (!latestAfter || Number(latestAfter.id) !== boundary) return;

    this.lastFailure.delete(convId);
    await this.o.harness.commit(async (tx: Tx) => {
      const current = await this.o.scheduledMessages.list(tx, convId);
      if (
        current.some(
          (s) =>
            s.source.kind === "limit_recovery" &&
            s.source.boundary === boundary &&
            (s.status === "scheduled" || s.status === "queued" || s.status === "delivered"),
        )
      ) {
        return;
      }
      await this.o.scheduledMessages.create(tx, {
        conversationId: convId,
        content: "Continue",
        dueAt,
        requestId: `limit-recovery:${convId}:${boundary}`,
        source: {
          kind: "limit_recovery",
          boundary,
          generation: 1,
          provider,
          model,
          exact: parsed.exact,
          resetSource: parsed.source,
        },
      });
    }, context);
    await this.o.scheduledMessages.scheduleChanged();
  }
}
