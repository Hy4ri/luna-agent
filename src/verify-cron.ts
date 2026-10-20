// Verifies cron parsing, scheduler firing with faux model, durable logging, claim idempotency, crash recovery,
// and the agent cron tools: edit, full inspection, run now, stop (agent + script), and timeout cancellation.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createModels, openLuna } from "./luna.js";
import { nextRun, parseCron } from "./cron-expr.js";
import { CronStore, Scheduler } from "./scheduler.js";
import { createCronExtension } from "./cron-tools.js";
import { context } from "./luna.js";

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

  // --- cron tools: edit, inspect, run now, stop ---
  let rearms = 0;
  const ext = createCronExtension(store, () => { rearms++; }, () => sched);
  const tool = (name: string) => ext.tools!.find((t) => t.name === name)!;
  const call = async (name: string, args: object) => {
    const r: any = await tool(name).execute(args as any, {} as any, context);
    return { text: r.output.map((o: any) => o.text).join(""), isError: !!r.isError };
  };
  const names = ext.tools!.map((t) => t.name);
  for (const n of ["cron_create", "cron_list", "cron_get", "cron_update", "cron_toggle", "cron_remove", "cron_run", "cron_stop", "cron_runs", "cron_run_get"])
    ok(names.includes(n), `tool ${n} defined`);

  // Model call that never ends on its own; it settles only when the run's conversation aborts it.
  let hung = 0;
  const hang = (_c: unknown, o: any) => new Promise<any>((res) => {
    hung++;
    const t = setTimeout(() => res(fauxAssistantMessage([fauxText("late")])), 60_000);
    o?.signal?.addEventListener("abort", () => { clearTimeout(t); res(fauxAssistantMessage([fauxText("")], { stopReason: "aborted" } as any)); });
  });
  const until = async (c: () => boolean, ms = 5000) => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

  const longPrompt = "step ".repeat(1000) + "END";
  let r = await call("cron_create", { name: "edit-me", expr: "0 9 * * *", prompt: "short" });
  const ej = store.listJobs().find((j) => j.name === "edit-me")!;
  ok(!r.isError && rearms === 1, "cron_create via tool re-arms");
  r = await call("cron_update", { id: ej.id, expr: "30 6 * * *", prompt: longPrompt, reportPolicy: "failures" });
  const ej2 = store.getJob(ej.id)!;
  ok(!r.isError && ej2.expr === "30 6 * * *" && ej2.prompt === longPrompt && ej2.reportPolicy === "failures" && rearms === 2, "cron_update edits expr/prompt/policy and re-arms: " + r.text);
  ok(new Date(ej2.nextRun!).getHours() === 6 && new Date(ej2.nextRun!).getMinutes() === 30, "cron_update recomputes next run from the new expr");
  ok((await call("cron_update", { id: ej.id })).isError, "cron_update with no fields is rejected");
  ok((await call("cron_update", { id: ej.id, name: "ping" })).isError, "cron_update rejects a duplicate name");
  ok((await call("cron_update", { id: ej.id, expr: "nope" })).isError && store.getJob(ej.id)!.expr === "30 6 * * *", "cron_update rejects a bad expr and keeps the old one");
  ok((await call("cron_update", { id: 9999, name: "x" })).isError, "cron_update on a missing job is rejected");
  await call("cron_update", { id: ej.id, enabled: false });
  ok(store.getJob(ej.id)!.nextRun === null && !store.getJob(ej.id)!.enabled, "cron_update enabled=false clears next run");
  await call("cron_update", { id: ej.id, enabled: true });
  ok(store.getJob(ej.id)!.nextRun !== null, "cron_update enabled=true re-arms next run");
  const reopened = new CronStore(join(d, "cron.db"));
  ok(reopened.getJob(ej.id)!.prompt === longPrompt && reopened.getJob(ej.id)!.expr === "30 6 * * *", "edits persist across reopen"); reopened.close();

  r = await call("cron_get", { id: ej.id });
  ok(r.text.includes(longPrompt) && r.text.includes(`prompt (${longPrompt.length} chars)`) && /report policy: failures/.test(r.text) && /type: agent/.test(r.text), "cron_get returns the complete prompt and details");
  r = await call("cron_list", {});
  ok(r.text.includes(`more chars; cron_get id=${ej.id} for the full prompt]`), "cron_list marks a cut prompt instead of truncating silently");

  // run now + duplicate guard + remove guard + stop of an agent run
  faux.setResponses([hang]);
  r = await call("cron_run", { id: ej.id });
  const runId = Number(/run #(\d+)/.exec(r.text)?.[1]);
  ok(!r.isError && store.getRun(runId)?.status === "running", "cron_run starts a run: " + r.text);
  ok(await until(() => !!store.getRun(runId)!.conversationId && hung === 1), "agent run reached the model");
  r = await call("cron_run", { id: ej.id });
  ok(r.isError && /already running/.test(r.text) && store.runs(ej.id).length === 1, "cron_run refuses a duplicate while a run is active");
  r = await call("cron_remove", { id: ej.id });
  ok(r.isError && /running/.test(r.text) && !!store.getJob(ej.id), "cron_remove is rejected while a run is active");
  r = await call("cron_get", { id: ej.id });
  ok(r.text.includes(`active run: #${runId}`), "cron_get shows the active run");
  const t1 = Date.now();
  r = await call("cron_stop", { id: ej.id });
  const stoppedRun = store.getRun(runId)!;
  ok(!r.isError && /^stopped run/.test(r.text) && stoppedRun.status === "error" && stoppedRun.error === "stopped: stopped by request" && Date.now() - t1 < 5000,
    `cron_stop cancels the live agent turn and reports it (${Date.now() - t1}ms): ${r.text}`);
  ok(store.getJob(ej.id)!.enabled && store.getJob(ej.id)!.nextRun === ej2.nextRun, "stopping a run does not disable the job or move its schedule");
  r = await call("cron_stop", { runId });
  ok(r.isError && /not running/.test(r.text), "cron_stop on a finished run reports already finished");
  ok((await call("cron_stop", {})).isError && (await call("cron_stop", { runId, id: ej.id })).isError, "cron_stop needs exactly one of runId or id");
  ok((await call("cron_stop", { id: ej.id })).isError, "cron_stop by job id with no active run is an error");

  // stop requested before the prompt is submitted
  faux.setResponses([hang]);
  const early = sched.runNow(ej.id);
  const er = await sched.stopRun(early.id);
  ok(er.outcome === "stopped" && /^stopped: /.test(er.run.error!), "stop before submission settles as stopped: " + er.run.error);

  // a running row with no live executor is reported, not faked
  const orphan = store.db.prepare("INSERT INTO runs(job_id,slot,started_at,status,job_name) VALUES(?,?,?,'running','edit-me')").run(ej.id, 42, 42);
  r = await call("cron_stop", { runId: Number(orphan.lastInsertRowid) });
  ok(r.isError && /no executor/.test(r.text) && store.getRun(Number(orphan.lastInsertRowid))!.status === "running", "cron_stop reports an untracked running row honestly");
  store.finish(Number(orphan.lastInsertRowid), "error", null, "test cleanup");

  // full run results, paged with explicit ranges
  const big = Array.from({ length: 2500 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const bigRun = store.claimManual(ej, Date.now()); store.finish(bigRun.id, "ok", big, null);
  let rebuilt = "", offset = 0, pages = 0;
  for (;;) {
    r = await call("cron_run_get", { runId: bigRun.id, offset });
    const m = /\(chars (\d+)-(\d+) of (\d+)[^)]*\):\n/.exec(r.text);
    if (!m) break;
    rebuilt += r.text.slice(m.index + m[0].length); pages++;
    offset = Number(m[2]); if (offset >= Number(m[3])) break;
  }
  ok(pages > 1 && rebuilt === big, `cron_run_get pages a ${big.length}-char output with no loss (${pages} pages)`);
  r = await call("cron_runs", { id: ej.id, limit: 1 });
  ok(r.text.includes(`cron_run_get runId=${bigRun.id} for the full result]`), "cron_runs marks a cut result");
  r = await call("cron_run_get", { runId });
  ok(r.text.includes("status=error") && r.text.includes("stopped: stopped by request"), "cron_run_get shows the stopped run");

  // remove after stop keeps history
  const histBefore = store.runs(ej.id).length;
  r = await call("cron_remove", { id: ej.id });
  ok(!r.isError && !store.getJob(ej.id) && store.runs(ej.id).length === histBefore && !!store.getRun(runId), "cron_remove after stop keeps the run history");

  // script runs: stop kills the process; timeout really cancels
  const script = store.addJob("sleeper", "0 0 1 1 *", "");
  store.db.prepare("UPDATE jobs SET execution=? WHERE id=?").run(JSON.stringify({ command: ["sleep", "30"] }), script.id);
  r = await call("cron_get", { id: script.id });
  ok(/type: script \["sleep","30"\]/.test(r.text), "cron_get shows the script command");
  const sr = sched.runNow(script.id);
  await new Promise((res) => setTimeout(res, 100));
  const t2 = Date.now();
  const so = await sched.stopRun(sr.id);
  ok(so.outcome === "stopped" && so.run.error === "stopped: stopped by request" && Date.now() - t2 < 3000, `stopRun kills a script run (${Date.now() - t2}ms)`);
  const quick = new Scheduler({ harness, store, defaultModel: model, runTimeoutMs: 300 });
  const t3 = Date.now();
  const tr = quick.runNow(script.id); await quick.idle();
  ok(store.getRun(tr.id)!.error === "stopped: timed out after 0.3s" && Date.now() - t3 < 3000, "script timeout cancels the process: " + store.getRun(tr.id)!.error);
  faux.setResponses([hang]);
  const t4 = Date.now();
  const at2 = quick.runNow(store.addJob("slow-agent", "0 0 1 1 *", "hang").id); await quick.idle();
  ok(store.getRun(at2.id)!.error === "stopped: timed out after 0.3s" && Date.now() - t4 < 5000, `agent timeout cancels the live turn (${Date.now() - t4}ms): ${store.getRun(at2.id)!.error}`);

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
