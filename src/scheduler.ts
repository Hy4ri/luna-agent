// Durable cron scheduler: jobs + run log live in SQLite (cron.db); each fire runs an isolated
// ownerless pi-durable conversation. Exactly-once-ish via deterministic requestId per (job, slot).
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { context } from "./luna.js";
import { nextRun, parseCron } from "./cron-expr.js";
import type { Harness } from "@earendil-works/pi-durable";

export interface ModelRef { provider: string; modelId: string }
export interface ScriptExecution { command: string[]; cwd?: string }
export interface Job { id: number; name: string; expr: string; prompt: string; enabled: boolean; nextRun: number | null; model: ModelRef | null; execution?: ScriptExecution; intervalMs?: number }
export interface Run {
  id: number; jobId: number; slot: number; startedAt: number; endedAt: number | null;
  status: "running" | "ok" | "error"; conversationId: string | null; submissionId: string | null; output: string | null; error: string | null;
}

export class CronStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, expr TEXT NOT NULL, prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, next_run INTEGER, model TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, slot INTEGER NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, conversation_id TEXT, submission_id TEXT, output TEXT, error TEXT,
        UNIQUE(job_id, slot));`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(jobs)").all() as any[]).map(c => c.name));
    if (!columns.has("execution")) this.db.exec("ALTER TABLE jobs ADD COLUMN execution TEXT");
    if (!columns.has("interval_ms")) this.db.exec("ALTER TABLE jobs ADD COLUMN interval_ms INTEGER");
  }
  private job(r: any): Job {
    return { id: r.id, name: r.name, expr: r.expr, prompt: r.prompt, enabled: !!r.enabled, nextRun: r.next_run, model: r.model ? JSON.parse(r.model) : null, ...(r.execution ? { execution: JSON.parse(r.execution) } : {}), ...(r.interval_ms ? { intervalMs: r.interval_ms } : {}) };
  }
  private run(r: any): Run {
    return { id: r.id, jobId: r.job_id, slot: r.slot, startedAt: r.started_at, endedAt: r.ended_at, status: r.status, conversationId: r.conversation_id, submissionId: r.submission_id, output: r.output, error: r.error };
  }
  addJob(name: string, expr: string, prompt: string, model?: ModelRef, now = Date.now()): Job {
    parseCron(expr); // validate
    const info = this.db.prepare("INSERT INTO jobs(name,expr,prompt,next_run,model,created_at) VALUES(?,?,?,?,?,?)")
      .run(name, expr, prompt, nextRun(expr, now), model ? JSON.stringify(model) : null, now);
    return this.getJob(Number(info.lastInsertRowid))!;
  }
  getJob(id: number): Job | undefined { const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id); return r ? this.job(r) : undefined; }
  listJobs(): Job[] { return this.db.prepare("SELECT * FROM jobs ORDER BY id").all().map((r) => this.job(r)); }
  setEnabled(id: number, on: boolean, now = Date.now()) {
    const j = this.getJob(id); if (!j) throw new Error("no such job " + id);
    this.db.prepare("UPDATE jobs SET enabled=?, next_run=? WHERE id=?").run(on ? 1 : 0, on ? (j.intervalMs ? now + j.intervalMs : nextRun(j.expr, now)) : null, id);
  }
  removeJob(id: number) { this.db.prepare("DELETE FROM jobs WHERE id=?").run(id); }
  dueJobs(now: number): Job[] { return this.db.prepare("SELECT * FROM jobs WHERE enabled=1 AND next_run<=? ORDER BY next_run").all(now).map((r) => this.job(r)); }
  earliest(): number | null { const r: any = this.db.prepare("SELECT MIN(next_run) m FROM jobs WHERE enabled=1").get(); return r?.m ?? null; }
  /** Atomically claim a slot: insert run row + advance next_run. Returns undefined if already claimed. */
  claim(job: Job, now: number): Run | undefined {
    const slot = job.nextRun!;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const info = this.db.prepare("INSERT OR IGNORE INTO runs(job_id,slot,started_at,status) VALUES(?,?,?,'running')").run(job.id, slot, now);
      // coalesce missed slots: next_run is computed from now, not from the missed slot
      this.db.prepare("UPDATE jobs SET next_run=? WHERE id=?").run(job.intervalMs ? Math.max(now, slot) + job.intervalMs : nextRun(job.expr, Math.max(now, slot)), job.id);
      this.db.exec("COMMIT");
      if (!info.changes) return undefined;
      return this.run(this.db.prepare("SELECT * FROM runs WHERE job_id=? AND slot=?").get(job.id, slot));
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  attach(runId: number, conversationId: string, submissionId: string) {
    this.db.prepare("UPDATE runs SET conversation_id=?, submission_id=? WHERE id=?").run(conversationId, submissionId, runId);
  }
  finish(runId: number, status: "ok" | "error", output: string | null, error: string | null, now = Date.now()) {
    this.db.prepare("UPDATE runs SET status=?, output=?, error=?, ended_at=? WHERE id=?").run(status, output, error, now, runId);
  }
  runs(jobId?: number, limit = 50): Run[] {
    const q = jobId === undefined ? this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM runs WHERE job_id=? ORDER BY id DESC LIMIT ?").all(jobId, limit);
    return q.map((r) => this.run(r));
  }
  getRun(id: number): Run | undefined { const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id); return r ? this.run(r) : undefined; }
  unfinished(): Run[] { return this.db.prepare("SELECT * FROM runs WHERE status='running' ORDER BY id").all().map((r) => this.run(r)); }
  close() { this.db.close(); }
}

export interface SchedulerOptions {
  harness: Harness;
  store: CronStore;
  /** Model for jobs without their own; a function is read at each run (the UI can change it). */
  defaultModel: ModelRef | (() => ModelRef);
  /** Max time one run may take before it is aborted and logged as error. Default 30 min. */
  runTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Called once per finished run (ok or error), e.g. to deliver the result. Errors are logged, never thrown. */
  onFinish?: (job: Job | undefined, run: Run) => void | Promise<void>;
}

const MAX_TIMER = 2 ** 31 - 1;

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private inflight = new Set<Promise<void>>();
  private stopped = true;
  private o: Required<Omit<SchedulerOptions, "onFinish">> & Pick<Required<SchedulerOptions>, "onFinish">;
  constructor(o: SchedulerOptions) { this.o = { runTimeoutMs: 30 * 60_000, log: () => {}, onFinish: () => {}, ...o }; }

  /** Re-arm the timer after jobs change (e.g. the model added a job). */
  rearm() { this.arm(); }

  private async notify(runId: number) {
    const run = this.o.store.getRun(runId);
    if (!run || run.status === "running") return;
    try { await this.o.onFinish(this.o.store.getJob(run.jobId), run); }
    catch (e) { this.o.log(`onFinish for run ${runId} failed: ${errText(e)}`); }
  }

  /** Recover runs interrupted by a crash, then start the tick loop. */
  async start() {
    this.stopped = false;
    this.o.harness.resume();
    for (const r of this.o.store.unfinished()) this.track(this.recover(r).then(() => this.notify(r.id)));
    this.arm();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inflight]);
  }

  /** Wait until every in-flight run has settled (used by tests). */
  async idle() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  private arm() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const e = this.o.store.earliest();
    const delay = e === null ? 60_000 : Math.min(Math.max(e - Date.now(), 0), MAX_TIMER);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  async tick(now = Date.now()) {
    if (this.stopped) return;
    for (const job of this.o.store.dueJobs(now)) {
      const run = this.o.store.claim(job, now);
      if (run) this.track(this.execute(job, run).then(() => this.notify(run.id)));
    }
    this.arm();
  }

  private track(p: Promise<void>) { this.inflight.add(p); void p.finally(() => this.inflight.delete(p)); }

  private async execute(job: Job, run: Run) {
    const { store, harness } = this.o;
    try {
      if (job.execution) {
        const { command, cwd } = job.execution;
        if (!command.length) throw new Error("empty script command");
        const output = await new Promise<string>((resolve, reject) => {
          execFile(command[0]!, command.slice(1), { cwd, timeout: this.o.runTimeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stderr}`));
            else resolve(stdout);
          });
        });
        store.finish(run.id, "ok", output, null);
        return;
      }
      const d = this.o.defaultModel;
      const model = job.model ?? (typeof d === "function" ? d() : d);
      const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
      const sub = await conv.submit({ type: "input", content: job.prompt, requestId: `cron-${job.id}-${run.slot}` }, context);
      store.attach(run.id, String(conv.id), String(sub.id));
      await this.settle(run, sub, conv);
    } catch (e) {
      store.finish(run.id, "error", null, errText(e));
      this.o.log(`job ${job.name} run ${run.id} failed: ${errText(e)}`);
    }
  }

  private async recover(run: Run) {
    const { store, harness } = this.o;
    try {
      if (!run.submissionId) { store.finish(run.id, "error", null, "interrupted before submission was admitted"); return; }
      const sub = await harness.submission(run.submissionId as any, context);
      if (!sub) { store.finish(run.id, "error", null, "submission not found on recovery"); return; }
      this.o.log(`recovering run ${run.id}`);
      const conv = run.conversationId ? await harness.conversation(run.conversationId as any, context) : undefined;
      await this.settle(run, sub, conv);
    } catch (e) { store.finish(run.id, "error", null, errText(e)); }
  }

  private async answerText(conv: { context(c: any): Promise<any> } | undefined, id: unknown): Promise<string | null> {
    if (!conv) return null;
    const view = await conv.context(context);
    const e = view.entries.find((x: any) => x.id === id);
    const msg = e?.model?.[0];
    if (!msg) return null;
    return typeof msg.content === "string" ? msg.content
      : (msg.content as any[]).filter((c) => c.type === "text").map((c) => c.text).join("");
  }

  private async settle(run: Run, sub: { wait(c: any): Promise<any>; abort(c: any): Promise<any> }, conv?: { context(c: any): Promise<any> }) {
    const ac = new AbortController();
    const timeout = setTimeout(() => { void sub.abort(context); }, this.o.runTimeoutMs);
    try {
      const s = await sub.wait(context);
      if (s.status === "done") this.o.store.finish(run.id, "ok", await this.answerText(conv, s.answer), null);
      else this.o.store.finish(run.id, "error", null, `submission ${s.status}: ${JSON.stringify(s).slice(0, 500)}`);
    } finally { clearTimeout(timeout); ac.abort(); }
  }
}

function errText(e: unknown) { return e instanceof Error ? e.message : String(e); }
