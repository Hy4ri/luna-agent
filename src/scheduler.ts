// Durable cron scheduler: jobs + run log live in SQLite (cron.db); each fire runs an isolated
// ownerless pi-durable conversation. Unique claim per (job, slot); start is at-most-once. A crash before the conversation is recorded fails the run;
// after that, recovery re-submits with the deterministic requestId, which dedupes.
import { Database } from "bun:sqlite";
import { context } from "./luna.js";
import { HIDDEN_SESSION } from "./session-row-head.js";
import { nextRun, parseCron } from "./cron-expr.js";
import type { StoredThinkingLevel } from "./thinking.js";
import type { Conversation, ConversationId, EntryId, Extension, Harness, Submission, SubmissionId, Tx } from "@earendil-works/pi-durable";

export interface ModelRef { provider: string; modelId: string }
export interface ScriptExecution { command: string[]; cwd?: string }
export type ReportPolicy = "always" | "changes" | "failures";

type RunStatus = "running" | "ok" | "error" | "skipped";

type TableColumnRow = { name: string };
type JobDbRow = {
  id: number;
  name: string;
  expr: string;
  prompt: string;
  enabled: number;
  next_run: number | null;
  model: string | null;
  execution?: string | null;
  interval_ms?: number | null;
  report_policy: string;
  deleted_at?: number | null;
  grace_ms?: number | null;
  timeout_ms?: number | null;
  retries?: number;
  hidden?: number;
};
type RunDbRow = {
  id: number;
  job_id: number;
  slot: number;
  started_at: number;
  ended_at: number | null;
  status: RunStatus;
  reason?: string | null;
  attempt?: number;
  retry_at?: number | null;
  deadline_at?: number | null;
  conversation_id: string | null;
  submission_id: string | null;
  output: string | null;
  error: string | null;
  job_name?: string | null;
  report?: number;
  read_at?: number | null;
};

export interface Job {
  id: number;
  name: string;
  expr: string;
  prompt: string;
  enabled: boolean;
  nextRun: number | null;
  model: ModelRef | null;
  execution?: ScriptExecution;
  intervalMs?: number;
  reportPolicy: ReportPolicy;
  timezone: string;
  deletedAt?: number | null;
  /** A slot older than this when it comes due is recorded as skipped (reason "missed") instead of run. null: always run late. */
  graceMs: number | null;
  /** Time limit for the whole run: all attempts and waits between them, measured from the run start. null: the global limit. */
  timeoutMs: number | null;
  /** Extra attempts after a failed run (not after stop or timeout). 0: none. */
  retries: number;
  /** Run conversations stay out of the session list; the result is visible in Cron only. */
  hidden: boolean;
}

/** Optional per-job policy. */
export interface JobOptions { graceMs?: number | null; timeoutMs?: number | null; retries?: number; hidden?: boolean }

export const MAX_RETRIES = 5;

function checkOptions(o: JobOptions) {
  const pos = (v: unknown, n: string) => { if (v !== undefined && v !== null && !(Number.isSafeInteger(v) && (v as number) > 0)) throw new Error(`${n} must be a positive integer or null`); };
  pos(o.graceMs, "graceMs"); pos(o.timeoutMs, "timeoutMs");
  if (o.retries !== undefined && !(Number.isSafeInteger(o.retries) && o.retries >= 0 && o.retries <= MAX_RETRIES)) throw new Error(`retries must be an integer from 0 to ${MAX_RETRIES}`);
  if (o.hidden !== undefined && typeof o.hidden !== "boolean") throw new Error("hidden must be boolean");
}

export interface Run {
  id: number;
  jobId: number;
  slot: number;
  startedAt: number;
  endedAt: number | null;
  /** skipped: recorded but never started (see reason). */
  status: "running" | "ok" | "error" | "skipped";
  /** Why a run did not succeed: overlap, missed, timeout, stopped, interrupted, script_failed, agent_failed. */
  reason: string | null;
  /** Attempt in progress or last made (0 = first). */
  attempt: number;
  /** When the next attempt is due (a retry is waiting), else null. Survives a restart. */
  retryAt: number | null;
  /** Run-level deadline, fixed when the run first executes. Later job edits do not move it. */
  deadlineAt: number | null;
  conversationId: string | null;
  submissionId: string | null;
  output: string | null;
  error: string | null;
  jobName: string;
  report: boolean;
  readAt: number | null;
}

/**
 * A run counts as a report when it carries output or an error and is not still running. Empty output is not a
 * report. The partial index below repeats these exact terms, so the index and the queries always agree.
 */
export const reportPredicate = `report=1 AND status != 'running' AND (TRIM(COALESCE(output, '')) != '' OR TRIM(COALESCE(error, '')) != '')`;

/**
 * A finished run that is not a report: it never reached the inbox, so it only needs the short retention window.
 * Together with the report predicate it covers every run row that is not running.
 */
export const nonReportPredicate = `status != 'running' AND NOT (report=1 AND (TRIM(COALESCE(output, '')) != '' OR TRIM(COALESCE(error, '')) != ''))`;

/** How long the cron run log is kept. Windows are in days, plus the number of reports kept per job. */
export interface RetentionPolicy {
  /** Master switch. When off, nothing is removed. */
  enabled: boolean;
  /** Days a finished run without a report stays in the log. */
  emptyRunDays: number;
  /** Days a report stays in the log. */
  reportDays: number;
  /** Newest reports kept per job, however old they are. */
  reportsPerJob: number;
  /** Days the runs of a deleted job stay in the log. */
  deletedJobDays: number;
}

export const defaultRetention: RetentionPolicy = { enabled: true, emptyRunDays: 7, reportDays: 90, reportsPerJob: 50, deletedJobDays: 30 };

/** Jobs a cleanup round visits, so a round stays bounded even with many jobs. */
export const PRUNE_MAX_JOBS = 100;
/** Run rows one job may contribute per round, so a noisy job cannot starve the others. */
export const PRUNE_PER_JOB = 5_000;
/** Run rows one round removes in total. */
export const PRUNE_MAX_ROWS = 10_000;
/** How often the run log is cleaned. */
export const PRUNE_INTERVAL_MS = 60_000;
/** How long one cleanup round may take. The daemon never stalls on the run log. */
export const PRUNE_BUDGET_MS = 30;

/**
 * Inbox rows: the newest report for each job, only while it is unread. A newer report replaces an older unread
 * one; the older one is superseded and lives in history.
 *
 * The lookup starts from the job list and takes one index seek per job, so its cost follows the number of jobs
 * and not the size of the history. Grouping the newest report per job over the whole run table grows with every
 * run ever kept, which is what made the inbox and the badge slow on long-lived databases.
 */
export const inboxIds = `
  SELECT ir.id FROM jobs j
  JOIN runs ir ON ir.id = (SELECT MAX(id) FROM runs WHERE job_id = j.id AND ${reportPredicate})
  WHERE ir.read_at IS NULL
`;

export class CronStore {
  readonly db: Database;
  /** The inbox query, exposed so callers and tests can check how it is planned. */
  readonly inboxSql = inboxIds;
  /** Where the next cleanup round starts in the job list, so every job is reached over time. */
  private pruneCursor = 0;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run INTEGER,
        model TEXT,
        created_at INTEGER NOT NULL,
        report_policy TEXT NOT NULL DEFAULT 'always',
        timezone TEXT,
        deleted_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS runs(
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        conversation_id TEXT,
        submission_id TEXT,
        output TEXT,
        error TEXT,
        job_name TEXT NOT NULL DEFAULT '',
        report INTEGER NOT NULL DEFAULT 0,
        read_at INTEGER,
        UNIQUE(job_id, slot)
      );`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const jobColumns = new Set((this.db.prepare("PRAGMA table_info(jobs)").all() as unknown as TableColumnRow[]).map(c => c.name));
      if (!jobColumns.has("execution")) this.db.exec("ALTER TABLE jobs ADD COLUMN execution TEXT");
      if (!jobColumns.has("interval_ms")) this.db.exec("ALTER TABLE jobs ADD COLUMN interval_ms INTEGER");
      if (!jobColumns.has("report_policy")) this.db.exec("ALTER TABLE jobs ADD COLUMN report_policy TEXT NOT NULL DEFAULT 'always'");
      if (!jobColumns.has("timezone")) this.db.exec("ALTER TABLE jobs ADD COLUMN timezone TEXT");
      if (!jobColumns.has("deleted_at")) this.db.exec("ALTER TABLE jobs ADD COLUMN deleted_at INTEGER");
      if (!jobColumns.has("grace_ms")) this.db.exec("ALTER TABLE jobs ADD COLUMN grace_ms INTEGER");
      if (!jobColumns.has("timeout_ms")) this.db.exec("ALTER TABLE jobs ADD COLUMN timeout_ms INTEGER");
      if (!jobColumns.has("retries")) this.db.exec("ALTER TABLE jobs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0");
      if (!jobColumns.has("hidden")) this.db.exec("ALTER TABLE jobs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");

      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_name ON jobs(name) WHERE deleted_at IS NULL;");

      const runColumns = new Set((this.db.prepare("PRAGMA table_info(runs)").all() as unknown as TableColumnRow[]).map(c => c.name));
      const hasReportCol = runColumns.has("report");
      if (!runColumns.has("job_name")) this.db.exec("ALTER TABLE runs ADD COLUMN job_name TEXT NOT NULL DEFAULT ''");
      if (!hasReportCol) {
        this.db.exec("ALTER TABLE runs ADD COLUMN report INTEGER NOT NULL DEFAULT 0");
        this.db.exec("UPDATE runs SET report = 1 WHERE status != 'running'");
      }
      if (!runColumns.has("read_at")) this.db.exec("ALTER TABLE runs ADD COLUMN read_at INTEGER");
      if (!runColumns.has("reason")) this.db.exec("ALTER TABLE runs ADD COLUMN reason TEXT");
      if (!runColumns.has("deadline_at")) this.db.exec("ALTER TABLE runs ADD COLUMN deadline_at INTEGER");
      if (!runColumns.has("retry_at")) this.db.exec("ALTER TABLE runs ADD COLUMN retry_at INTEGER");
      if (!runColumns.has("attempt")) this.db.exec("ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");

      this.db.exec(`
        UPDATE runs SET job_name = COALESCE(
          (SELECT name FROM jobs WHERE jobs.id = runs.job_id),
          'unknown'
        ) WHERE job_name = '' OR job_name IS NULL;
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS runs_job_status ON runs(job_id,status,id);
        CREATE INDEX IF NOT EXISTS runs_reports ON runs(report,id);
        UPDATE runs SET report=0 WHERE report=1 AND status='ok' AND TRIM(COALESCE(output,''))='';
        -- Partial index over report rows only: the newest report of a job is one seek per job, not a scan of the history.
        CREATE INDEX IF NOT EXISTS runs_report_pred ON runs(job_id,id) WHERE ${reportPredicate};
        -- Age lookups for the cleanup: it seeks straight to the rows that fell out of the window.
        CREATE INDEX IF NOT EXISTS runs_report_age ON runs(job_id,started_at) WHERE ${reportPredicate};
        CREATE INDEX IF NOT EXISTS runs_nonreport_age ON runs(job_id,started_at) WHERE ${nonReportPredicate};
        COMMIT`);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private job(r: JobDbRow): Job {
    return {
      id: r.id,
      name: r.name,
      expr: r.expr,
      prompt: r.prompt,
      enabled: !!r.enabled,
      nextRun: r.next_run,
      model: r.model ? JSON.parse(r.model) : null,
      ...(r.execution ? { execution: JSON.parse(r.execution) } : {}),
      ...(r.interval_ms ? { intervalMs: r.interval_ms } : {}),
      reportPolicy: (r.report_policy as ReportPolicy) || "always",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deletedAt: r.deleted_at ?? null,
      graceMs: r.grace_ms ?? null,
      timeoutMs: r.timeout_ms ?? null,
      retries: r.retries ?? 0,
      hidden: !!r.hidden
    };
  }

  private run(r: RunDbRow): Run {
    return {
      id: r.id,
      jobId: r.job_id,
      slot: r.slot,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      reason: r.reason ?? null,
      attempt: r.attempt ?? 0,
      retryAt: r.retry_at ?? null,
      deadlineAt: r.deadline_at ?? null,
      conversationId: r.conversation_id,
      submissionId: r.submission_id,
      output: r.output,
      error: r.error,
      jobName: r.job_name || "unknown",
      report: !!r.report,
      readAt: r.read_at ?? null
    };
  }

  addJob(name: string, expr: string, prompt: string, model?: ModelRef, now = Date.now(), reportPolicy: ReportPolicy = "always", options: JobOptions = {}): Job {
    checkOptions(options);
    if (typeof name !== "string" || !name.trim()) throw new Error("job name must be a nonempty string");
    if (typeof prompt !== "string") throw new Error("prompt must be a string");
    if (!["always", "changes", "failures"].includes(reportPolicy)) throw new Error("invalid reportPolicy");
    parseCron(expr); // validate
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const info = this.db.prepare(
      "INSERT INTO jobs(name,expr,prompt,next_run,model,created_at,report_policy,timezone,grace_ms,timeout_ms,retries,hidden) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(name, expr, prompt, nextRun(expr, now), model ? JSON.stringify(model) : null, now, reportPolicy, tz, options.graceMs ?? null, options.timeoutMs ?? null, options.retries ?? 0, options.hidden ? 1 : 0);
    return this.getJob(Number(info.lastInsertRowid))!;
  }

  getJob(id: number): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id=? AND (deleted_at IS NULL)").get(id) as JobDbRow | undefined;
    return r ? this.job(r) : undefined;
  }

  getJobAny(id: number): Job | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobDbRow | undefined;
    return r ? this.job(r) : undefined;
  }

  listJobs(): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY id").all() as unknown as JobDbRow[]).map((r) => this.job(r));
  }

  updateJob(id: number, patch: { name?: string; expr?: string; prompt?: string; enabled?: boolean; reportPolicy?: ReportPolicy } & JobOptions, now = Date.now()): Job {
    const j = this.getJob(id);
    checkOptions(patch);
    if (!j) throw new Error("no such job " + id);

    if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim())) {
      throw new Error("job name must be a nonempty string");
    }
    if (patch.prompt !== undefined) {
      if (typeof patch.prompt !== "string") throw new Error("prompt must be a string");
      if (!j.execution && !patch.prompt.trim()) throw new Error("prompt must be a nonempty string for agent jobs");
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw new Error("enabled must be boolean");
    }
    if (patch.reportPolicy !== undefined && !["always", "changes", "failures"].includes(patch.reportPolicy)) {
      throw new Error("invalid reportPolicy");
    }
    if (patch.expr !== undefined) {
      if (j.intervalMs) throw new Error("cannot edit cron expression for interval job");
      parseCron(patch.expr);
    }

    const newName = patch.name !== undefined ? patch.name : j.name;
    const newExpr = patch.expr !== undefined ? patch.expr : j.expr;
    const newPrompt = patch.prompt !== undefined ? patch.prompt : j.prompt;
    const newEnabled = patch.enabled !== undefined ? patch.enabled : j.enabled;
    const newPolicy = patch.reportPolicy !== undefined ? patch.reportPolicy : j.reportPolicy;

    let newNextRun = j.nextRun;
    if (patch.enabled === false) {
      newNextRun = null;
    } else if (patch.enabled === true && !j.enabled) {
      newNextRun = j.intervalMs ? now + j.intervalMs : nextRun(newExpr, now);
    } else if (patch.expr !== undefined && patch.expr !== j.expr) {
      newNextRun = j.enabled ? nextRun(newExpr, now) : null;
    }

    this.db.prepare(
      "UPDATE jobs SET name=?, expr=?, prompt=?, enabled=?, next_run=?, report_policy=?, grace_ms=?, timeout_ms=?, retries=?, hidden=? WHERE id=?"
    ).run(newName, newExpr, newPrompt, newEnabled ? 1 : 0, newNextRun, newPolicy,
      patch.graceMs !== undefined ? patch.graceMs : j.graceMs, patch.timeoutMs !== undefined ? patch.timeoutMs : j.timeoutMs, patch.retries ?? j.retries,
      (patch.hidden ?? j.hidden) ? 1 : 0, id);

    return this.getJob(id)!;
  }

  deleteJob(id: number, now = Date.now()) {
    const j = this.getJob(id);
    if (!j) throw new Error("no such job " + id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare("SELECT COUNT(*) as c FROM runs WHERE job_id=? AND status='running'").get(id) as { c: number } | undefined;
      if (active && active.c > 0) {
        throw new Error("cannot delete job while running");
      }
      const tombstone = `__deleted_${id}_${now}_${j.name}`;
      this.db.prepare("UPDATE jobs SET deleted_at=?, enabled=0, next_run=NULL, name=? WHERE id=?").run(now, tombstone, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  setEnabled(id: number, on: boolean, now = Date.now()) {
    const j = this.getJob(id);
    if (!j) throw new Error("no such job " + id);
    const next = on ? (j.intervalMs ? now + j.intervalMs : nextRun(j.expr, now)) : null;
    this.db.prepare("UPDATE jobs SET enabled=?, next_run=? WHERE id=?").run(on ? 1 : 0, next, id);
  }

  removeJob(id: number) {
    this.deleteJob(id);
  }

  dueJobs(now: number): Job[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE deleted_at IS NULL AND enabled=1 AND next_run<=? ORDER BY next_run").all(now) as unknown as JobDbRow[]).map((r) => this.job(r));
  }

  earliest(): number | null {
    const r = this.db.prepare("SELECT MIN(next_run) m FROM jobs WHERE deleted_at IS NULL AND enabled=1").get() as { m: number | null } | undefined;
    return r?.m ?? null;
  }

  /** Atomically claim a slot: insert run row + advance next_run. Returns undefined if already claimed, missing, or slot mismatch. */
  claim(job: Job, now: number, unchanged?: string | null): Run | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const freshJob = this.db.prepare("SELECT * FROM jobs WHERE id=? AND deleted_at IS NULL").get(job.id) as JobDbRow | undefined;
      if (!freshJob || !freshJob.enabled) {
        this.db.exec("COMMIT");
        return undefined;
      }

      if (job.nextRun !== null && freshJob.next_run !== null && job.nextRun !== freshJob.next_run) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const activeRun = this.db.prepare("SELECT id FROM runs WHERE job_id=? AND status='running'").get(job.id);
      const dueSlot = freshJob.next_run ?? now;
      const missed = freshJob.grace_ms != null && now - dueSlot > freshJob.grace_ms;
      if (activeRun || missed || unchanged) {
        const slot = dueSlot;
        // Record the skip so history shows why nothing ran.
        this.db.prepare(
          "INSERT OR IGNORE INTO runs(job_id,slot,started_at,ended_at,status,error,reason,job_name,report,read_at) VALUES(?,?,?,?,'skipped',?,?,?,0,NULL)"
        ).run(job.id, slot, now, now,
          unchanged && !activeRun && !missed ? `skipped: ${unchanged}` : missed ? `skipped: slot ${new Date(slot).toISOString()} was ${Math.round((now - slot) / 1000)}s late (grace ${Math.round((freshJob.grace_ms ?? 0) / 1000)}s)` : "skipped: previous run still running",
          unchanged && !activeRun && !missed ? "unchanged" : missed ? "missed" : "overlap", freshJob.name);
        this.db.prepare("UPDATE jobs SET next_run=? WHERE id=?").run(
          freshJob.interval_ms ? Math.max(now, slot) + freshJob.interval_ms : nextRun(freshJob.expr, Math.max(now, slot)),
          job.id
        );
        this.db.exec("COMMIT");
        return undefined;
      }

      const slot = freshJob.next_run ?? now;
      const info = this.db.prepare(
        "INSERT OR IGNORE INTO runs(job_id,slot,started_at,status,job_name,report,read_at) VALUES(?,?,?,'running',?,0,NULL)"
      ).run(job.id, slot, now, freshJob.name);

      this.db.prepare("UPDATE jobs SET next_run=? WHERE id=?").run(
        freshJob.interval_ms ? Math.max(now, slot) + freshJob.interval_ms : nextRun(freshJob.expr, Math.max(now, slot)),
        job.id
      );
      this.db.exec("COMMIT");
      if (!info.changes) return undefined;
      return this.run(this.db.prepare("SELECT * FROM runs WHERE job_id=? AND slot=?").get(job.id, slot) as RunDbRow);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Manual run: insert a run row keyed by the current time. Throws Error('job already running') if any active run. */
  claimManual(job: Job, now: number): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const freshJob = this.db.prepare("SELECT * FROM jobs WHERE id=? AND deleted_at IS NULL").get(job.id) as JobDbRow | undefined;
      if (!freshJob) throw new Error("no such job " + job.id);

      const active = this.db.prepare("SELECT id FROM runs WHERE job_id=? AND status='running'").get(job.id);
      if (active) throw new Error("job already running");
      let slot = now;
      while (this.db.prepare("SELECT id FROM runs WHERE job_id=? AND slot=?").get(job.id, slot)) slot++;
      const info = this.db.prepare(
        "INSERT INTO runs(job_id,slot,started_at,status,job_name,report,read_at) VALUES(?,?,?,'running',?,0,NULL)"
      ).run(job.id, slot, now, freshJob.name);
      this.db.exec("COMMIT");
      return this.getRun(Number(info.lastInsertRowid))!;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Record the run's conversation before its prompt is submitted, so recovery can find work admitted before a crash. */
  attachConversation(runId: number, conversationId: string) {
    this.db.prepare("UPDATE runs SET conversation_id=? WHERE id=? AND status='running'").run(conversationId, runId);
  }

  /** Fix the run's deadline once. Returns the stored value (the first one wins). */
  fixDeadline(runId: number, at: number): number {
    this.db.prepare("UPDATE runs SET deadline_at=? WHERE id=? AND deadline_at IS NULL").run(at, runId);
    return (this.db.prepare("SELECT deadline_at d FROM runs WHERE id=?").get(runId) as { d: number }).d;
  }

  /** A retry is waiting: record the next attempt and when it is due. The failed attempt's ids stay until it starts. */
  setAttempt(runId: number, attempt: number, retryAt: number) {
    this.db.prepare("UPDATE runs SET attempt=?, retry_at=? WHERE id=? AND status='running'").run(attempt, retryAt, runId);
  }

  /** An attempt starts: clear the wait and forget the previous attempt's conversation and submission. */
  beginAttempt(runId: number) {
    this.db.prepare("UPDATE runs SET retry_at=NULL, conversation_id=NULL, submission_id=NULL WHERE id=? AND status='running'").run(runId);
  }

  attach(runId: number, conversationId: string, submissionId: string) {
    this.db.prepare("UPDATE runs SET conversation_id=?, submission_id=? WHERE id=?").run(conversationId, submissionId, runId);
  }

  finish(runId: number, status: "ok" | "error", output: string | null, error: string | null, now = Date.now(), reason: string | null = null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as RunDbRow | undefined;
      if (!run) {
        this.db.exec("COMMIT");
        return;
      }
      if (run.status !== "running") {
        this.db.exec("COMMIT");
        return;
      }

      const job = this.getJobAny(run.job_id);
      const policy = job?.reportPolicy || "always";

      let shouldReport = false;
      if (status === "error") {
        shouldReport = true;
      } else if (!(output || "").trim()) {
        shouldReport = false; // no output: nothing to show in reports
      } else {
        if (policy === "always") {
          shouldReport = true;
        } else if (policy === "failures") {
          shouldReport = false;
        } else if (policy === "changes") {
          const trimmedOutput = (output || "").trim();
          const prevOk = this.db.prepare(
            "SELECT output FROM runs WHERE job_id=? AND status='ok' AND id < ? AND report=1 ORDER BY id DESC LIMIT 1"
          ).get(run.job_id, runId) as { output: string | null } | undefined;
          if (!prevOk) {
            shouldReport = true;
          } else {
            const prevTrimmed = (prevOk.output || "").trim();
            shouldReport = trimmedOutput !== prevTrimmed;
          }
        }
      }

      this.db.prepare(
        "UPDATE runs SET status=?, output=?, error=?, ended_at=?, report=?, reason=?, read_at=COALESCE(read_at, NULL) WHERE id=?"
      ).run(status, output, error, now, shouldReport ? 1 : 0, status === "error" ? reason : null, runId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  reports(options: { history?: boolean; jobId?: number; before?: number; limit?: number; order?: "attention"; cursor?: { rank: number; id: number } } = {}): Run[] {
    const { history = false, jobId, before, limit = 50, order, cursor } = options;
    const params: (string | number)[] = [];
    let query = `
      SELECT r.* FROM runs r
      WHERE r.report=1 AND r.status != 'running'
        AND (TRIM(COALESCE(r.output, '')) != '' OR TRIM(COALESCE(r.error, '')) != '')
    `;
    if (history) {
      // History keeps every report that is not waiting in the inbox: read reports and replaced ones.
      query += " AND r.id NOT IN (" + inboxIds + ")";
    } else {
      // Inbox: the newest unread report per job.
      query += " AND r.id IN (" + inboxIds + ")";
    }
    if (jobId !== undefined) {
      query += " AND r.job_id=?";
      params.push(jobId);
    }
    if (order === "attention") {
      if (cursor) {
        query += " AND ((CASE WHEN r.status = 'error' THEN 0 ELSE 1 END > ?) OR ((CASE WHEN r.status = 'error' THEN 0 ELSE 1 END = ?) AND r.id < ?))";
        params.push(cursor.rank, cursor.rank, cursor.id);
      }
      query += " ORDER BY (CASE WHEN r.status = 'error' THEN 0 ELSE 1 END) ASC, r.id DESC LIMIT ?";
      params.push(limit);
    } else {
      if (before !== undefined) {
        query += " AND r.id<?";
        params.push(before);
      }
      // Keep the ID cursor consistent with newest-first pagination.
      query += " ORDER BY r.id DESC LIMIT ?";
      params.push(limit);
    }

    return (this.db.prepare(query).all(...params) as unknown as RunDbRow[]).map((r) => this.run(r));
  }

  unreadCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) as c FROM (${inboxIds})`).get() as { c: number } | undefined;
    return r?.c ?? 0;
  }

  markAllReportsRead(now = Date.now()): number {
    const info = this.db.prepare(
      `UPDATE runs SET read_at=? WHERE id IN (${inboxIds})`
    ).run(now);
    return Number(info.changes);
  }

  markRead(id: number, read = true): Run {
    const run = this.getRun(id);
    if (!run) throw new Error("no such run " + id);
    if (!run.report) throw new Error("run is not a report");
    const now = read ? Date.now() : null;
    this.db.prepare("UPDATE runs SET read_at=? WHERE id=?").run(now, id);
    return this.getRun(id)!;
  }

  queryRuns(options: { history?: boolean; jobId?: number; status?: "running" | "ok" | "error" | "skipped"; before?: number; limit?: number } = {}): Run[] {
    const { history = false, jobId, status, before, limit = 20 } = options;
    const where: string[] = [], params: (number | string)[] = [];
    if (history) where.push("status != 'running'");
    if (status) { where.push("status=?"); params.push(status); }
    else if (!history) where.push("status IN ('running','error')");
    if (jobId !== undefined) { where.push("job_id=?"); params.push(jobId); }
    if (before !== undefined) { where.push("id<?"); params.push(before); }
    return (this.db.prepare(`SELECT * FROM runs WHERE ${where.join(" AND ") || "1=1"} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as RunDbRow[]).map(r => this.run(r));
  }

  lastRun(jobId: number): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE job_id=? ORDER BY id DESC LIMIT 1").get(jobId) as RunDbRow | undefined;
    return r ? this.run(r) : undefined;
  }

  runs(jobId?: number, limit = 50): Run[] {
    const q = jobId === undefined ? this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM runs WHERE job_id=? ORDER BY id DESC LIMIT ?").all(jobId, limit);
    return (q as unknown as RunDbRow[]).map((r) => this.run(r));
  }

  getRun(id: number): Run | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunDbRow | undefined;
    return r ? this.run(r) : undefined;
  }

  unfinished(): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status='running' ORDER BY id").all() as unknown as RunDbRow[]).map((r) => this.run(r));
  }

  /**
   * Remove the run rows that fell out of the retention windows.
   *
   * The work is bounded: a round visits at most PRUNE_MAX_JOBS jobs, takes at most PRUNE_PER_JOB rows from
   * each of them, removes at most PRUNE_MAX_ROWS rows in total, and stops when its time budget runs out. A
   * running run is never removed, and the newest reports of a job stay however old they are.
   */
  pruneRuns(policy: RetentionPolicy, now = Date.now()): { deleted: number } {
    if (!policy.enabled) return { deleted: 0 };
    const DAY = 86_400_000;
    const perJob = Math.min(1000, Math.max(1, Math.trunc(policy.reportsPerJob)));
    const noiseCutoff = now - Math.max(0, policy.emptyRunDays) * DAY;
    const reportCutoff = now - Math.max(0, policy.reportDays) * DAY;
    const deletedCutoff = now - Math.max(0, policy.deletedJobDays) * DAY;

    const jobs = this.db.prepare("SELECT id, deleted_at FROM jobs ORDER BY id").all() as { id: number; deleted_at: number | null }[];
    if (!jobs.length) return { deleted: 0 };
    // The round starts where the last one stopped, so a job that the time budget cut off is reached next time.
    let cursor = this.pruneCursor % jobs.length;
    const limit = Math.min(PRUNE_MAX_JOBS, jobs.length);

    // The keep list holds the newest reports of the job being cleaned, so they outlive the age window.
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS prune_keep(id INTEGER PRIMARY KEY); DELETE FROM prune_keep; CREATE TEMP TABLE IF NOT EXISTS prune_batch(id INTEGER PRIMARY KEY); DELETE FROM prune_batch;");
    const keep = this.db.prepare(`INSERT OR IGNORE INTO prune_keep(id) SELECT id FROM runs WHERE job_id=? AND ${reportPredicate} ORDER BY id DESC LIMIT ?`);
    const noise = this.db.prepare(`INSERT OR IGNORE INTO prune_batch(id) SELECT id FROM runs WHERE job_id=? AND started_at<? AND ${nonReportPredicate} ORDER BY started_at LIMIT ?`);
    const oldReports = this.db.prepare(`INSERT OR IGNORE INTO prune_batch(id) SELECT id FROM runs WHERE job_id=? AND started_at<? AND ${reportPredicate} AND id NOT IN (SELECT id FROM prune_keep) ORDER BY started_at LIMIT ?`);
    const goneReports = this.db.prepare(`INSERT OR IGNORE INTO prune_batch(id) SELECT id FROM runs WHERE job_id=? AND started_at<? AND ${reportPredicate} ORDER BY started_at LIMIT ?`);

    const deadline = Date.now() + PRUNE_BUDGET_MS;
    let queued = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < limit; i++) {
        if (queued >= PRUNE_MAX_ROWS || Date.now() > deadline) break;
        const job = jobs[cursor]!;
        cursor = (cursor + 1) % jobs.length;
        const gone = job.deleted_at != null;
        const room = PRUNE_MAX_ROWS - queued;
        // The runs of a deleted job go as a block; a live job keeps its newest reports.
        if (!gone) keep.run(job.id, perJob);
        queued += Number(noise.run(job.id, gone ? deletedCutoff : noiseCutoff, Math.min(PRUNE_PER_JOB, room)).changes);
        if (queued >= PRUNE_MAX_ROWS || Date.now() > deadline) break;
        const insert = gone ? goneReports : oldReports;
        queued += Number(insert.run(job.id, gone ? deletedCutoff : reportCutoff, Math.min(PRUNE_PER_JOB, PRUNE_MAX_ROWS - queued)).changes);
        if (queued >= PRUNE_MAX_ROWS || Date.now() > deadline) break;
      }
      this.pruneCursor = cursor;
      // Remove the batch in small chunks, so a round never holds the daemon up on one big delete.
      let deleted = 0;
      for (;;) {
        const info = this.db.prepare("DELETE FROM runs WHERE id IN (SELECT id FROM prune_batch LIMIT 2000)").run();
        deleted += Number(info.changes);
        this.db.prepare("DELETE FROM prune_batch WHERE id IN (SELECT id FROM prune_batch LIMIT 2000)").run();
        if (!info.changes || Date.now() > deadline) break;
      }
      this.db.exec("COMMIT");
      return { deleted };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close() { this.db.close(); }
}

export interface SchedulerOptions {
  harness: Harness;
  store: CronStore;
  /** Model for jobs without their own; a function is read at each run (the UI can change it). */
  defaultModel: ModelRef | (() => ModelRef);
  /** Thinking level for a run on `model`. Unset: the harness default. */
  thinkingLevel?: (model: ModelRef) => StoredThinkingLevel;
  /** Max time one run may take before it is aborted and logged as error. Default 30 min. */
  runTimeoutMs?: number | (() => number);
  /** How long the run log is kept. Read at each cleanup round, so a saved setting applies live. */
  retention?: () => RetentionPolicy;
  log?: (msg: string) => void;
  /** Called once per finished run (ok or error), e.g. to deliver the result. Errors are logged, never thrown. */
  onFinish?: (job: Job | undefined, run: Run) => void | Promise<void>;
  /** Extensions removed from cron conversations, e.g. tools that wait for a human. */
  exclude?: Extension[];
  /** Called when a slot comes due. A returned reason records the slot as skipped (reason "unchanged") and runs nothing. Manual runs ignore it. */
  skipRun?: (job: Job) => string | null;
}

const MAX_TIMER = 2 ** 31 - 1;
/** How long stopRun waits for a cancelled run to settle before it reports the run as still active. */
const STOP_WAIT_MS = 15_000;

/** Live executor of one running run in this process. `abort` is set once there is something to cancel. */
interface ActiveRun { reason?: string; code?: string; timeoutMs?: number; deadlineAt?: number; total?: number; abort?: () => Promise<void> | void; done?: Promise<void> }

export type StopOutcome =
  | "stopped"            // the run was cancelled and is now logged as error with the stop reason
  | "finished"           // the run settled on its own (ok or error) before the cancellation took effect
  | "already_finished"   // the run was not running when the stop was requested
  | "not_tracked"        // the run row says running, but no executor in this process owns it
  | "still_running";     // cancellation was requested, but the run did not settle within the wait

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private pruneTimer: NodeJS.Timeout | undefined;
  private inflight = new Set<Promise<void>>();
  private active = new Map<number, ActiveRun>();
  private wakers = new Set<() => void>();
  private stopped = true;
  private o: Required<Omit<SchedulerOptions, "thinkingLevel" | "skipRun">> & Pick<SchedulerOptions, "thinkingLevel" | "skipRun">;
  constructor(o: SchedulerOptions) { this.o = { ...o, runTimeoutMs: o.runTimeoutMs ?? 30 * 60_000, retention: o.retention ?? (() => defaultRetention), log: o.log ?? (() => {}), onFinish: o.onFinish ?? (() => {}), exclude: o.exclude ?? [] }; }

  /** Re-arm the timer after jobs change (e.g. the model added a job). */
  rearm() { this.arm(); }

  private async notify(runId: number) {
    const run = this.o.store.getRun(runId);
    if (!run || run.status === "running") return;
    try { await this.o.onFinish(this.o.store.getJobAny(run.jobId), run); }
    catch (e) { this.o.log(`onFinish for run ${runId} failed: ${errText(e)}`); }
  }

  /** Recover runs interrupted by a crash, then start the tick loop. */
  async start() {
    this.stopped = false;
    this.o.harness.resume();
    for (const r of this.o.store.unfinished()) this.launch(r, (a) => this.recover(r, a));
    this.arm();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
    this.prune();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const w of [...this.wakers]) w();
    await Promise.allSettled([...this.inflight]);
  }

  /** Clean the run log. The round is bounded, so it never holds the daemon up. */
  private prune() {
    if (this.stopped) return;
    try {
      const { deleted } = this.o.store.pruneRuns(this.o.retention());
      if (deleted) this.o.log(`cron: pruned ${deleted} old run rows`);
    } catch (e) { this.o.log(`cron prune failed: ${errText(e)}`); }
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
      const run = this.o.store.claim(job, now, this.o.skipRun?.(job) ?? null);
      if (run) this.launch(run, (a) => this.execute(job, run, a));
    }
    this.arm();
  }

  /** Start a job immediately, outside its schedule. The schedule is unchanged. */
  runNow(id: number): Run {
    const job = this.o.store.getJob(id);
    if (!job) throw new Error("no such job " + id);
    const run = this.o.store.claimManual(job, Date.now());
    this.launch(run, (a) => this.execute(job, run, a));
    return run;
  }

  /**
   * Cancel an active run and report what really happened. Agent runs abort their conversation; script runs kill
   * the process (SIGTERM). The job's schedule is unchanged: disable the job to stop future runs.
   */
  async stopRun(runId: number, reason = "stopped by request"): Promise<{ outcome: StopOutcome; run: Run }> {
    const run = this.o.store.getRun(runId);
    if (!run) throw new Error("no such run " + runId);
    if (run.status !== "running") return { outcome: "already_finished", run };
    const a = this.active.get(runId);
    if (!a) return { outcome: "not_tracked", run };
    if (!a.reason) { a.reason = reason; a.code = "stopped"; }
    try { await a.abort?.(); } catch (e) { this.o.log(`stop run ${runId}: abort failed: ${errText(e)}`); }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([a.done, new Promise<void>((r) => { timer = setTimeout(r, STOP_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    const after = this.o.store.getRun(runId)!;
    if (after.status === "running") return { outcome: "still_running", run: after };
    return { outcome: after.status === "error" && after.error?.startsWith(`stopped: ${a.reason}`) ? "stopped" : "finished", run: after };
  }

  /** Ids of runs that have a live executor in this process. */
  activeRuns(): number[] { return [...this.active.keys()]; }

  private launch(run: Run, body: (a: ActiveRun) => Promise<void>) {
    const a: ActiveRun = {};
    this.active.set(run.id, a);
    a.done = body(a).finally(() => this.active.delete(run.id));
    this.track(a.done.then(() => this.notify(run.id)));
  }

  private track(p: Promise<void>) { this.inflight.add(p); void p.finally(() => this.inflight.delete(p)); }

  /** Error text for a run that ended while a stop or timeout was requested. */
  private failText(a: ActiveRun, detail: string) { return a.reason ? `stopped: ${a.reason}` : detail; }

  private reasonCode(a: ActiveRun, fallback: string) { return a.reason ? (a.code ?? "stopped") : fallback; }

  /** Arm the run's time limit: the time left until the run-level deadline. The caller must clear the timer. */
  private deadline(a: ActiveRun, run: Run, abort: () => Promise<void> | void) {
    return setTimeout(() => {
      this.expire(a);
      void Promise.resolve(abort()).catch((e) => this.o.log(`run ${run.id} timeout abort failed: ${errText(e)}`));
    }, Math.max(0, (a.deadlineAt ?? Date.now()) - Date.now()));
  }

  private expire(a: ActiveRun) {
    if (!a.reason) { a.reason = `timed out after ${(a.total ?? 0) / 1000}s`; a.code = "timeout"; }
  }

  /** Throw if the run deadline has passed. Called before each step that admits work. */
  private guard(a: ActiveRun) {
    if (Date.now() >= (a.deadlineAt ?? Infinity)) this.expire(a);
    if (a.reason) throw new Error(this.failText(a, ""));
  }

  private requestId(run: Run, attempt: number) { return `cron-${run.jobId}-${run.slot}${attempt ? `-a${attempt}` : ""}`; }

  /**
   * Run a job to completion, retrying failed attempts (never after a stop, timeout or interrupt).
   * `first` replaces the first attempt (recovery of an attempt that was in flight); `waitUntil` delays it (a retry
   * that was waiting). The time limit covers the whole run, waits included.
   */
  private async execute(job: Job, run: Run, a: ActiveRun = {}, first?: () => Promise<string | null>, waitUntil?: number) {
    const { store } = this.o;
    a.timeoutMs = job.timeoutMs ?? undefined;
    a.deadlineAt = store.fixDeadline(run.id, run.deadlineAt ?? run.startedAt + (a.timeoutMs ?? this.timeoutMs()));
    a.total = a.deadlineAt - run.startedAt;
    let n = run.attempt;
    for (;;) {
      if (waitUntil !== undefined) {
        const until = waitUntil; waitUntil = undefined;
        await this.wait(a, Math.min(until, a.deadlineAt));
        if (Date.now() >= a.deadlineAt) this.expire(a);
        if (!a.reason && this.stopped) return; // stays running with retry_at set; the next start continues it
        if (a.reason) { store.finish(run.id, "error", null, this.failText(a, ""), Date.now(), this.reasonCode(a, "stopped")); return; }
      }
      try {
        const attempt = first ?? (() => this.attempt(job, run, n, a));
        first = undefined;
        store.finish(run.id, "ok", await attempt(), null);
        return;
      } catch (e) {
        if (e instanceof Interrupted) { store.finish(run.id, "error", null, e.message, Date.now(), "interrupted"); return; }
        const text = this.failText(a, errText(e));
        if (!a.reason && !this.stopped && n < job.retries && Date.now() < a.deadlineAt) {
          this.o.log(`job ${job.name} run ${run.id} attempt ${n + 1} failed, retrying: ${text}`);
          waitUntil = Date.now() + Math.min(30_000 * 2 ** n, 600_000);
          n++;
          store.setAttempt(run.id, n, waitUntil);
          a.abort = undefined;
          continue;
        }
        store.finish(run.id, "error", null, text, Date.now(), this.reasonCode(a, job.execution ? "script_failed" : "agent_failed"));
        this.o.log(`job ${job.name} run ${run.id} failed: ${text}`);
        return;
      }
    }
  }

  /** Sleep until `until`. A stop request or scheduler stop wakes it early. */
  private wait(a: ActiveRun, until: number) {
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(t); this.wakers.delete(done); a.abort = undefined; resolve(); };
      const t = setTimeout(done, Math.max(0, until - Date.now()));
      this.wakers.add(done);
      a.abort = done;
    });
  }

  /** One attempt. Resolves with the output; throws on failure. */
  private async attempt(job: Job, run: Run, n: number, a: ActiveRun): Promise<string | null> {
    const { store, harness } = this.o;
    store.beginAttempt(run.id);
    if (job.execution) {
      const { command, cwd } = job.execution;
      if (!command.length) throw new Error("empty script command");
      const ac = new AbortController();
      a.abort = () => ac.abort();
      const timeout = this.deadline(a, run, () => ac.abort());
      try {
        const proc = Bun.spawn([command[0]!, ...command.slice(1)], {
          cwd,
          signal: ac.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        const cap = async (stream: ReadableStream<Uint8Array>) => {
          const chunks: Uint8Array[] = []; let size = 0;
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > MAX_SCRIPT_OUTPUT) { proc.kill(); throw new Error(`script output exceeded ${MAX_SCRIPT_OUTPUT} bytes`); }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString("utf8");
        };
        const [stdoutText, stderrText, exitCode] = await Promise.all([cap(proc.stdout), cap(proc.stderr), proc.exited]);
        if (ac.signal.aborted) { this.guard(a); throw new Error(a.reason ?? "script aborted"); }
        if (exitCode !== 0) {
          throw new Error(`Command failed with exit code ${exitCode}\n${stderrText}`);
        }
        return stdoutText;
      } finally { clearTimeout(timeout); }
    }
    this.guard(a);
    const d = this.o.defaultModel;
    const model = job.model ?? (typeof d === "function" ? d() : d);
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, ...(this.o.thinkingLevel ? { thinkingLevel: this.o.thinkingLevel(model) } : {}), ...(this.o.exclude.length ? { extensions: { remove: this.o.exclude } } : {}) },
      // Hidden jobs mark the conversation at creation, so the session list never shows it, also after the run row is pruned.
      ...(job.hidden ? { init: async (tx: Tx, id: ConversationId) => { await tx.appendEntry(id, { kind: HIDDEN_SESSION, data: { cronJob: job.id, run: run.id } }); } } : {}) }, context);
    store.attachConversation(run.id, String(conv.id));
    this.guard(a);
    const sub = await conv.submit({ type: "input", content: job.prompt, requestId: this.requestId(run, n) }, context);
    store.attach(run.id, String(conv.id), String(sub.id));
    return this.settle(run, sub, conv, a);
  }

  private async recover(run: Run, a: ActiveRun) {
    const { store, harness } = this.o;
    const interrupted = (why: string) => store.finish(run.id, "error", null, why, Date.now(), "interrupted");
    try {
      const job = store.getJobAny(run.jobId);
      if (!job) { interrupted("interrupted: job no longer exists"); return; }
      // A retry was waiting: continue it. The failed attempt is over, so running the next one is safe.
      if (run.retryAt !== null) { this.o.log(`recovering run ${run.id} (retry ${run.attempt + 1} was waiting)`); return await this.execute(job, run, a, undefined, run.retryAt); }
      // An attempt was in flight: pick it up, then use the normal retry policy for its outcome.
      const resume = async () => {
        if (!run.submissionId) {
          // Crash window: the conversation was recorded, the submission may or may not have been admitted.
          // submit() with the same requestId returns the existing submission, or admits it once.
          const conv = run.conversationId ? await harness.conversation(Number(run.conversationId) as ConversationId, context) : undefined;
          if (!conv) throw new Interrupted("interrupted before the run started (no conversation recorded)");
          this.guard(a);
          const sub = await conv.submit({ type: "input", content: job.prompt, requestId: this.requestId(run, run.attempt) }, context);
          store.attach(run.id, String(conv.id), String(sub.id));
          this.o.log(`recovering run ${run.id} (reconciled submission)`);
          return this.settle(run, sub, conv, a);
        }
        const sub = await harness.submission(Number(run.submissionId) as SubmissionId, context);
        if (!sub) throw new Interrupted("submission not found on recovery");
        this.o.log(`recovering run ${run.id}`);
        const conv = run.conversationId ? await harness.conversation(Number(run.conversationId) as ConversationId, context) : undefined;
        return this.settle(run, sub, conv, a);
      };
      await this.execute(job, run, a, resume);
    } catch (e) { store.finish(run.id, "error", null, this.failText(a, errText(e)), Date.now(), this.reasonCode(a, "agent_failed")); }
  }

  private timeoutMs() { const t = this.o.runTimeoutMs; return typeof t === "function" ? t() : t; }

  private async answerText(conv: Conversation | undefined, id: EntryId | undefined): Promise<string | null> {
    if (!conv || !id) return null;
    const view = await conv.context(context);
    const e = view.entries.find((x) => x.id === id);
    const msg = e?.model?.[0];
    if (!msg) return null;
    return typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") : "";
  }

  /** Wait for the submission. Resolves with the answer text; throws if it did not finish. */
  private async settle(run: Run, sub: Submission, conv: Conversation | undefined, a: ActiveRun): Promise<string | null> {
    // Submission.abort() only withdraws a queued input; once the turn has started it returns "already_placed"
    // and cancels nothing. Aborting the run's own (ownerless) conversation cancels the live turn.
    a.abort = async () => { if ((await sub.abort(context)) === "already_placed") await conv?.abort(context); };
    const timeout = this.deadline(a, run, () => a.abort?.());
    try {
      const s = await sub.wait(context);
      if (s.status === "done") return await this.answerText(conv, s.answer);
      throw new Error(`submission ${s.status}: ${JSON.stringify(s).slice(0, 500)}`);
    } finally { clearTimeout(timeout); }
  }
}

const MAX_SCRIPT_OUTPUT = 4 * 1024 * 1024;
class Interrupted extends Error {}

function errText(e: unknown) { return e instanceof Error ? e.message : String(e); }
