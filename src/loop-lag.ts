// Event-loop lag monitor. Samples timer drift so main-thread stalls in production show up with numbers:
// the #550 investigation had to reconstruct an 11.4 s stall from client timings because the daemon kept none.

const SAMPLE_MS = 100;
const WINDOW_MS = 60_000;
const BUCKETS = 15; // 15 one-minute buckets
const STALL_LOG_MS = 1_000;

export interface LoopLagBucket { minute: string; samples: number; maxMs: number; over100: number; over500: number; totalLagMs: number }
export interface LoopLagView { sampleMs: number; current: LoopLagBucket | null; recent: LoopLagBucket[]; worst: { ms: number; at: string } | null }

export class LoopLagMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private last = 0;
  private buckets: (LoopLagBucket & { start: number })[] = [];
  private worst: { ms: number; at: number } | null = null;

  constructor(private readonly log?: (message: string) => void, private readonly sampleMs = SAMPLE_MS) {}

  start(): this {
    if (this.timer) return this;
    this.last = performance.now();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref();
    return this;
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  /** One drift sample; public for tests. */
  sample(now = performance.now(), wall = Date.now()): void {
    const lag = Math.max(0, now - this.last - this.sampleMs);
    this.last = now;
    const start = wall - (wall % WINDOW_MS);
    let bucket = this.buckets.at(-1);
    if (!bucket || bucket.start !== start) {
      bucket = { start, minute: new Date(start).toISOString(), samples: 0, maxMs: 0, over100: 0, over500: 0, totalLagMs: 0 };
      this.buckets.push(bucket);
      if (this.buckets.length > BUCKETS) this.buckets.shift();
    }
    bucket.samples++;
    bucket.totalLagMs += lag;
    if (lag > bucket.maxMs) bucket.maxMs = lag;
    if (lag > 100) bucket.over100++;
    if (lag > 500) bucket.over500++;
    if (!this.worst || lag > this.worst.ms) this.worst = { ms: lag, at: wall };
    if (lag >= STALL_LOG_MS) this.log?.(`event loop stalled ${Math.round(lag)} ms`);
  }

  view(): LoopLagView {
    const round = (b: LoopLagBucket & { start: number }): LoopLagBucket => ({ minute: b.minute, samples: b.samples, maxMs: Math.round(b.maxMs), over100: b.over100, over500: b.over500, totalLagMs: Math.round(b.totalLagMs) });
    const recent = this.buckets.map(round);
    return {
      sampleMs: this.sampleMs,
      current: recent.at(-1) ?? null,
      recent,
      worst: this.worst ? { ms: Math.round(this.worst.ms), at: new Date(this.worst.at).toISOString() } : null,
    };
  }
}

let shared: LoopLagMonitor | undefined;
/** The daemon's monitor. Started once by the daemon entry point. */
export function startLoopLagMonitor(log?: (message: string) => void): LoopLagMonitor {
  shared ??= new LoopLagMonitor(log).start();
  return shared;
}
export function loopLagMonitor(): LoopLagMonitor | undefined { return shared; }
