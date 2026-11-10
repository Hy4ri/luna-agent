// Contract: the scheduled-run log is cleaned on a retention schedule. Runs without a report leave first,
// reports keep a per-job tail, a running run and the report in the inbox stay, the runs of a deleted job
// go with their own window, and one round stays bounded. No other store test covers the cleanup, so a wrong
// window, an over-eager rule, or an unbounded round would go unnoticed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CronStore, PRUNE_MAX_ROWS, PRUNE_PER_JOB, defaultRetention } from "../src/scheduler.js";

const DAY = 86_400_000;

function open() {
  const dir = mkdtempSync(join(tmpdir(), "luna-cron-retention-"));
  return { dir, store: new CronStore(join(dir, "cron.db")) };
}
function ids(store: CronStore) {
  return (store.db.prepare("SELECT id FROM runs ORDER BY id").all() as { id: number }[]).map(row => row.id);
}
function count(store: CronStore) {
  return (store.db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
}
/** Insert finished runs straight into the table: a test that seeds thousands of rows cannot afford a round trip each. */
function seedRuns(store: CronStore, jobId: number, count: number, startedAt: number, output: string | null, report = 0) {
  const ins = store.db.prepare(
    "INSERT INTO runs(job_id,slot,started_at,ended_at,status,output,error,job_name,report,read_at) VALUES(?,?,?,?,'ok',?,NULL,'',?,NULL)"
  );
  store.db.exec("BEGIN");
  for (let i = 0; i < count; i++) ins.run(jobId, startedAt + i, startedAt + i, startedAt + i, output, report);
  store.db.exec("COMMIT");
}

test("runs without a report leave the log after the empty-run window", () => {
  const { dir, store } = open();
  try {
    const now = 200 * DAY;
    const job = store.addJob("noise", "0 * * * *", "Noise", undefined, now);
    const old = store.claimManual(job, now - 8 * DAY);
    store.finish(old.id, "ok", "   ", null, now - 8 * DAY + 1);
    const recent = store.claimManual(job, now - 2 * DAY);
    store.finish(recent.id, "ok", "", null, now - 2 * DAY + 1);
    // A run that is still going is never removed.
    const busy = store.addJob("busy", "0 * * * *", "Busy", undefined, now);
    const running = store.claimManual(busy, now - 40 * DAY);

    const { deleted } = store.pruneRuns({ ...defaultRetention, emptyRunDays: 7 }, now);
    assert.equal(deleted, 1);
    assert.deepEqual(ids(store).sort(), [recent.id, running.id].sort());
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reports keep the newest tail per job, and the report in the inbox survives the cleanup", () => {
  const { dir, store } = open();
  try {
    const now = 400 * DAY;
    const job = store.addJob("reports", "0 * * * *", "Reports", undefined, now);
    const old: number[] = [], recent: number[] = [];
    for (const age of [120, 110, 100, 95]) {
      const run = store.claimManual(job, now - age * DAY);
      store.finish(run.id, "ok", `old ${age}`, null, now - age * DAY + 1);
      old.push(run.id);
    }
    for (const age of [3, 1]) {
      const run = store.claimManual(job, now - age * DAY);
      store.finish(run.id, "ok", `new ${age}`, null, now - age * DAY + 1);
      recent.push(run.id);
    }

    // The newest three reports stay whatever their age; the rest go once they leave the window.
    const { deleted } = store.pruneRuns({ ...defaultRetention, reportDays: 90, reportsPerJob: 3 }, now);
    assert.equal(deleted, 3);
    assert.deepEqual(ids(store), [old[3]!, ...recent].sort((a, b) => a - b));
    // The inbox still holds the newest report, and it is still unread.
    assert.equal(store.unreadCount(), 1);
    assert.deepEqual(store.reports().map(run => run.id), [recent[1]]);
    assert.ok(store.reports({ history: true, limit: 100 }).some(run => run.id === old[3]!));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the runs of a deleted job go after the deleted-job window", () => {
  const { dir, store } = open();
  try {
    const now = 600 * DAY;
    const job = store.addJob("gone", "0 * * * *", "Gone", undefined, now);
    const old = store.claimManual(job, now - 40 * DAY);
    store.finish(old.id, "ok", "output", null, now - 40 * DAY + 1);
    const recent = store.claimManual(job, now - 5 * DAY);
    store.finish(recent.id, "ok", "output", null, now - 5 * DAY + 1);
    store.deleteJob(job.id, now);

    const { deleted } = store.pruneRuns({ ...defaultRetention, deletedJobDays: 30 }, now);
    assert.equal(deleted, 1);
    assert.deepEqual(ids(store), [recent.id]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("one cleanup round removes a bounded number of rows", () => {
  const { dir, store } = open();
  try {
    const now = 800 * DAY;
    const job = store.addJob("noisy", "0 * * * *", "Noisy", undefined, now);
    seedRuns(store, job.id, PRUNE_PER_JOB + 25, now - 200 * DAY, null);

    let rounds = 0, deleted = 0;
    for (;;) {
      const res = store.pruneRuns({ ...defaultRetention, emptyRunDays: 7 }, now);
      assert.ok(res.deleted <= PRUNE_PER_JOB, `one job gave ${res.deleted} rows in a round`);
      deleted += res.deleted; rounds++;
      if (!res.deleted || rounds > 10) break;
    }
    assert.equal(count(store), 0, "the backlog is cleared");
    assert.ok(rounds > 1, "a backlog this size takes more than one round");
    assert.equal(deleted, PRUNE_PER_JOB + 25);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("one cleanup round never removes more rows than the round allows", () => {
  const { dir, store } = open();
  try {
    const now = 900 * DAY;
    const jobs = ["a", "b", "c"].map(name => store.addJob(name, "0 * * * *", "Noisy", undefined, now));
    for (const job of jobs) seedRuns(store, job.id, PRUNE_PER_JOB + 100, now - 200 * DAY, null);

    const res = store.pruneRuns({ ...defaultRetention, emptyRunDays: 7 }, now);
    assert.ok(res.deleted <= PRUNE_MAX_ROWS, `a round removed ${res.deleted} rows`);
    assert.ok(res.deleted > 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the cleanup can be turned off", () => {
  const { dir, store } = open();
  try {
    const now = 900 * DAY;
    const job = store.addJob("off", "0 * * * *", "Off", undefined, now);
    const run = store.claimManual(job, now - 400 * DAY);
    store.finish(run.id, "ok", "", null, now - 400 * DAY + 1);
    const { deleted } = store.pruneRuns({ ...defaultRetention, enabled: false }, now);
    assert.equal(deleted, 0);
    assert.equal(count(store), 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
