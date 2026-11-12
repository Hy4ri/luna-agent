// Contract: the cron inbox and the unread badge must not slow down as run history grows. Looking up the newest
// report of each job has to cost one index seek per job, not a pass over every report ever kept. The old shape
// grouped the newest report per job over the whole run table, so a database with many reported runs froze the
// daemon: the web badge polls the inbox every 30 seconds and the query is synchronous SQLite on the daemon.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { CronStore } from "../src/scheduler.js";

const JOBS = 100;
const RUNS_PER_JOB = 5_000;
/** The old shape needed about 190 ms for this history size; the per-job seek needs well under a millisecond. */
const BUDGET_MS = 50;

function seed(store: CronStore) {
  const now = Date.now();
  const jobs: { id: number; name: string }[] = [];
  for (let i = 0; i < JOBS; i++) jobs.push(store.addJob(`perf-${i}`, "0 * * * *", "Report", undefined, now));
  const insert = store.db.prepare(
    "INSERT INTO runs(job_id,slot,started_at,ended_at,status,output,error,job_name,report,read_at) VALUES(?,?,?,?,'ok',?,NULL,?,1,NULL)"
  );
  const newest = new Map<number, number>();
  store.db.exec("BEGIN");
  for (const job of jobs) {
    for (let r = 0; r < RUNS_PER_JOB; r++) {
      const info = insert.run(job.id, r, now - (RUNS_PER_JOB - r) * 60_000, now, `output ${r}`, job.name);
      newest.set(job.id, Number(info.lastInsertRowid));
    }
  }
  store.db.exec("COMMIT");
  return { jobs, newest };
}

test("cron inbox lookup stays a per-job seek while the run history grows", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-cron-inbox-perf-"));
  const store = new CronStore(join(dir, "cron.db"));
  try {
    const { jobs, newest } = seed(store);

    // The partial index over report rows is the fix. It must exist after the migration.
    const indexes = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'").all() as { name: string }[]).map(i => i.name);
    expect(indexes.includes("runs_report_pred")).toBeTruthy() /* `missing runs_report_pred index, found ${indexes.join(", ")}` */;

    // The store must expose the inbox query so its plan can be checked.
    expect(typeof store.inboxSql).toBe("string") /* "the store must expose the inbox query" */;
    const inboxSql = store.inboxSql as string;

    // The plan must show one index seek per job and no grouping over the history.
    const plan = (store.db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) as c FROM (${inboxSql})`).all() as { detail: string }[]).map(p => p.detail);
    const shape = plan.join(" | ");
    expect(shape).toMatch(/runs_report_pred/) /* `inbox plan does not use the report index: ${shape}` */;
    expect(shape).not.toMatch(/TEMP B-TREE FOR GROUP BY/) /* `inbox plan groups over the whole history: ${shape}` */;
    expect(shape).not.toMatch(/SCAN runs/) /* `inbox plan scans the run table: ${shape}` */;

    // And the plan of the inbox page itself, not only the count.
    const pagePlan = (store.db.prepare(
      `EXPLAIN QUERY PLAN SELECT r.* FROM runs r WHERE r.report=1 AND r.status != 'running' AND r.id IN (${inboxSql}) ORDER BY r.id DESC LIMIT 50`
    ).all() as { detail: string }[]).map(p => p.detail).join(" | ");
    expect(pagePlan).toMatch(/runs_report_pred/) /* `inbox page plan does not use the report index: ${pagePlan}` */;
    expect(pagePlan).not.toMatch(/TEMP B-TREE FOR GROUP BY/) /* `inbox page plan groups over the whole history: ${pagePlan}` */;

    // The count and the page stay fast while the history holds half a million report rows.
    store.unreadCount();
    let started = performance.now();
    const count = store.unreadCount();
    const countMs = performance.now() - started;
    expect(count).toBe(JOBS);
    expect(countMs < BUDGET_MS).toBeTruthy() /* `unreadCount took ${countMs.toFixed(1)}ms with ${total} runs` */;

    started = performance.now();
    const inbox = store.reports({ limit: 50 });
    const inboxMs = performance.now() - started;
    expect(inbox.length).toBe(50);
    expect(inboxMs < BUDGET_MS).toBeTruthy() /* `inbox page took ${inboxMs.toFixed(1)}ms with ${total} runs` */;

    started = performance.now();
    const history = store.reports({ history: true, limit: 50 });
    const historyMs = performance.now() - started;
    expect(history.length).toBe(50);
    expect(historyMs < BUDGET_MS).toBeTruthy() /* `history page took ${historyMs.toFixed(1)}ms with ${total} runs` */;

    // The semantics stay the same: one inbox entry per job, and it is that job's newest report.
    const all = store.reports({ limit: JOBS });
    expect(all.length).toBe(JOBS);
    expect(new Set(all.map(run => run.jobId)).size).toBe(JOBS);
    for (const job of jobs) {
      const shown = all.find(run => run.jobId === job.id);
      expect(shown?.id).toBe(newest.get(job.id)) /* `job ${job.id} shows the wrong report` */;
    }
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
