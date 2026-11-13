// Cron extension: one `cron` tool manages scheduled jobs in cron.db and reads their runs,
// plus result delivery to a notify URL (ntfy-compatible: plain-text POST with a Title header).
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { nextRun, parseCron } from "./cron-expr.js";
import type { CronStore, Job, JobOptions, ReportPolicy, Run, Scheduler } from "./scheduler.js";
import { StringEnum } from "./string-enum.js";

const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());
/** One-line preview that says when it is cut, so a list never hides that more text exists. */
const preview = (t: string, max: number, more: string) => {
  const flat = t.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}… [${flat.length - max} more chars; ${more}]` : flat;
};
/** Above this a run result is returned in pages; each page states the range and how to get the next one. */
const PAGE = 40_000;

function runDetail(r: Run, offset: number) {
  const head = [
    `run #${r.id} job=${r.jobId} (${r.jobName}) status=${r.status}${r.reason ? ` reason=${r.reason}` : ""}${r.attempt ? ` attempt=${r.attempt + 1}` : ""}`,
    `started=${when(r.startedAt)} ended=${when(r.endedAt)}${r.endedAt ? ` duration=${Math.round((r.endedAt - r.startedAt) / 1000)}s` : ""}`,
    `conversation=${r.conversationId ?? "none"} submission=${r.submissionId ?? "none"} report=${r.report ? (r.readAt ? "read" : "unread") : "no"}`,
  ];
  const body = r.error ?? r.output;
  if (body === null) return [...head, r.status === "running" ? "(still running; no result yet)" : "(no output)"].join("\n");
  const label = r.error !== null ? "error" : "output";
  if (offset >= body.length && body.length) return [...head, `${label}: offset ${offset} is past the end (${body.length} chars)`].join("\n");
  const end = Math.min(body.length, offset + PAGE);
  const range = offset === 0 && end === body.length ? `${body.length} chars` : `chars ${offset}-${end} of ${body.length}${end < body.length ? `; call again with offset=${end} for the rest` : ""}`;
  return [...head, `${label} (${range}):`, body.slice(offset, end)].join("\n");
}

function jobDetail(store: CronStore, j: Job, active: number[]) {
  const last = store.lastRun(j.id);
  const running = store.queryRuns({ jobId: j.id, status: "running", limit: 5 });
  return [
    `job ${j.id} "${j.name}" ${j.enabled ? "enabled" : "disabled"}`,
    `schedule: ${j.intervalMs ? `every ${j.intervalMs}ms` : j.expr} (${Intl.DateTimeFormat().resolvedOptions().timeZone}); next run ${when(j.nextRun)}`,
    `type: ${j.execution ? `script ${JSON.stringify(j.execution.command)}${j.execution.cwd ? ` in ${j.execution.cwd}` : ""}` : "agent"}`,
    `model: ${j.model ? `${j.model.provider}/${j.model.modelId}` : "default"}; report policy: ${j.reportPolicy}`,
    `grace: ${j.graceMs ? `${j.graceMs / 1000}s` : "none (late slots run)"}; timeout: ${j.timeoutMs ? `${j.timeoutMs / 1000}s` : "default"}; retries: ${j.retries}`,
    `run sessions: ${j.hidden ? "hidden (results in Cron only)" : "shown in the session list"}`,
    `active run: ${running.length ? running.map((r) => `#${r.id} since ${when(r.startedAt)}${active.includes(r.id) ? "" : " (no live executor)"}`).join(", ") : "none"}`,
    `last run: ${last ? `#${last.id} ${last.status} at ${when(last.startedAt)}` : "none"}`,
    `prompt (${j.prompt.length} chars):`,
    j.prompt,
  ].join("\n");
}

/**
 * Tool `cron`: manage scheduled jobs (create, list, get, update, remove, run, stop) and read their history
 * (runs, get_run). `changed` re-arms the scheduler; `scheduler` is read per call because it starts after the harness.
 * `jobs` reports live whether the cron extension is on.
 */
export function createCronExtension(store: CronStore, changed: () => void = () => {}, scheduler: () => Scheduler | undefined = () => undefined,
  options: { jobs?: () => boolean } = {}) {
  const jobsOn = options.jobs ?? (() => true);
  type Action = "create" | "list" | "get" | "update" | "remove" | "run" | "stop" | "runs" | "get_run";
  type Args = {
    action: Action;
    id?: number; runId?: number; name?: string; expr?: string; prompt?: string; enabled?: boolean;
    reportPolicy?: ReportPolicy; graceMs?: number | null; timeoutMs?: number | null; retries?: number; hidden?: boolean;
    status?: "running" | "ok" | "error" | "skipped"; limit?: number; offset?: number;
  };
  const JOB_ACTIONS = new Set<Action>(["create", "list", "get", "update", "remove", "run", "stop"]);
  const actions: Record<Action, (a: Args) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>> = {
    create({ name, expr, prompt, hidden }) {
      if (!name || !expr || prompt === undefined) return text("create needs name, expr and prompt", true);
      try { parseCron(expr); } catch (e) { return text(`invalid cron expression: ${(e as Error).message}`, true); }
      // Re-running after a crash with the same name reports the existing job instead of creating a second one.
      const existing = store.listJobs().find((j) => j.name === name);
      if (existing) {
        const same = existing.expr === expr && existing.prompt === prompt;
        return text(same ? `job ${existing.id} "${name}" already exists; next run ${when(existing.nextRun)}` : `a job named "${name}" already exists (id ${existing.id}); remove it first or pick another name`, !same);
      }
      let job: Job;
      try { job = store.addJob(name, expr, prompt, undefined, Date.now(), "always", { hidden }); } catch (e) { return text((e as Error).message, true); }
      changed();
      return text(`created job ${job.id} "${name}"${job.hidden ? " (hidden runs)" : ""}; next run ${when(job.nextRun)}`);
    },
    list() {
      const jobs = store.listJobs();
      return text(jobs.length ? jobs.map((j) => `${j.id} ${j.name} [${j.expr}] ${j.enabled ? "on" : "off"}${j.hidden ? " hidden" : ""} next=${when(j.nextRun)}\n   ${preview(j.prompt, 160, `cron get id=${j.id} for the full prompt`)}`).join("\n") : "no jobs");
    },
    get({ id }) {
      if (id === undefined) return text("get needs id", true);
      const j = store.getJob(id);
      return j ? text(jobDetail(store, j, scheduler()?.activeRuns() ?? [])) : text(`no job ${id}`, true);
    },
    update({ id, name, expr, prompt, enabled, reportPolicy, graceMs, timeoutMs, retries, hidden }) {
      if (id === undefined) return text("update needs id", true);
      const j = store.getJob(id);
      if (!j) return text(`no job ${id}`, true);
      const patch: { name?: string; expr?: string; prompt?: string; enabled?: boolean; reportPolicy?: ReportPolicy } & JobOptions = {};
      if (name !== undefined) patch.name = name;
      if (expr !== undefined) patch.expr = expr;
      if (prompt !== undefined) patch.prompt = prompt;
      if (enabled !== undefined) patch.enabled = enabled;
      if (reportPolicy !== undefined) patch.reportPolicy = reportPolicy;
      if (graceMs !== undefined) patch.graceMs = graceMs;
      if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
      if (retries !== undefined) patch.retries = retries;
      if (hidden !== undefined) patch.hidden = hidden;
      if (!Object.keys(patch).length) return text("nothing to change: pass at least one of name, expr, prompt, enabled, reportPolicy, graceMs, timeoutMs, retries, hidden", true);
      if (name !== undefined && name !== j.name && store.listJobs().some((o) => o.name === name)) return text(`a job named "${name}" already exists`, true);
      let u: Job;
      try { u = store.updateJob(id, patch); } catch (e) { return text((e as Error).message, true); }
      changed();
      return text(`updated job ${id} (${Object.keys(patch).join(", ")}); ${u.enabled ? `next run ${when(u.nextRun)}` : "disabled"}`);
    },
    remove({ id }) {
      if (id === undefined) return text("remove needs id", true);
      if (!store.getJob(id)) return text(`no job ${id}`, true);
      try { store.removeJob(id); } catch (e) { return text((e as Error).message, true); }
      changed();
      return text(`removed job ${id}; reports and run history kept`);
    },
    run({ id }) {
      if (id === undefined) return text("run needs id", true);
      const s = scheduler();
      if (!s) return text("the scheduler is not running", true);
      try {
        const r = s.runNow(id);
        return text(`started run #${r.id} of job ${id}; check it with cron action=get_run runId=${r.id}`);
      } catch (e) { return text((e as Error).message, true); }
    },
    async stop({ runId, id }) {
      const s = scheduler();
      if (!s) return text("the scheduler is not running", true);
      if ((runId === undefined) === (id === undefined)) return text("pass exactly one of runId or id", true);
      let target = runId;
      if (target === undefined) {
        const running = store.queryRuns({ jobId: id, status: "running", limit: 1 });
        if (!running.length) return text(store.getJob(id!) ? `job ${id} has no active run` : `no job ${id}`, true);
        target = running[0]!.id;
      }
      let res;
      try { res = await s.stopRun(target); } catch (e) { return text((e as Error).message, true); }
      const r = res.run;
      switch (res.outcome) {
        case "stopped": return text(`stopped run #${r.id} (job ${r.jobId}): ${r.error}`);
        case "finished": return text(`run #${r.id} finished on its own before the stop took effect: ${r.status}`);
        case "already_finished": return text(`run #${r.id} is not running (status ${r.status})`, true);
        case "not_tracked": return text(`run #${r.id} is marked running, but no executor in this process owns it; nothing was cancelled`, true);
        case "still_running": return text(`cancellation of run #${r.id} was requested, but the run has not settled yet; check cron action=get_run runId=${r.id}`, true);
      }
    },
    runs({ id, status, limit: max }) {
      const limit = Math.min(max ?? 10, 100);
      const rs = status ? store.queryRuns({ jobId: id, status, limit }) : store.runs(id, limit);
      return text(rs.length ? rs.map((r) => `#${r.id} job=${r.jobId} (${r.jobName}) ${r.status} at ${when(r.startedAt)}: ${preview(r.error ?? r.output ?? "", 300, `cron action=get_run runId=${r.id} for the full result`)}`).join("\n") : "no runs");
    },
    get_run({ runId, offset }) {
      if (runId === undefined) return text("get_run needs runId", true);
      const r = store.getRun(runId);
      if (!r) return text(`no run ${runId}`, true);
      const o = offset ?? 0;
      if (!Number.isSafeInteger(o) || o < 0) return text("offset must be a nonnegative integer", true);
      return text(runDetail(r, o));
    },
  };
  const cron = defineTool({
    name: "cron",
    description:
      "Manage scheduled jobs and read their runs. create: name, expr, prompt; each run is a fresh conversation that receives `prompt`, so make it self-contained. " +
      "expr: 5-field cron in local time (min hour dom mon dow) or @hourly/@daily/@weekly/@monthly/@yearly. list: all jobs. get: one job in full. " +
      "update: pass id and only the fields to change; enabled=true/false enables or disables; a new expr or enabling recomputes the next run. " +
      "remove: delete a job; reports and run history are kept; stop or wait for its active run first. " +
      "run: start a job now outside its schedule (also when disabled); fails if it already has an active run. " +
      "stop: cancel an active run (runId, or id for that job's active run) and report the real outcome; this does not disable the job. " +
      "runs: recent runs newest first, optionally for one job (id) or one status, with output or error previews. " +
      `get_run: one run in full (runId) with status, timing, conversation and the complete result; results over ${PAGE} chars come in pages, use offset.`,
    parameters: Type.Object({
      action: StringEnum(["create", "list", "get", "update", "remove", "run", "stop", "runs", "get_run"]),
      id: Type.Optional(Type.Number({ description: "Job id (get, update, remove, run; stop: alternative to runId; runs: only this job)." })),
      runId: Type.Optional(Type.Number({ description: "stop, get_run: run id." })),
      name: Type.Optional(Type.String({ description: "create: unique job name. update: new name." })),
      expr: Type.Optional(Type.String({ description: "create/update: 5-field cron in local time or @hourly/@daily/@weekly/@monthly/@yearly." })),
      prompt: Type.Optional(Type.String({ description: "create/update: self-contained prompt for each run." })),
      enabled: Type.Optional(Type.Boolean({ description: "update: enable or disable." })),
      reportPolicy: Type.Optional(StringEnum(["always", "changes", "failures"])),
      graceMs: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "update: skip a slot that is later than this when it comes due (after downtime). null: always run late." })),
      timeoutMs: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "update: time limit for one run. null: the global limit." })),
      retries: Type.Optional(Type.Number({ description: "update: extra attempts after a failed run, 0 to 5, with backoff." })),
      hidden: Type.Optional(Type.Boolean({ description: "create/update: true keeps each run's session out of the session list; results stay in Cron. Default false." })),
      status: Type.Optional(StringEnum(["running", "ok", "error", "skipped"], { description: "runs: keep only this status." })),
      limit: Type.Optional(Type.Number({ description: "runs: default 10, max 100." })),
      offset: Type.Optional(Type.Number({ description: "get_run: char offset into the result, default 0." })),
    }),
    // run starts a new execution on replay; the duplicate-run guard refuses it only while the first is active.
    replay: "unsafe",
    async execute(a) {
      if (!jobsOn() && JOB_ACTIONS.has(a.action)) return text(`${a.action} needs the cron extension, which is disabled; only runs and get_run are available`, true);
      return actions[a.action](a as Args);
    },
  });
  return defineExtension({ name: "cron", tools: [cron] });
}

/** POST a finished run to `url` (ntfy-compatible). */
export async function deliverRun(url: string, job: Job | undefined, run: Run, fetchImpl: typeof fetch = fetch) {
  const title = `luna cron: ${job?.name ?? `job ${run.jobId}`} ${run.status === "ok" ? "ok" : "FAILED"}`;
  const body = (run.status === "ok" ? run.output : run.error) ?? "";
  const res = await fetchImpl(url, { method: "POST", headers: { Title: title, "Content-Type": "text/plain; charset=utf-8" }, body: body.slice(0, 4000) || "(empty)" });
  if (!res.ok) throw new Error(`notify ${res.status} ${res.statusText}`);
}

export { nextRun };
