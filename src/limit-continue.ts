// Automatic continuation after a usage limit resets. Only top-level conversations; cron runs and subagents are skipped.
// When a turn fails with a limit error, one durable wait record is stored (session doc, keyed by conversation).
// At the reset time plus a grace period, a continuation input is submitted, unless the user sent anything newer,
// another turn is running, or the setting was turned off. Waits survive restarts: start() arms every stored record.
// Errors without a time back off; errors that waiting cannot fix never wait. Repeated limits count as attempts.
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { classifyLimit } from "./limit-reset.js";
import { context } from "./luna.js";
import { newestInputBoundary, readTurnFailure } from "./session-status.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type AutoContinuePolicy = { enabled: boolean; maxWaitHours: number; maxAttempts: number };
export type LimitWait = { boundary: number; resumeAt: number; attempt: number; reason: string; exact: boolean };

export const LimitWaitsDoc = defineDoc<{ waits: Record<string, LimitWait> }>({
  kind: "luna.limit-waits", version: 1, scope: "session", initial: () => ({ waits: {} }),
});

export const CONTINUATION_TAG = "limit_continuation";
export const continuationText = (attempt: number) =>
  `<${CONTINUATION_TAG} attempt="${attempt}"/> The usage limit has reset. Continue your work from where you stopped.`;
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

/** Subagents, side questions and goal audits carry a `delegate.child` marker after their creation (or fork) point. */
async function isChild(tx: Tx, id: ConversationId) {
  const conv = await tx.conversation(id);
  if (!conv) return true;
  if (conv.owner) return true;
  const after = conv.parent ? { minEntryId: (Number(conv.parent.at) + 1) as never } : {};
  return (await tx.scanEntries({ conversationId: id, order: "ascending", ...after }, 30)).items.some(e => e.kind === "delegate.child");
}

/** The pending wait for the conversation's current input, if any. */
export async function readLimitWait(tx: Tx, id: ConversationId): Promise<LimitWait | undefined> {
  const w = (await tx.doc(LimitWaitsDoc)).waits[String(id)];
  return w && w.boundary === await newestInputBoundary(tx, id) ? { ...w } : undefined;
}

export class LimitContinuer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stop?: () => void;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly o: {
    harness: Harness; policy: () => AutoContinuePolicy; log: (m: string) => void;
    /** Conversations that must never continue automatically (cron runs). */
    skip?: (id: number) => boolean;
    now?: () => number; graceMs?: number; backoffMs?: number[];
  }) {}

  private now() { return this.o.now?.() ?? Date.now(); }
  enabled() { return this.o.policy().enabled; }
  private track<T>(p: Promise<T>) { this.pending.add(p); void p.finally(() => this.pending.delete(p)).catch(() => {}); return p; }

  async start() {
    this.stop = this.o.harness.subscribeCommits(p => {
      for (const ch of p.changes) {
        if (ch.type !== "task" || ch.value.owner || ch.value.kind !== "pi.generation" || ch.value.state.status !== "terminal") continue;
        void this.track(this.check(Number(ch.value.conversationId))).catch(e => this.o.log(`auto-continue: ${(e as Error).message}`));
      }
    });
    const waits: Record<string, LimitWait> = await this.o.harness.commit(async tx => JSON.parse(JSON.stringify((await tx.doc(LimitWaitsDoc)).waits)), context);
    for (const [id, w] of Object.entries(waits)) this.arm(id, w);
  }

  /** Record a wait when the conversation's newest turn failed on a limit that resets. Returns the wait or undefined. */
  async check(id: number): Promise<LimitWait | undefined> {
    const policy = this.o.policy();
    if (this.closed || !policy.enabled || this.o.skip?.(id)) return undefined;
    const now = this.now();
    const wait = await this.o.harness.commit(async tx => {
      if (await isChild(tx, id as ConversationId) || await busy(tx, id as ConversationId)) return undefined;
      const failure = await readTurnFailure(tx, id as ConversationId);
      if (!failure) return undefined;
      const cls = classifyLimit(failure.message, now);
      if (cls.kind !== "wait") return undefined;
      const doc = await tx.doc(LimitWaitsDoc);
      if (doc.waits[String(id)]?.boundary === failure.boundary) return undefined;
      const input = failure.boundary ? await tx.entry(failure.boundary as never) : undefined;
      const prior = input?.kind === "pi.user" ? ATTEMPT.exec(textOf(input.model).trimStart()) : null;
      const attempt = (prior ? Number(prior[1]) : 0) + 1;
      if (attempt > policy.maxAttempts) { this.o.log(`auto-continue ${id}: stopped after ${policy.maxAttempts} attempts`); return undefined; }
      const backoff = this.o.backoffMs ?? [2, 10, 30, 60].map(m => m * 60_000);
      const resumeAt = cls.resetAt !== undefined ? Math.max(cls.resetAt, now) + (this.o.graceMs ?? 60_000) : now + backoff[Math.min(attempt, backoff.length) - 1]!;
      if (resumeAt - now > policy.maxWaitHours * 3_600_000) { this.o.log(`auto-continue ${id}: reset at ${new Date(resumeAt).toISOString()} is beyond maxWaitHours`); return undefined; }
      const w: LimitWait = { boundary: failure.boundary, resumeAt, attempt, reason: failure.message.slice(0, 300), exact: cls.resetAt !== undefined };
      doc.waits[String(id)] = w;
      return { ...w };
    }, context);
    if (wait) { this.arm(String(id), wait); this.o.log(`auto-continue ${id}: attempt ${wait.attempt} at ${new Date(wait.resumeAt).toISOString()}`); }
    return wait;
  }

  private arm(id: string, w: LimitWait) {
    clearTimeout(this.timers.get(id));
    if (this.closed) return;
    const delay = Math.max(0, w.resumeAt - this.now());
    const t = setTimeout(() => {
      this.timers.delete(id);
      if (delay > MAX_TIMER) return this.arm(id, w);
      void this.track(this.fire(Number(id), w.boundary)).catch(e => this.o.log(`auto-continue ${id}: ${(e as Error).message}`));
    }, Math.min(delay, MAX_TIMER));
    t.unref?.();
    this.timers.set(id, t);
  }

  /** Submit the continuation when the wait is still current. Returns true when an input was submitted. */
  async fire(id: number, boundary: number): Promise<boolean> {
    if (this.closed) return false;
    const enabled = this.enabled();
    const wait = await this.o.harness.commit(async tx => {
      const doc = await tx.doc(LimitWaitsDoc), w = doc.waits[String(id)];
      if (!w || w.boundary !== boundary) return undefined;
      delete doc.waits[String(id)];
      if (!enabled || await newestInputBoundary(tx, id as ConversationId) !== boundary || await busy(tx, id as ConversationId)) return undefined;
      return { ...w };
    }, context);
    if (!wait) return false;
    const conv = await this.o.harness.conversation(id as ConversationId, context);
    if (!conv) return false;
    await conv.submit({ type: "input", content: continuationText(wait.attempt), requestId: `limit-continue-${id}-${boundary}`, whenBusy: "reject" }, context);
    this.o.log(`auto-continue ${id}: resumed (attempt ${wait.attempt})`);
    return true;
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
