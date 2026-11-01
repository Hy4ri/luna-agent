// Automatic continuation for top-level conversations. Saved waits remain until submission is confirmed.
import { AgentDoc, InboxDoc, defineDoc, type ConversationId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import { AskDoc } from "./ask.js";
import { classifyLimit } from "./limit-reset.js";
import { latestLimitReset, type ProviderLimit } from "./provider-limits.js";
import { context } from "./luna.js";
import { newestInputBoundary, readTurnFailure, SessionHandoffDoc } from "./session-status.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export type AutoContinuePolicy = {
  enabled: boolean;
  maxWaitHours: number;
  maxAttempts: number;
};

export type LimitWait = {
  boundary: number;
  resumeAt: number;
  attempt: number;
  reason: string;
  exact: boolean;
  generation?: number;
  provider?: string;
  model?: string;
  firstFailedAt?: number;
  deadline?: number;
  resetSource?: string;
  jitterMs?: number;
  deliveryAttempts?: number;
  nextDeliveryAt?: number;
  deliveryPausedReason?: string;
};

export type RecoveryChain = {
  boundary: number;
  generation: number;
  provider: string;
  model: string;
  firstFailedAt: number;
  deadline: number;
  attemptsAdmitted: number;
  requestId: string;
  entry?: number;
  resetSource?: string;
  lastOutcome?: "scheduled" | "admitted" | "paused" | "failed";
  deliveryAttempts: number;
  nextDeliveryAt?: number;
  deliveryPausedReason?: string;
  cancelled?: boolean;
};

export type RouteClaim = {
  activeSessionId?: number;
  activeRequestId?: string;
  claimedAt?: number;
  cooldownUntil?: number;
};

export type LimitWaitsDocValue = {
  waits: Record<string, LimitWait>;
  chains?: Record<string, RecoveryChain>;
  routes?: Record<string, RouteClaim>;
};

export const LimitWaitsDoc = defineDoc<LimitWaitsDocValue>({
  checkpointWhen: () => false,
  kind: "luna.limit-waits",
  version: 1,
  scope: "session",
  initial: () => ({ waits: {}, chains: {}, routes: {} }),
});

export const CONTINUATION_TAG = "limit_continuation";
export const continuationText = (attempt: number, exact = true) =>
  `<${CONTINUATION_TAG} attempt="${attempt}"/> ${exact ? "The reported usage-limit reset time has passed." : "The retry delay has passed; quota availability is not confirmed."} Continue your work from where you stopped.`;

const MAX_TIMER = 2 ** 31 - 1;

export type RecoverySummary = {
  active: boolean;
  resumeAt?: number;
  attempt: number;
  maxAttempts: number;
  exact: boolean;
  source?: string;
  pausedReason?: string;
  provider?: string;
  model?: string;
};

export async function readLimitRecovery(tx: Tx, id: ConversationId, configuredMaxAttempts?: number): Promise<RecoverySummary | undefined> {
  const doc = await tx.doc(LimitWaitsDoc);
  const sid = String(id);
  const w = doc.waits[sid];
  const chain = doc.chains?.[sid];
  const currentBoundary = await newestInputBoundary(tx, id);

  if (w && w.boundary === currentBoundary) {
    const effectiveResumeAt = Math.max(w.resumeAt, w.nextDeliveryAt ?? 0);
    return {
      active: true,
      resumeAt: effectiveResumeAt,
      attempt: w.attempt,
      maxAttempts: configuredMaxAttempts ?? (chain ? Math.max(chain.attemptsAdmitted, w.attempt) : w.attempt),
      exact: w.exact,
      source: w.resetSource,
      provider: w.provider,
      model: w.model,
    };
  }

  if (chain && chain.boundary === currentBoundary) {
    return {
      active: false,
      attempt: chain.attemptsAdmitted,
      maxAttempts: configuredMaxAttempts ?? chain.attemptsAdmitted,
      exact: false,
      source: chain.resetSource,
      pausedReason: chain.deliveryPausedReason ?? (chain.lastOutcome === "paused" ? "Limit recovery paused" : undefined),
      provider: chain.provider,
      model: chain.model,
    };
  }

  return undefined;
}

async function busy(tx: Tx, id: ConversationId) {
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    if ((await tx.scanTasks({ conversationId: id, status, background: false }, 1)).items.length) return true;
  }
  return false;
}

async function isChild(tx: Tx, id: ConversationId) {
  const conv = await tx.conversation(id);
  if (!conv) return true;
  if (conv.owner) return true;
  const after = conv.parent ? { minEntryId: (Number(conv.parent.at) + 1) as never } : {};
  return (await tx.scanEntries({ conversationId: id, order: "ascending", ...after }, 30)).items.some(e => e.kind === "delegate.child");
}

type ClassifiedLimit = {
  kind: "wait" | "fatal" | "none";
  resetAt?: number;
  resetSource?: string;
  exact?: boolean;
};

function classifyTurnLimit(failure: NonNullable<Awaited<ReturnType<typeof readTurnFailure>>>, failedAt: number): ClassifiedLimit {
  const extLimit = failure.limit as (ProviderLimit & { receivedAt?: number; response?: string }) | undefined;
  const responseText = extLimit?.response ?? failure.message;
  const fallback = classifyLimit(responseText, failedAt) as ClassifiedLimit;
  const structuredReset = extLimit && latestLimitReset(extLimit);
  const hasUnknownStructuredWindow = extLimit?.kind === "wait" && extLimit.windows.some(w => w.resetAt === null);

  if (fallback.kind === "fatal" || extLimit?.kind === "fatal") {
    return { kind: "fatal" };
  }
  if (structuredReset !== undefined) {
    return {
      kind: "wait",
      resetAt: structuredReset,
      resetSource: fallback.resetSource ?? "quota_timestamp",
      exact: !hasUnknownStructuredWindow,
    };
  }
  if (fallback.kind === "wait") {
    return {
      kind: "wait",
      resetAt: fallback.resetAt,
      resetSource: fallback.resetSource ?? "message",
      exact: fallback.resetAt !== undefined && !hasUnknownStructuredWindow && (fallback.exact ?? false),
    };
  }
  if (extLimit?.kind === "wait") {
    return {
      kind: "wait",
      resetAt: undefined,
      resetSource: "unknown_window",
      exact: false,
    };
  }
  return fallback;
}

function computeEvidenceFloor(
  cls: ClassifiedLimit,
  extLimit: (ProviderLimit & { receivedAt?: number; response?: string }) | undefined,
  failedAt: number,
  graceForEvidence: number,
  firstBackoffMs: number,
): number {
  const hasUnknownStructuredWindow = extLimit?.kind === "wait" && extLimit.windows.some(w => w.resetAt === null);
  const knownWindow = extLimit?.windows.reduce((latest, window) => Math.max(latest, window.resetAt ?? 0), 0) ?? 0;
  const uncertainEvidence = hasUnknownStructuredWindow || cls.resetAt === undefined || cls.resetAt <= failedAt;
  return Math.max(
    cls.resetAt !== undefined ? cls.resetAt + graceForEvidence : 0,
    knownWindow ? knownWindow + graceForEvidence : 0,
    uncertainEvidence ? failedAt + firstBackoffMs : 0,
  );
}

function resolveWaitTiming(
  cls: ClassifiedLimit,
  extLimit: (ProviderLimit & { receivedAt?: number; response?: string }) | undefined,
  failedAt: number,
  attempt: number,
  now: number,
  routeCooldown: number,
  backoff: number[],
  grace: number,
  jitterMs: number,
): { resumeAt: number; isExact: boolean } {
  const hasUnknownStructuredWindow = extLimit?.kind === "wait" && extLimit.windows.some(w => w.resetAt === null);
  const knownReset = extLimit?.kind === "wait"
    ? extLimit.windows.reduce((latest, w) => Math.max(latest, w.resetAt ?? 0), 0)
    : 0;

  if (hasUnknownStructuredWindow || cls.resetAt === undefined || cls.resetAt <= failedAt) {
    const fallbackStep = backoff[Math.min(attempt, backoff.length) - 1]!;
    const minResume = Math.max(
      failedAt + fallbackStep,
      knownReset ? knownReset + grace : 0,
      cls.resetAt !== undefined ? cls.resetAt + grace : 0,
      routeCooldown,
    );
    return {
      resumeAt: Math.max(minResume, now) + jitterMs,
      isExact: false,
    };
  }

  const isExact = cls.exact ?? true;
  const repeatedFailureFloor = attempt > 1 ? failedAt + backoff[Math.min(attempt, backoff.length) - 1]! : 0;
  return {
    resumeAt: Math.max(cls.resetAt + grace, now, routeCooldown, repeatedFailureFloor) + jitterMs,
    isExact,
  };
}

function releaseActiveClaim(claim: RouteClaim | undefined): void {
  if (!claim) return;
  delete claim.activeSessionId;
  delete claim.activeRequestId;
  delete claim.claimedAt;
}

function pauseChain(
  doc: LimitWaitsDocValue,
  id: number | string,
  params: {
    boundary: number;
    generation: number;
    provider: string;
    model: string;
    firstFailedAt: number;
    deadline: number;
    attemptsAdmitted: number;
    resetSource?: string;
    reason: string;
  },
): void {
  const sid = String(id);
  doc.chains ??= {};
  doc.chains[sid] = {
    boundary: params.boundary,
    generation: params.generation,
    provider: params.provider,
    model: params.model,
    firstFailedAt: params.firstFailedAt,
    deadline: params.deadline,
    attemptsAdmitted: params.attemptsAdmitted,
    requestId: requestId(Number(id), { boundary: params.boundary, generation: params.generation } as LimitWait),
    resetSource: params.resetSource,
    lastOutcome: "paused",
    deliveryAttempts: 0,
    deliveryPausedReason: params.reason,
    cancelled: true,
  };
  delete doc.waits[sid];
}

async function pruneStaleReferences(tx: Tx, doc: LimitWaitsDocValue): Promise<void> {
  const ids = new Set([...Object.keys(doc.waits), ...Object.keys(doc.chains ?? {}),
    ...Object.values(doc.routes ?? {}).flatMap(route => route.activeSessionId ? [String(route.activeSessionId)] : [])]);
  for (const id of ids) {
    if (await tx.conversation(Number(id) as ConversationId)) continue;
    delete doc.waits[id];
    delete doc.chains?.[id];
    for (const claim of Object.values(doc.routes ?? {})) {
      if (String(claim.activeSessionId) !== id) continue;
      releaseActiveClaim(claim);
    }
  }
}

async function reconcileActiveRouteClaims(tx: Tx, doc: LimitWaitsDocValue, now: number, graceMs: number): Promise<void> {
  for (const claim of Object.values(doc.routes ?? {})) {
    if (claim.activeSessionId && claim.activeRequestId) {
      const sub = await tx.submissionByRequest(claim.activeSessionId as ConversationId, claim.activeRequestId);
      const waiting = doc.waits[String(claim.activeSessionId)];
      const pendingDelivery = !sub && waiting && requestId(claim.activeSessionId, waiting) === claim.activeRequestId;
      const stillActive = sub?.status === "queued" || sub?.status === "placed" || !!pendingDelivery;
      if (sub && !stillActive) {
        // Every settled probe, including a non-quota failure, gets spacing. check() has
        // already recorded a later quota reset before this claim can be released.
        claim.cooldownUntil = Math.max(claim.cooldownUntil ?? 0, now + graceMs);
      }
      if (!stillActive) {
        releaseActiveClaim(claim);
      }
    }
  }
}

async function reconcileWaitEntry(
  tx: Tx,
  doc: LimitWaitsDocValue,
  id: string,
  w: LimitWait,
  now: number,
  policy: AutoContinuePolicy,
  effectiveDeadline: (savedDeadline: number | undefined, firstFailedAt: number | undefined) => number,
  modelRef: (tx: Tx, cid: ConversationId) => Promise<ModelRef>,
  skip?: (id: number) => boolean,
): Promise<LimitWait | undefined> {
  const numId = Number(id);
  const cid = numId as ConversationId;

  if (!w.generation || !w.provider || !w.model || skip?.(numId)) {
    delete doc.waits[id];
    return undefined;
  }

  doc.chains ??= {};
  if (!doc.chains[id]) {
    const failure = await readTurnFailure(tx, cid);
    const firstFailedAt = w.firstFailedAt ?? failure?.failedAt;
    // A later legacy attempt cannot prove its original lifetime. Pause, do not grant a fresh budget.
    const uncertain = firstFailedAt === undefined || (w.firstFailedAt === undefined && w.attempt > 1);
    doc.chains[id] = {
      boundary: w.boundary, generation: w.generation, provider: w.provider, model: w.model,
      firstFailedAt: firstFailedAt ?? now, deadline: w.deadline ?? (firstFailedAt ?? now) + policy.maxWaitHours * 3_600_000,
      attemptsAdmitted: Math.max(0, w.attempt - 1), requestId: requestId(numId, w), deliveryAttempts: w.deliveryAttempts ?? 0,
      lastOutcome: uncertain ? "paused" : "scheduled", cancelled: uncertain,
      ...(uncertain ? { deliveryPausedReason: "Legacy recovery lifetime cannot be verified. Retry manually." } : {}),
    };
    w.firstFailedAt = firstFailedAt ?? now;
    w.deadline = doc.chains[id].deadline;
  }

  const reqId = requestId(numId, w);
  const existingSub = await tx.submissionByRequest(cid, reqId);
  if (existingSub) {
    const chain = doc.chains[id];
    if (chain) {
      chain.attemptsAdmitted = Math.max(chain.attemptsAdmitted, w.attempt);
      chain.lastOutcome = "admitted";
      if (existingSub.entry !== undefined) {
        chain.entry = Number(existingSub.entry);
      }
    }
    delete doc.waits[id];
    return undefined;
  }

  const currentBoundary = await newestInputBoundary(tx, cid);
  if (w.boundary !== currentBoundary || await needsUser(tx, cid, w.boundary)) {
    delete doc.waits[id];
    return undefined;
  }

  const ref = await modelRef(tx, cid);
  if (w.provider !== ref.provider || w.model !== ref.modelId) {
    delete doc.waits[id];
    return undefined;
  }

  const chain = doc.chains[id];
  const deadline = effectiveDeadline(w.deadline ?? chain?.deadline, w.firstFailedAt ?? chain?.firstFailedAt);

  if (chain?.cancelled) {
    delete doc.waits[id];
    return undefined;
  }

  if (w.attempt > policy.maxAttempts || Math.max(now, w.resumeAt, w.nextDeliveryAt ?? 0) > deadline) {
    if (chain) {
      chain.lastOutcome = "paused";
      chain.deliveryPausedReason = w.attempt > policy.maxAttempts ? "Max attempts exceeded" : "Max recovery deadline exceeded";
    }
    delete doc.waits[id];
    return undefined;
  }

  return { ...w };
}

async function needsUser(tx: Tx, id: ConversationId, boundary: number) {
  if ((await tx.doc(InboxDoc, id)).items.length) return true;
  const ask = await tx.doc(AskDoc, id);
  if (ask.pending.some(q => !ask.answers[q.callId])) return true;
  return (await tx.doc(SessionHandoffDoc, id)).handoff?.boundary === boundary;
}

export async function readLimitWait(tx: Tx, id: ConversationId): Promise<LimitWait | undefined> {
  const w = (await tx.doc(LimitWaitsDoc)).waits[String(id)];
  if (!w || w.boundary !== await newestInputBoundary(tx, id)) return undefined;
  return { ...w, resumeAt: Math.max(w.resumeAt, w.nextDeliveryAt ?? 0) };
}

const requestId = (id: number, w: LimitWait) => `limit-continue-${id}-${w.boundary}-${w.generation}`;
const sameWait = (a: LimitWait | undefined, b: LimitWait) => a?.boundary === b.boundary && a.generation === b.generation;
const routeKey = (provider?: string, model?: string) => JSON.stringify([provider ?? "", model ?? ""]);

const LOCAL_DELIVERY_BACKOFFS = [30_000, 120_000, 600_000];

function isGuardRejection(error: unknown): boolean {
  return error instanceof Error && error.name === "SubmissionGuardRejected";
}


export class LimitContinuer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stop?: () => void;
  private closed = false;
  private recovering = false;
  private events: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly firing = new Set<number>();

  constructor(private readonly o: {
    harness: Harness;
    policy: () => AutoContinuePolicy;
    log: (m: string) => void;
    defaultModel: () => ModelRef;
    skip?: (id: number) => boolean;
    now?: () => number;
    graceMs?: number;
    backoffMs?: number[];
  }) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  enabled() { return this.o.policy().enabled; }
  attemptLimit() { return this.o.policy().maxAttempts; }
  private track<T>(p: Promise<T>) { this.pending.add(p); void p.finally(() => this.pending.delete(p)).catch(() => {}); return p; }
  private async model(tx: Tx, id: ConversationId) { return (await tx.doc(AgentDoc, id)).model ?? this.o.defaultModel(); }

  async recovery(tx: Tx, id: ConversationId): Promise<RecoverySummary | undefined> {
    return readLimitRecovery(tx, id, this.o.policy().maxAttempts);
  }

  private effectiveDeadline(savedDeadline: number | undefined, firstFailedAt: number | undefined): number {
    const policy = this.o.policy();
    const policyLifetime = policy.maxWaitHours * 3_600_000;
    const policyDeadline = (firstFailedAt ?? this.now()) + policyLifetime;
    return savedDeadline ? Math.min(savedDeadline, policyDeadline) : policyDeadline;
  }

  private async eligible(tx: Tx, id: number, w: LimitWait, admission = false): Promise<boolean> {
    const cid = id as ConversationId, policy = this.o.policy();
    if (this.closed || !policy.enabled || w.attempt > policy.maxAttempts || this.o.skip?.(id) || !w.generation) return false;
    const doc = await tx.doc(LimitWaitsDoc);
    if (!sameWait(doc.waits[String(id)], w) || await isChild(tx, cid)) return false;

    const chain = doc.chains?.[String(id)];
    const deadline = this.effectiveDeadline(w.deadline ?? chain?.deadline, w.firstFailedAt ?? chain?.firstFailedAt);
    if (chain?.cancelled || this.now() > deadline) return false;

    const rKey = routeKey(w.provider, w.model);
    const route = doc.routes?.[rKey];
    if (admission && (route?.activeSessionId !== id || route.activeRequestId !== requestId(id, w) ||
      Math.max(route.cooldownUntil ?? 0, w.resumeAt, w.nextDeliveryAt ?? 0) > this.now())) return false;

    const failure = await readTurnFailure(tx, cid), ref = await this.model(tx, cid);
    return failure?.generation === w.generation && failure.boundary === w.boundary &&
      ref.provider === w.provider && ref.modelId === w.model &&
      await newestInputBoundary(tx, cid) === w.boundary && !await needsUser(tx, cid, w.boundary) && !await busy(tx, cid);
  }

  async start() {
    this.recovering = true;
    this.stop = this.o.harness.subscribeCommits(p => {
      let needsReconcile = false;
      const candidates = new Set<number>();

      for (const ch of p.changes) {
        if (ch.type === "task" && !ch.value.owner && ch.value.state.status === "terminal") {
          const cidNum = Number(ch.value.conversationId);
          if (ch.value.kind === "pi.generation" || !ch.value.background) {
            candidates.add(cidNum);
            needsReconcile = true;
          }
        } else if (ch.type === "submission" && ch.value.status !== "queued") {
          needsReconcile = true;
        }
      }

      if (needsReconcile) {
        // Store fresh quota evidence before releasing a settled route to another waiter.
        this.events = this.events.catch(() => {}).then(async () => {
          for (const id of candidates) await this.check(id);
          await this.reconcile();
        });
        void this.track(this.events).catch(e => this.o.log(`auto-continue: ${(e as Error).message}`));
      }
    });

    try {
      const recovered = await this.o.harness.commit(async tx => {
        const doc = await tx.doc(LimitWaitsDoc);
        return Object.values(doc.routes ?? {}).flatMap(route => route.activeSessionId ? [route.activeSessionId] : []);
      }, context);
      // Reconcile admission receipts first, then recover any missed terminal notification.
      await this.reconcile();
      for (const id of recovered) await this.check(id);
    } finally {
      this.recovering = false;
    }
    await this.reconcile();
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    const policy = this.o.policy();

    const snapshot = await this.o.harness.commit(async tx => {
      const doc = await tx.doc(LimitWaitsDoc);
      doc.chains ??= {};
      doc.routes ??= {};

      // Session-scoped recovery survives hard deletion of individual conversations.
      // Prune stale references before reading their transcript or migrating legacy waits.
      await pruneStaleReferences(tx, doc);

      if (!policy.enabled) {
        for (const id of Object.keys(doc.waits)) {
          const chain = doc.chains[id];
          if (chain) {
            chain.lastOutcome = "paused";
            chain.deliveryPausedReason = "Automatic continuation disabled";
            chain.cancelled = true;
          }
          delete doc.waits[id];
        }
        for (const chain of Object.values(doc.chains)) {
          chain.cancelled = true;
          if (chain.lastOutcome !== "admitted") {
            chain.lastOutcome = "paused";
            chain.deliveryPausedReason = "Automatic continuation disabled";
          }
        }
        for (const [rKey, claim] of Object.entries(doc.routes)) {
          if (claim.activeSessionId && claim.activeRequestId) {
            const sub = await tx.submissionByRequest(claim.activeSessionId as ConversationId, claim.activeRequestId);
            if (sub?.status !== "queued" && sub?.status !== "placed") delete doc.routes[rKey];
          } else {
            delete doc.routes[rKey];
          }
        }
        return { waits: {} as Record<string, LimitWait> };
      }

      await reconcileActiveRouteClaims(tx, doc, now, this.o.graceMs ?? 60_000);

      for (const w of Object.values(doc.waits)) {
        const rKey = routeKey(w.provider, w.model);
        const cooldown = doc.routes[rKey]?.cooldownUntil ?? 0;
        if (cooldown > w.resumeAt) {
          w.resumeAt = cooldown;
        }
      }

      const validWaits: Record<string, LimitWait> = {};
      for (const [id, w] of Object.entries(doc.waits)) {
        const validated = await reconcileWaitEntry(
          tx, doc, id, w, now, policy,
          (s, f) => this.effectiveDeadline(s, f),
          (t, cid) => this.model(t, cid),
          this.o.skip,
        );
        if (validated) validWaits[id] = validated;
      }

      for (const id of Object.keys(doc.chains)) {
        if (!await tx.conversation(Number(id) as ConversationId)) delete doc.chains[id];
      }

      for (const [rKey, claim] of Object.entries(doc.routes)) {
        const anyWait = Object.values(doc.waits).some(w => routeKey(w.provider, w.model) === rKey);
        if (!anyWait && !claim.activeSessionId) {
          delete doc.routes[rKey];
        }
      }

      return { waits: validWaits };
    }, context);

    for (const id of this.timers.keys()) {
      if (!snapshot.waits[id]) {
        clearTimeout(this.timers.get(id));
        this.timers.delete(id);
      }
    }

    for (const [id, w] of Object.entries(snapshot.waits)) {
      this.arm(id, w);
    }
  }

  async check(id: number): Promise<LimitWait | undefined> {
    if (this.closed || !this.enabled() || this.o.skip?.(id)) return undefined;
    const now = this.now();

    const wait = await this.o.harness.commit(async tx => {
      const cid = id as ConversationId;
      if (await isChild(tx, cid) || await busy(tx, cid)) return undefined;
      const failure = await readTurnFailure(tx, cid);
      if (!failure || await needsUser(tx, cid, failure.boundary)) return undefined;
      const policy = this.o.policy();
      if (!policy.enabled || this.o.skip?.(id)) return undefined;

      const extLimit = failure.limit as (ProviderLimit & { receivedAt?: number; response?: string }) | undefined;
      const failedAt = extLimit?.receivedAt ?? failure.failedAt ?? now;
      const cls = classifyTurnLimit(failure, failedAt);

      if (cls.kind !== "wait") return undefined;

      const ref = await this.model(tx, cid);
      if (failure.provider && (failure.provider !== ref.provider || failure.model !== ref.modelId)) return undefined;

      const doc = await tx.doc(LimitWaitsDoc);
      doc.chains ??= {};
      doc.routes ??= {};

      // Quota evidence applies to all waiters, even if this session was cancelled or exhausted its budget.
      const observedRoute = routeKey(ref.provider, ref.modelId);
      const graceForEvidence = this.o.graceMs ?? 60_000;
      const evidenceFloor = computeEvidenceFloor(
        cls,
        extLimit,
        failedAt,
        graceForEvidence,
        this.o.backoffMs?.[0] ?? 120_000,
      );
      const observed = doc.routes[observedRoute];
      doc.routes[observedRoute] = { ...observed, cooldownUntil: Math.max(observed?.cooldownUntil ?? 0, evidenceFloor) };

      const existingWait = doc.waits[String(id)];
      if (existingWait?.generation === failure.generation) return undefined;

      const chain = doc.chains[String(id)];
      if (chain?.generation === failure.generation && (chain.cancelled || chain.lastOutcome === "paused")) {
        return undefined;
      }

      let attempt = 1;
      let firstFailedAt = failedAt;
      let chainDeadline = failedAt + policy.maxWaitHours * 3_600_000;
      let priorAdmitted = 0;

      if (chain) {
        const priorSub = await tx.submissionByRequest(cid, chain.requestId);
        const matchesPriorEntry = priorSub?.entry !== undefined && Number(priorSub.entry) === failure.boundary;

        // Anti-resurrection: if previous chain was cancelled and this failure stems from its continuation, do not resurrect!
        if (chain.cancelled && (matchesPriorEntry || chain.boundary === failure.boundary)) {
          return undefined;
        }

        if (matchesPriorEntry) {
          // The previous submit can settle before its acknowledgement cleanup runs.
          priorAdmitted = Math.max(chain.attemptsAdmitted,
            existingWait?.generation === chain.generation ? existingWait.attempt : 0);
          attempt = priorAdmitted + 1;
          firstFailedAt = chain.firstFailedAt;
          chainDeadline = chain.deadline;
        } else if (chain.boundary === failure.boundary) {
          attempt = chain.attemptsAdmitted + 1;
          firstFailedAt = chain.firstFailedAt;
          chainDeadline = chain.deadline;
          priorAdmitted = chain.attemptsAdmitted;
        }
      } else if (existingWait && existingWait.boundary === failure.boundary) {
        attempt = existingWait.attempt + 1;
        firstFailedAt = existingWait.firstFailedAt ?? failedAt;
        chainDeadline = existingWait.deadline ?? (firstFailedAt + policy.maxWaitHours * 3_600_000);
        priorAdmitted = existingWait.attempt;
      }

      if (attempt > policy.maxAttempts) {
        this.o.log(`auto-continue ${id}: stopped after ${policy.maxAttempts} attempts`);
        pauseChain(doc, id, {
          boundary: failure.boundary,
          generation: failure.generation,
          provider: ref.provider,
          model: ref.modelId,
          firstFailedAt,
          deadline: chainDeadline,
          attemptsAdmitted: priorAdmitted,
          resetSource: cls.resetSource,
          reason: `Stopped after ${policy.maxAttempts} attempts`,
        });
        return undefined;
      }

      const deadline = this.effectiveDeadline(chainDeadline, firstFailedAt);
      if (now > deadline) {
        this.o.log(`auto-continue ${id}: stopped after reaching maxWaitHours deadline`);
        pauseChain(doc, id, {
          boundary: failure.boundary,
          generation: failure.generation,
          provider: ref.provider,
          model: ref.modelId,
          firstFailedAt,
          deadline,
          attemptsAdmitted: priorAdmitted,
          resetSource: cls.resetSource,
          reason: "Recovery lifetime deadline exceeded",
        });
        return undefined;
      }

      const backoff = this.o.backoffMs ?? [2, 10, 30, 60].map(m => m * 60_000);
      const grace = this.o.graceMs ?? 60_000;
      const jitterMs = Math.floor(Math.random() * 30_000);

      const rKey = routeKey(ref.provider, ref.modelId);
      const route = doc.routes[rKey];
      const routeCooldown = route?.cooldownUntil ?? 0;

      const { resumeAt, isExact } = resolveWaitTiming(
        cls,
        extLimit,
        failedAt,
        attempt,
        now,
        routeCooldown,
        backoff,
        grace,
        jitterMs,
      );

      doc.routes[rKey] = { ...route, cooldownUntil: Math.max(routeCooldown, resumeAt) };

      if (resumeAt > deadline || (resumeAt - now > policy.maxWaitHours * 3_600_000)) {
        this.o.log(`auto-continue ${id}: reset exceeds the recovery time limit`);
        pauseChain(doc, id, {
          boundary: failure.boundary,
          generation: failure.generation,
          provider: ref.provider,
          model: ref.modelId,
          firstFailedAt,
          deadline,
          attemptsAdmitted: priorAdmitted,
          resetSource: cls.resetSource,
          reason: "Scheduled resume is beyond maxWaitHours",
        });
        return undefined;
      }

      const w: LimitWait = {
        boundary: failure.boundary,
        generation: failure.generation,
        provider: ref.provider,
        model: ref.modelId,
        resumeAt,
        attempt,
        reason: failure.message.slice(0, 300),
        exact: isExact,
        firstFailedAt,
        deadline,
        resetSource: cls.resetSource,
        jitterMs,
        deliveryAttempts: 0,
        nextDeliveryAt: resumeAt,
      };

      doc.waits[String(id)] = w;

      doc.chains[String(id)] = {
        boundary: failure.boundary,
        generation: failure.generation,
        provider: ref.provider,
        model: ref.modelId,
        firstFailedAt,
        deadline,
        attemptsAdmitted: priorAdmitted,
        requestId: requestId(id, w),
        resetSource: cls.resetSource,
        lastOutcome: "scheduled",
        deliveryAttempts: 0,
        nextDeliveryAt: resumeAt,
        cancelled: false,
      };

      return { ...w };
    }, context);

    if (wait) {
      this.arm(String(id), wait);
      this.o.log(`auto-continue ${id}: attempt ${wait.attempt} at ${new Date(wait.resumeAt).toISOString()}`);
    }
    return wait;
  }

  private arm(id: string, w: LimitWait, retryMs = 0) {
    clearTimeout(this.timers.get(id));
    if (this.closed || this.recovering) return;
    const targetAt = Math.max(w.resumeAt, w.nextDeliveryAt ?? 0);
    const delay = Math.max(retryMs, targetAt - this.now(), 0);
    const t = setTimeout(() => {
      this.timers.delete(id);
      if (delay > MAX_TIMER) return this.arm(id, w);
      void this.track(this.fire(Number(id), w.boundary)).catch(e => this.o.log(`auto-continue ${id}: ${(e as Error).message}`));
    }, Math.min(delay, MAX_TIMER));
    t.unref?.();
    this.timers.set(id, t);
  }

  async fire(id: number, boundary: number): Promise<boolean> {
    if (this.closed || this.firing.has(id)) return false;
    this.firing.add(id);

    try {
      const now = this.now();
      const conv = await this.o.harness.conversation(id as ConversationId, context);
      if (!conv) {
        await this.o.harness.commit(async tx => {
          const doc = await tx.doc(LimitWaitsDoc);
          delete doc.waits[String(id)];
        }, context);
        return false;
      }

      const claimed = await this.o.harness.commit(async tx => {
        const doc = await tx.doc(LimitWaitsDoc);
        doc.routes ??= {};
        doc.chains ??= {};
        const w = doc.waits[String(id)];
        if (!w || w.boundary !== boundary) return undefined;

        const chain = doc.chains[String(id)];
        const deadline = this.effectiveDeadline(w.deadline ?? chain?.deadline, w.firstFailedAt ?? chain?.firstFailedAt);
        if (now > deadline) {
          if (chain) {
            chain.lastOutcome = "paused";
            chain.deliveryPausedReason = "Recovery lifetime deadline exceeded";
          }
          delete doc.waits[String(id)];
          return undefined;
        }

        const reqId = requestId(id, w);
        const priorSub = await tx.submissionByRequest(id as ConversationId, reqId);
        if (priorSub) {
          if (chain) {
            chain.attemptsAdmitted = Math.max(chain.attemptsAdmitted, w.attempt);
            chain.lastOutcome = "admitted";
            if (priorSub.entry !== undefined) chain.entry = Number(priorSub.entry);
          }
          delete doc.waits[String(id)];
          return undefined;
        }

        if (!await this.eligible(tx, id, w)) {
          delete doc.waits[String(id)];
          return undefined;
        }

        const rKey = routeKey(w.provider, w.model);
        const rClaim = doc.routes[rKey];
        const routeCooldown = rClaim?.cooldownUntil ?? 0;
        const effectiveWaitTime = Math.max(w.resumeAt, w.nextDeliveryAt ?? 0, routeCooldown);

        if (effectiveWaitTime > now) {
          w.resumeAt = effectiveWaitTime;
          w.nextDeliveryAt = effectiveWaitTime;
          return { wait: { ...w }, notYet: true };
        }

        if (rClaim?.activeSessionId && rClaim.activeSessionId !== id && rClaim.activeRequestId) {
          const activeSub = await tx.submissionByRequest(rClaim.activeSessionId as ConversationId, rClaim.activeRequestId);
          const pendingWait = doc.waits[String(rClaim.activeSessionId)];
          if (activeSub?.status === "queued" || activeSub?.status === "placed" ||
            !activeSub && pendingWait && requestId(rClaim.activeSessionId, pendingWait) === rClaim.activeRequestId) {
            const spacedResumeAt = now + (this.o.graceMs ?? 60_000);
            w.resumeAt = spacedResumeAt;
            w.nextDeliveryAt = spacedResumeAt;
            return { wait: { ...w }, notYet: true };
          }
        }

        for (const [otherIdStr, otherW] of Object.entries(doc.waits)) {
          const otherId = Number(otherIdStr);
          if (otherId === id) continue;
          if (routeKey(otherW.provider, otherW.model) === rKey) {
            const otherEffective = Math.max(otherW.resumeAt, otherW.nextDeliveryAt ?? 0);
            if (otherEffective <= now) {
              if (otherEffective < effectiveWaitTime || (otherEffective === effectiveWaitTime && otherId < id)) {
                const spacedResumeAt = now + (this.o.graceMs ?? 60_000);
                w.resumeAt = spacedResumeAt;
                w.nextDeliveryAt = spacedResumeAt;
                return { wait: { ...w }, notYet: true };
              }
            }
          }
        }

        doc.routes[rKey] = {
          activeSessionId: id,
          activeRequestId: reqId,
          claimedAt: now,
          cooldownUntil: rClaim?.cooldownUntil,
        };

        if (chain) {
          chain.requestId = reqId;
        }

        return { wait: { ...w }, notYet: false };
      }, context);

      if (!claimed) return false;
      if (claimed.notYet) {
        this.arm(String(id), claimed.wait);
        return false;
      }

      const wait = claimed.wait;
      const reqId = requestId(id, wait);

      await conv.submit({
        type: "input",
        content: continuationText(wait.attempt, wait.exact),
        requestId: reqId,
        whenBusy: "reject",
        guard: tx => this.eligible(tx, id, wait, true),
      }, context);

      await this.o.harness.commit(async tx => {
        const doc = await tx.doc(LimitWaitsDoc);
        if (sameWait(doc.waits[String(id)], wait)) {
          delete doc.waits[String(id)];
        }
        const chain = doc.chains?.[String(id)];
        if (chain?.requestId === reqId) {
          chain.attemptsAdmitted = Math.max(chain.attemptsAdmitted, wait.attempt);
          chain.lastOutcome = "admitted";
          const subRecord = await tx.submissionByRequest(id as ConversationId, reqId);
          if (subRecord?.entry !== undefined) {
            chain.entry = Number(subRecord.entry);
          }
        }
      }, context);

      this.o.log(`auto-continue ${id}: resumed (attempt ${wait.attempt})`);
      return true;
    } catch (error) {
      if (isGuardRejection(error)) {
        await this.o.harness.commit(async tx => {
          const doc = await tx.doc(LimitWaitsDoc);
          const current = doc.waits[String(id)];
          if (!current || current.boundary !== boundary) return;
          const rKey = routeKey(current.provider, current.model);
          delete doc.waits[String(id)];
          if (doc.routes?.[rKey]?.activeSessionId === id) {
            releaseActiveClaim(doc.routes[rKey]);
          }
          const chain = doc.chains?.[String(id)];
          if (chain) {
            chain.lastOutcome = "paused";
            chain.deliveryPausedReason = "Submission admission guard rejected";
          }
        }, context);
        return false;
      }

      const updatedWait = await this.o.harness.commit(async tx => {
        const cid = id as ConversationId;
        const doc = await tx.doc(LimitWaitsDoc);
        doc.chains ??= {};
        doc.routes ??= {};
        const w = doc.waits[String(id)];
        const reqId = w ? requestId(id, w) : "";

        if (reqId) {
          const placedSub = await tx.submissionByRequest(cid, reqId);
          if (placedSub && (placedSub.status === "queued" || placedSub.entry !== undefined)) {
            delete doc.waits[String(id)];
            const chain = doc.chains[String(id)];
            if (chain) {
              chain.attemptsAdmitted = w ? w.attempt : chain.attemptsAdmitted;
              chain.lastOutcome = "admitted";
              if (placedSub.entry !== undefined) chain.entry = Number(placedSub.entry);
            }
            return undefined;
          }
        }

        if (!w || w.boundary !== boundary) return undefined;

        const rKey = routeKey(w.provider, w.model);
        if (doc.routes[rKey]?.activeSessionId === id) {
          releaseActiveClaim(doc.routes[rKey]);
        }

        const deliveryAttempts = (w.deliveryAttempts ?? 0) + 1;
        w.deliveryAttempts = deliveryAttempts;

        if (deliveryAttempts > LOCAL_DELIVERY_BACKOFFS.length) {
          delete doc.waits[String(id)];
          const chain = doc.chains[String(id)];
          if (chain) {
            chain.lastOutcome = "paused";
            chain.deliveryPausedReason = `Delivery failed after ${deliveryAttempts - 1} retries: ${(error as Error).message}`;
          }
          return undefined;
        }

        const retryDelay = LOCAL_DELIVERY_BACKOFFS[deliveryAttempts - 1]!;
        w.nextDeliveryAt = this.now() + retryDelay;

        const chain = doc.chains[String(id)];
        if (chain) {
          chain.deliveryAttempts = deliveryAttempts;
          chain.nextDeliveryAt = w.nextDeliveryAt;
        }

        return { w: { ...w }, retryDelay };
      }, context);

      if (updatedWait) {
        this.arm(String(id), updatedWait.w, updatedWait.retryDelay);
      }
      throw error;
    } finally {
      this.firing.delete(id);
    }
  }

  async cancel(id: number, reason?: string): Promise<boolean> {
    clearTimeout(this.timers.get(String(id)));
    this.timers.delete(String(id));

    return this.o.harness.commit(async tx => {
      const doc = await tx.doc(LimitWaitsDoc);
      const w = doc.waits[String(id)];
      const chain = doc.chains?.[String(id)];

      if (!w && !chain) return false;

      delete doc.waits[String(id)];

      const provider = w?.provider ?? chain?.provider;
      const model = w?.model ?? chain?.model;
      const rKey = routeKey(provider, model);
      const claim = doc.routes?.[rKey];

      if (claim?.activeSessionId === id && claim.activeRequestId) {
        const sub = await tx.submissionByRequest(id as ConversationId, claim.activeRequestId);
        if (sub?.status !== "queued" && sub?.status !== "placed") {
          releaseActiveClaim(claim);
        }
      }

      if (chain) {
        chain.lastOutcome = "paused";
        chain.deliveryPausedReason = reason ?? "Cancelled";
        chain.cancelled = true;
      }

      return true;
    }, context);
  }

  async close() {
    this.closed = true;
    this.stop?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }
}
