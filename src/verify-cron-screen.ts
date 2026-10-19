// Deterministic Cron storage/API checks. No external services or paid model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { context, openLuna } from "./luna.js";
import { CronStore, Scheduler, type Job } from "./scheduler.js";
import { createApp } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "luna-cron-screen-"));
const path = join(dir, "cron.db");
const old = new DatabaseSync(path);
old.exec(`CREATE TABLE jobs(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,expr TEXT NOT NULL,prompt TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,next_run INTEGER,model TEXT,created_at INTEGER NOT NULL);
CREATE TABLE runs(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,slot INTEGER NOT NULL,started_at INTEGER NOT NULL,ended_at INTEGER,status TEXT NOT NULL,conversation_id TEXT,submission_id TEXT,output TEXT,error TEXT,UNIQUE(job_id,slot));
INSERT INTO jobs VALUES(1,'legacy','@daily','legacy prompt',0,NULL,NULL,1);
INSERT INTO runs VALUES(1,1,1,1,2,'ok',NULL,NULL,'legacy output',NULL);`);
old.close();
let store = new CronStore(path);
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const harness = await openLuna({ dbPath: join(dir, "luna.db"), memory: join(dir, "memory.db"), models, cwd: dir });
let scheduler = new Scheduler({ harness, store, defaultModel: model });
try {
  assert.equal(store.getJob(1)!.reportPolicy, "always");
  assert.equal(store.getRun(1)!.jobName, "legacy");
  assert.equal(store.getRun(1)!.report, true);
  assert.equal(store.reports().length, 1);
  assert.equal(store.reports({ history: true }).length, 0);
  store.markRead(1);
  store.close(); store = new CronStore(path);
  assert.ok(store.getRun(1)!.readAt);
  assert.equal(store.unreadCount(), 0);
  console.log("OK migration and read state persist without re-reporting on reopen");

  let clock = Date.now() + 1000;
  const add = (name: string, policy: "always" | "changes" | "failures" = "always") => store.addJob(name, "@daily", "self-contained prompt", undefined, clock, policy);
  const finish = (job: Job, output: string | null, error: string | null = null) => {
    const r = store.claimManual(job, ++clock);
    store.finish(r.id, error ? "error" : "ok", output, error, ++clock);
    return store.getRun(r.id)!;
  };
  const always = add("always"), changes = add("changes", "changes"), failures = add("failures", "failures");
  assert.throws(() => add(""));
  assert.throws(() => store.updateJob(always.id, { reportPolicy: "bogus" as any }));
  const a1 = finish(always, "first"), a2 = finish(always, "second");
  const c1 = finish(changes, "one"), c2 = finish(changes, " one\n"), c3 = finish(changes, "two");
  const f1 = finish(failures, "quiet"), f2 = finish(failures, null, "broken");
  assert.equal(a1.report, true); assert.equal(a2.report, true);
  assert.equal(c1.report, true); assert.equal(c2.report, false); assert.equal(c3.report, true);
  assert.equal(f1.report, false); assert.equal(f2.report, true);
  assert.deepEqual(store.reports({ jobId: changes.id }).map(r => r.id), [c3.id]);
  assert.deepEqual(store.reports({ history: true, jobId: changes.id }).map(r => r.id), [c1.id]);
  assert.deepEqual(store.reports({ before: c3.id }).map(r => r.id), [a2.id, 1]);
  assert.equal(store.reports({ limit: 1 }).length, 1);
  assert.equal(store.unreadCount(), 5);
  store.markRead(a1.id); assert.equal(store.unreadCount(), 4);
  store.finish(a1.id, "ok", "changed duplicate finish", null, ++clock);
  assert.equal(store.getRun(a1.id)!.output, "first");
  assert.ok(store.getRun(a1.id)!.readAt);
  store.markRead(a1.id, false); assert.equal(store.unreadCount(), 5);
  assert.throws(() => store.markRead(c2.id));
  assert.throws(() => store.markRead(99999));
  console.log("OK report policies, trim comparison, latest/history, cursor, unread and idempotent completion");

  const nextBefore = store.getJob(always.id)!.nextRun;
  assert.throws(() => store.updateJob(always.id, { name: "should not persist", expr: "bad" }));
  assert.equal(store.getJob(always.id)!.name, "always");
  store.updateJob(always.id, { name: "renamed", prompt: "new prompt", reportPolicy: "changes" });
  assert.equal(store.getJob(always.id)!.nextRun, nextBefore);
  assert.equal(store.getRun(a1.id)!.jobName, "always");
  store.setEnabled(always.id, false);
  store.updateJob(always.id, { expr: "0 9 * * *" });
  assert.equal(store.getJob(always.id)!.nextRun, null);
  const script = store.addJob("script", "@daily", "");
  store.db.prepare("UPDATE jobs SET execution=?,interval_ms=? WHERE id=?").run(JSON.stringify({ command: ["not-executed"] }), 60000, script.id);
  assert.throws(() => store.updateJob(script.id, { expr: "@hourly" }));
  store.updateJob(script.id, { prompt: "", reportPolicy: "failures" });
  assert.equal(store.getJob(script.id)!.intervalMs, 60000);
  console.log("OK atomic edit validation, schedule stability, snapshots, disabled schedule, imported script compatibility");

  const busyJob = add("busy"), active = store.claimManual(busyJob, ++clock);
  assert.throws(() => store.claimManual(busyJob, ++clock), /running/);
  assert.throws(() => store.removeJob(busyJob.id), /running/);
  const due = store.getJob(busyJob.id)!;
  assert.equal(store.claim(due, due.nextRun! + 1), undefined);
  assert.ok(store.getJob(busyJob.id)!.nextRun! > due.nextRun!);
  assert.equal(store.runs(busyJob.id).length, 1);
  assert.ok(store.queryRuns().some(r => r.id === active.id));
  assert.ok(store.queryRuns().some(r => r.id === f2.id));
  assert.ok(store.queryRuns().every(r => r.status !== "ok"));
  assert.ok(store.queryRuns({ history: true }).every(r => r.status !== "running"));
  assert.deepEqual(store.queryRuns({ history: true, jobId: changes.id, status: "ok", before: c3.id }).map(r => r.id), [c2.id, c1.id]);
  store.finish(active.id, "ok", "done", null, ++clock);
  const claimed = store.claim(store.getJob(busyJob.id)!, store.getJob(busyJob.id)!.nextRun! + 1)!;
  assert.ok(claimed);
  store.finish(claimed.id, "ok", "scheduled", null, ++clock);
  assert.equal(store.claim({ ...busyJob, nextRun: claimed.slot }, ++clock), undefined);
  store.removeJob(busyJob.id);
  assert.equal(store.getJob(busyJob.id), undefined);
  assert.ok(store.getRun(active.id));
  assert.equal(store.getRun(active.id)!.jobName, "busy");
  assert.ok(add("busy").id !== busyJob.id);
  assert.throws(() => store.claimManual(busyJob, ++clock), /no such job/);
  const collision = add("same-millisecond");
  const sameTime = ++clock, firstCollision = store.claimManual(collision, sameTime);
  store.finish(firstCollision.id, "ok", "first", null, ++clock);
  const secondCollision = store.claimManual(collision, sameTime);
  assert.notEqual(firstCollision.id, secondCollision.id);
  assert.notEqual(firstCollision.slot, secondCollision.slot);
  store.finish(secondCollision.id, "ok", "second", null, ++clock);
  console.log("OK manual/scheduled overlap prevention, duplicate slot, same-ms manual runs, filters, soft deletion and name reuse");

  scheduler = new Scheduler({ harness, store, defaultModel: model });
  const app = createApp({ harness, models, store, scheduler, agent: { model }, token: "test" });
  const req = (p: string, method = "GET", body?: unknown) => app.request(p, { method, headers: { authorization: "Bearer test", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await app.request("/v1/cron/reports")).status, 401);
  const shell = await (await req("/")).text();
  const asset = /src="([^"]+\.js)"/.exec(shell)?.[1];
  assert.ok(asset?.startsWith("/assets/"), "Vue shell references a built script");
  const builtScript = await req(asset!);
  assert.equal(builtScript.status, 200);
  assert.ok(builtScript.headers.get("content-type")?.startsWith("text/javascript"));
  assert.equal((await req("/cron.js")).status, 404, "Legacy frontend is not served");
  const snapshot: any = await (await req("/v1/cron")).json();
  assert.equal(typeof snapshot.timezone, "string"); assert.equal(snapshot.unreadCount, store.unreadCount());
  assert.ok(snapshot.jobs.every((j: any) => "lastRun" in j));
  const summary: any = await (await req("/v1/cron?summary=1")).json();
  assert.equal(summary.runs.length, 0, "Summary must not fetch hidden run history");
  assert.ok(snapshot.runs.length > 0, "Default route preserves old client compatibility");
  const created = await req("/v1/cron", "POST", { name: "api", expr: "@daily", prompt: "hello", reportPolicy: "changes" });
  assert.equal(created.status, 201);
  const job: any = await created.json();
  assert.equal((await req(`/v1/cron/${job.id}`, "PATCH", { name: "api edit", prompt: "edited", reportPolicy: "failures", enabled: false })).status, 200);
  assert.equal(store.getJob(job.id)!.name, "api edit");
  for (const bad of [null, [], {}, { name: 1 }, { enabled: "false" }, { reportPolicy: null }, { unknown: true }, { prompt: "" }]) {
    assert.equal((await req(`/v1/cron/${job.id}`, "PATCH", bad)).status, 400, JSON.stringify(bad));
  }
  for (const bad of [{ name: "new", expr: "@daily", prompt: "" }, { name: "new", expr: "bad", prompt: "a" }, { name: "new", expr: "@daily", prompt: "a", execution: { command: ["unsafe"] } }]) {
    assert.equal((await req("/v1/cron", "POST", bad)).status, 400);
  }
  assert.equal((await req(`/v1/cron/${script.id}`, "PATCH", { prompt: "", reportPolicy: "always" })).status, 200);
  for (const p of ["reports?limit=0", "reports?limit=101", "reports?jobId=NaN", "runs?before=-1", "runs?status=bad", "runs?limit=1.1"]) {
    assert.equal((await req(`/v1/cron/${p}`)).status, 400, p);
  }
  const apiActive = store.claimManual(store.getJob(job.id)!, ++clock);
  assert.equal((await req(`/v1/cron/${job.id}/run`, "POST", {})).status, 409);
  assert.equal((await req(`/v1/cron/${job.id}`, "DELETE")).status, 409);
  store.finish(apiActive.id, "error", null, "API failure", ++clock);
  assert.equal((await req(`/v1/cron/reports/${apiActive.id}`, "PATCH", { read: true })).status, 200);
  assert.ok(store.getRun(apiActive.id)!.readAt);
  assert.equal((await req(`/v1/cron/reports/${apiActive.id}`, "PATCH", { read: true, unknown: 1 })).status, 400);
  assert.equal((await req(`/v1/cron/runs/${apiActive.id}`)).status, 200);
  assert.equal((await req(`/v1/cron/${job.id}`, "DELETE")).status, 200);
  assert.equal((await req(`/v1/cron/runs/${apiActive.id}`)).status, 200);
  assert.equal((await req(`/v1/cron/${job.id}`, "PATCH", { enabled: true })).status, 404);
  assert.equal((await req("/v1/cron/runs/999999")).status, 404);
  console.log("CRON_SCREEN_OK: migrations, policies, history, pagination, read state, edit validation, overlap, deletion, authenticated API");
} finally {
  await scheduler.stop(); await harness.close(context); store.close(); rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
