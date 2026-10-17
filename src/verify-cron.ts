// Verifies cron parsing, scheduler firing with faux model, durable logging, claim idempotency and crash recovery.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createModels, openLuna } from "./luna.js";
import { nextRun, parseCron } from "./cron-expr.js";
import { CronStore, Scheduler } from "./scheduler.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("OK", m); };
const at = (s: string) => new Date(s).getTime();

// --- cron expression ---
ok(nextRun("*/15 * * * *", at("2026-10-16T10:07:00")) === at("2026-10-16T10:15:00"), "step minutes");
ok(nextRun("0 9 * * mon-fri", at("2026-10-16T10:00:00")) === at("2026-10-19T09:00:00"), "weekday range skips weekend (Fri->Mon)");
ok(nextRun("30 2 29 2 *", at("2026-10-16T00:00:00")) === at("2028-02-29T02:30:00"), "leap day");
ok(nextRun("@daily", at("2026-10-16T00:00:00")) === at("2026-10-17T00:00:00"), "strictly after, @daily");
ok(nextRun("0 0 13 * fri", at("2026-10-16T00:00:00")) === at("2026-10-23T00:00:00"), "dom/dow OR semantics (next Fri before the 13th)");
for (const bad of ["* * * *", "61 * * * *", "a * * * *", "*/0 * * * *", "5-1 * * * *"]) {
  let threw = false; try { parseCron(bad); } catch { threw = true; }
  ok(threw, `rejects "${bad}"`);
}

// --- scheduler ---
const d = mkdtempSync(join(process.cwd(), ".vcron-"));
try {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel(); const model = { provider: m.provider, modelId: m.id };
  const harness = await openLuna({ dbPath: join(d, "luna.db"), memory: join(d, "memory.db"), models, cwd: d });
  const store = new CronStore(join(d, "cron.db"));
  const sched = new Scheduler({ harness, store, defaultModel: model, log: console.log });

  const t0 = at("2026-10-16T10:00:30");
  const job = store.addJob("ping", "* * * * *", "say pong", undefined, t0);
  ok(job.nextRun === at("2026-10-16T10:01:00"), "job next_run computed");
  faux.setResponses([fauxAssistantMessage([fauxText("pong")]), fauxAssistantMessage([fauxText("pong2")])]);

  await sched.start();
  await sched.tick(at("2026-10-16T10:01:05"));
  await sched.tick(at("2026-10-16T10:01:06")); // not due again
  await sched.idle();
  let runs = store.runs(job.id);
  ok(runs.length === 1 && runs[0]!.status === "ok", `one run logged ok (got ${runs.length}/${runs[0]?.status} ${runs[0]?.error ?? ""})`);
  ok(runs[0]!.output === "pong", "run output captured: " + runs[0]!.output?.slice(0, 80));
  ok(store.getJob(job.id)!.nextRun === at("2026-10-16T10:02:00"), "next_run advanced");

  // double-claim of same slot is rejected (idempotent)
  ok(store.claim({ ...job, nextRun: runs[0]!.slot }, at("2026-10-16T10:01:10")) === undefined, "same slot cannot be claimed twice");

  // missed slots coalesce into a single run
  await sched.tick(at("2026-10-16T10:30:00")); await sched.idle();
  runs = store.runs(job.id);
  ok(runs.length === 2, "30 missed minutes coalesce to one catch-up run, got " + JSON.stringify(runs.map(r=>[r.slot,r.status,r.error])));

  // disabled jobs don't fire
  store.setEnabled(job.id, false);
  await sched.tick(at("2026-10-16T12:00:00")); await sched.idle();
  ok(store.runs(job.id).length === 2, "disabled job does not fire");

  // manual run works on a disabled job and leaves the schedule alone
  const before = store.getJob(job.id)!.nextRun;
  faux.setResponses([fauxAssistantMessage([fauxText("manual")])]);
  const manual = sched.runNow(job.id); await sched.idle();
  ok(store.getRun(manual.id)!.status === "ok" && store.runs(job.id).length === 3, "runNow executes a job outside its schedule: ");
  ok(store.getJob(job.id)!.nextRun === before, "runNow does not change next_run");

  // failure path: unknown model gets logged as error, scheduler survives
  const bad = store.addJob("bad", "* * * * *", "x", { provider: "nope", modelId: "nope" }, at("2026-10-16T12:00:00"));
  await sched.tick(at("2026-10-16T12:01:00")); await sched.idle();
  const br = store.runs(bad.id);
  ok(br.length === 1 && br[0]!.status === "error" && !!br[0]!.error, "failing run logged as error: " + br[0]?.error?.slice(0, 80));

  // durability: reopen store, log persists; stale 'running' row is recovered
  await sched.stop(); await harness.close(await import("./luna.js").then((x) => x.context)); 
  store.db.prepare("INSERT INTO runs(job_id,slot,started_at,status) VALUES(?,?,?,'running')").run(job.id, 1, 1);
  store.close();
  const store2 = new CronStore(join(d, "cron.db"));
  ok(store2.runs(job.id).length === 4, "run log persisted across reopen");
  const h2 = await openLuna({ dbPath: join(d, "luna.db"), memory: join(d, "memory.db"), models, cwd: d });
  const s2 = new Scheduler({ harness: h2, store: store2, defaultModel: model });
  await s2.start(); await s2.idle();
  const rec = store2.runs(job.id).find((r) => r.slot === 1)!;
  ok(rec.status === "error" && /interrupted/.test(rec.error!), "orphaned running row recovered -> error");
  await s2.stop(); await h2.close(await import("./luna.js").then((x) => x.context)); store2.close();
  console.log("ALL_OK");
} finally { rmSync(d, { recursive: true, force: true }); }
process.exit(0);
