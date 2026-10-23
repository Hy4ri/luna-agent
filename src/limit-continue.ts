// Automatic continuation for top-level conversations. Saved waits remain until submission is confirmed.
import { AgentDoc, InboxDoc, defineDoc, type ConversationId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import { AskDoc } from "./ask.js";
import { classifyLimit } from "./limit-reset.js";
import { latestLimitReset } from "./provider-limits.js";
import { context } from "./luna.js";
import { newestInputBoundary, readTurnFailure, SessionHandoffDoc } from "./session-status.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type AutoContinuePolicy = { enabled: boolean; maxWaitHours: number; maxAttempts: number };
export type LimitWait = {
  boundary: number; resumeAt: number; attempt: number; reason: string; exact: boolean;
  // Optional for documents saved before guarded recovery. Legacy waits are retired, not guessed.
  generation?: number; provider?: string; model?: string;
};

export const LimitWaitsDoc = defineDoc<{ waits: Record<string, LimitWait> }>({
  checkpointWhen: () => false,
  kind: "luna.limit-waits", version: 1, scope: "session", initial: () => ({ waits: {} }),
});

export const CONTINUATION_TAG = "limit_continuation";
export const continuationText = (attempt: number, exact = true) =>
  `<${CONTINUATION_TAG} attempt="${attempt}"/> ${exact ? "The reported usage-limit reset time has passed." : "The retry delay has passed; quota availability is not confirmed."} Continue your work from where you stopped.`;
const ATTEMPT = new RegExp(`^<${CONTINUATION_TAG} attempt="(\\d+)"/>`);
const MAX_TIMER = 2 ** 31 - 1;

const textOf = (msgs: readonly unknown[] | undefined) => (msgs ?? []).map(m => {
  const c = (m as { content?: unknown }).content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => b.type === "text" ? b.text ?? "" : "").join("") : "";
}).join("\n");

async function busy(tx: Tx, id: ConversationId) {
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    if ((await tx.scanTasks({ conversationId: id, status, background: false }, 1)).items.length) return true;
  }
  return false;
}

/** Subagents, side questions and goal audits carry a marker after their creation (or fork) point. */
async function isChild(tx: Tx, id: ConversationId) {
  const conv = await tx.conversation(id);
  if (!conv) return true;
  if (conv.owner) return true;
  const after = conv.parent ? { minEntryId: (Number(conv.parent.at) + 1) as never } : {};
  return (await tx.scanEntries({ conversationId: id, order: "ascending", ...after }, 30)).items.some(e => e.kind === "delegate.child");
}

async function needsUser(tx: Tx, id: ConversationId, boundary: number) {
  if ((await tx.doc(InboxDoc, id)).items.length) return true;
  const ask = await tx.doc(AskDoc, id);
  if (ask.pending.some(q => !ask.answers[q.callId])) return true;
  return (await tx.doc(SessionHandoffDoc, id)).handoff?.boundary === boundary;
}

/** The pending wait for the conversation's current input, if any. */
export async function readLimitWait(tx: Tx, id: ConversationId): Promise<LimitWait | undefined> {
  const w = (await tx.doc(LimitWaitsDoc)).waits[String(id)];
  return w && w.boundary === await newestInputBoundary(tx, id) ? { ...w } : undefined;
}

const requestId = (id: number, w: LimitWait) => `limit-continue-${id}-${w.boundary}-${w.generation}`;
const sameWait = (a: LimitWait | undefined, b: LimitWait) => a?.boundary === b.boundary && a.generation === b.generation;

export class LimitContinuer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stop?: () => void;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly firing = new Set<number>();
  constructor(private readonly o: {
    harness: Harness; policy: () => AutoContinuePolicy; log: (m: string) => void;
    defaultModel: () => ModelRef;
    /** Cron runs and archived conversations must never continue automatically. */
    skip?: (id: number) => boolean;
    now?: () => number; graceMs?: number; backoffMs?: number[];
  }) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  enabled() { return this.o.policy().enabled; }
  private track<T>(p: Promise<T>) { this.pending.add(p); void p.finally(() => this.pending.delete(p)).catch(() => {}); return p; }
  private async model(tx: Tx, id: ConversationId) { return (await tx.doc(AgentDoc, id)).model ?? this.o.defaultModel(); }

  /** Called again inside the submission admission transaction, so cancellation and new input cannot race delivery. */
  private async eligible(tx: Tx, id: number, w: LimitWait): Promise<boolean> {
    const cid = id as ConversationId, policy = this.o.policy();
    if (this.closed || !policy.enabled || w.attempt > policy.maxAttempts || this.o.skip?.(id) || !w.generation ||
      !sameWait((await tx.doc(LimitWaitsDoc)).waits[String(id)], w) || await isChild(tx, cid)) return false;
    const failure = await readTurnFailure(tx, cid), ref = await this.model(tx, cid);
    return failure?.generation === w.generation && failure.boundary === w.boundary &&
      ref.provider === w.provider && ref.modelId === w.model &&
      await newestInputBoundary(tx, cid) === w.boundary && !await needsUser(tx, cid, w.boundary) && !await busy(tx, cid);
  }

  async start() {
    this.stop = this.o.harness.subscribeCommits(p => {
      for (const ch of p.changes) {
        if (ch.type !== "task" || ch.value.owner || ch.value.kind !== "pi.generation" || ch.value.state.status !== "terminal") continue;
        void this.track(this.check(Number(ch.value.conversationId))).catch(e => this.o.log(`auto-continue: ${(e as Error).message}`));
      }
    });
    const waits = await this.o.harness.commit(async tx => {
      const doc = await tx.doc(LimitWaitsDoc);
      for (const [id, w] of Object.entries(doc.waits)) {
        if (!w.generation || !w.provider || !w.model) delete doc.waits[id];
      }
      return JSON.parse(JSON.stringify(doc.waits)) as Record<string, LimitWait>;
    }, context);
    for (const [id, w] of Object.entries(waits)) this.arm(id, w);
  }

  /** Save an exact provider reset or a bounded fallback delay for the newest failed generation. */
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
      const failedAt = failure.failedAt ?? now;
      const fallback = classifyLimit(failure.message, failedAt);
      const structuredReset = failure.limit && latestLimitReset(failure.limit);
      const cls = fallback.kind === "fatal" || failure.limit?.kind === "fatal" ? { kind: "fatal" as const }
        : failure.limit ? { kind: "wait" as const, resetAt: structuredReset ??
          (failure.limit.windows.length === 0 && fallback.kind === "wait" ? fallback.resetAt : undefined) } : fallback;
      if (cls.kind !== "wait" || cls.resetAt !== undefined && cls.resetAt <= failedAt) return undefined;
      const ref = await this.model(tx, cid);
      if (failure.provider && (failure.provider !== ref.provider || failure.model !== ref.modelId)) return undefined;
      const doc = await tx.doc(LimitWaitsDoc);
      if (doc.waits[String(id)]?.generation === failure.generation) return undefined;
      const input = failure.boundary ? await tx.entry(failure.boundary as never) : undefined;
      const prior = input?.kind === "pi.user" ? ATTEMPT.exec(textOf(input.model).trimStart()) : null;
      const attempt = (prior ? Number(prior[1]) : 0) + 1;
      if (attempt > policy.maxAttempts) { this.o.log(`auto-continue ${id}: stopped after ${policy.maxAttempts} attempts`); return undefined; }
      const backoff = this.o.backoffMs ?? [2, 10, 30, 60].map(m => m * 60_000);
      const grace = this.o.graceMs ?? 60_000;
      const knownReset = failure.limit?.kind === "wait" ? failure.limit.windows.reduce((latest, w) => Math.max(latest, w.resetAt ?? 0), 0) : 0;
      const resumeAt = cls.resetAt !== undefined ? Math.max(cls.resetAt + grace, now)
        : Math.max(now + backoff[Math.min(attempt, backoff.length) - 1]!, knownReset ? knownReset + grace : 0);
      if (resumeAt - now > policy.maxWaitHours * 3_600_000) { this.o.log(`auto-continue ${id}: reset at ${new Date(resumeAt).toISOString()} is beyond maxWaitHours`); return undefined; }
      const w: LimitWait = { boundary: failure.boundary, generation: failure.generation, provider: ref.provider, model: ref.modelId,
        resumeAt, attempt, reason: failure.message.slice(0, 300), exact: cls.resetAt !== undefined };
      doc.waits[String(id)] = w;
      return { ...w };
    }, context);
    if (wait) { this.arm(String(id), wait); this.o.log(`auto-continue ${id}: attempt ${wait.attempt} at ${new Date(wait.resumeAt).toISOString()}`); }
    return wait;
  }

  private arm(id: string, w: LimitWait, retryMs = 0) {
    clearTimeout(this.timers.get(id));
    if (this.closed) return;
    const delay = Math.max(retryMs, w.resumeAt - this.now(), 0);
    const t = setTimeout(() => {
      this.timers.delete(id);
      if (delay > MAX_TIMER) return this.arm(id, w);
      void this.track(this.fire(Number(id), w.boundary)).catch(e => this.o.log(`auto-continue ${id}: ${(e as Error).message}`));
    }, Math.min(delay, MAX_TIMER));
    t.unref?.();
    this.timers.set(id, t);
  }

  /** Revalidate the failed generation before delivery. A crash or failed submission cannot lose the saved wait. */
  async fire(id: number, boundary: number): Promise<boolean> {
    if (this.closed || this.firing.has(id)) return false;
    this.firing.add(id);
    try {
      const conv = await this.o.harness.conversation(id as ConversationId, context);
      const wait = await this.o.harness.commit(async tx => {
        const doc = await tx.doc(LimitWaitsDoc), w = doc.waits[String(id)];
        if (!w || w.boundary !== boundary) return undefined;
        // A prior process may have submitted successfully and crashed before retiring this wait.
        if (await tx.submissionByRequest(id as ConversationId, requestId(id, w))) {
          delete doc.waits[String(id)]; return undefined;
        }
        if (!conv || !await this.eligible(tx, id, w)) {
          delete doc.waits[String(id)]; return undefined;
        }
        return { ...w };
      }, context);
      if (!wait || !conv) return false;
      if (wait.resumeAt > this.now()) { this.arm(String(id), wait); return false; }
      await conv.submit({ type: "input", content: continuationText(wait.attempt, wait.exact), requestId: requestId(id, wait), whenBusy: "reject",
        guard: tx => this.eligible(tx, id, wait) }, context);
      await this.o.harness.commit(async tx => {
        const doc = await tx.doc(LimitWaitsDoc);
        if (sameWait(doc.waits[String(id)], wait)) delete doc.waits[String(id)];
      }, context);
      this.o.log(`auto-continue ${id}: resumed (attempt ${wait.attempt})`);
      return true;
    } catch (error) {
      // Keep the same request ID after an ambiguous delivery failure. Admission deduplicates it.
      const w = await this.o.harness.commit(async tx => {
        const w = (await tx.doc(LimitWaitsDoc)).waits[String(id)];
        return w?.boundary === boundary ? { ...w } : undefined;
      }, context);
      if (w) this.arm(String(id), w, 30_000);
      throw error;
    } finally {
      this.firing.delete(id);
    }
  }

  /** Drop the conversation's pending wait. Returns true when one existed. */
  async cancel(id: number): Promise<boolean> {
    clearTimeout(this.timers.get(String(id))); this.timers.delete(String(id));
    return this.o.harness.commit(async tx => {
      const doc = await tx.doc(LimitWaitsDoc);
      if (!doc.waits[String(id)]) return false;
      delete doc.waits[String(id)]; return true;
    }, context);
  }

  async close() {
    this.closed = true; this.stop?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }
}
