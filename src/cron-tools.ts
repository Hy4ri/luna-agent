// Cron extension: lets the model manage scheduled jobs (create/list/get/update/enable/disable/remove/run/stop/runs) in cron.db,
// plus result delivery to a notify URL (ntfy-compatible: plain-text POST with a Title header).
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { nextRun, parseCron } from "./cron-expr.js";
import type { CronStore, Job, ReportPolicy, Run, Scheduler } from "./scheduler.js";

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
    `run #${r.id} job=${r.jobId} (${r.jobName}) status=${r.status}`,
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
    `schedule: ${j.intervalMs ? `every ${j.intervalMs}ms` : j.expr} (${j.timezone}); next run ${when(j.nextRun)}`,
    `type: ${j.execution ? `script ${JSON.stringify(j.execution.command)}${j.execution.cwd ? ` in ${j.execution.cwd}` : ""}` : "agent"}`,
    `model: ${j.model ? `${j.model.provider}/${j.model.modelId}` : "default"}; report policy: ${j.reportPolicy}`,
    `active run: ${running.length ? running.map((r) => `#${r.id} since ${when(r.startedAt)}${active.includes(r.id) ? "" : " (no live executor)"}`).join(", ") : "none"}`,
    `last run: ${last ? `#${last.id} ${last.status} at ${when(last.startedAt)}` : "none"}`,
    `prompt (${j.prompt.length} chars):`,
    j.prompt,
  ].join("\n");
}

/**
 * Tools: cron_create, cron_list, cron_get, cron_update, cron_toggle, cron_remove, cron_run, cron_stop, cron_runs,
 * cron_run_get. `changed` re-arms the scheduler; `scheduler` is read per call because it starts after the harness.
 */
export function createCronExtension(store: CronStore, changed: () => void = () => {}, scheduler: () => Scheduler | undefined = () => undefined) {
  const create = defineTool({
    name: "cron_create",
    description:
      "Schedule a recurring job. Each run is a fresh conversation that receives `prompt`, so make the prompt self-contained. " +
      "expr: 5-field cron in local time (min hour dom mon dow) or @hourly/@daily/@weekly/@monthly/@yearly.",
    parameters: Type.Object({
      name: Type.String({ description: "Unique job name" }),
      expr: Type.String(),
      prompt: Type.String(),
    }),
    // Re-running after a crash with the same name hits the UNIQUE constraint and reports the existing job.
    replay: "safe",
    async execute({ name, expr, prompt }) {
      try { parseCron(expr); } catch (e) { return text(`invalid cron expression: ${(e as Error).message}`, true); }
      const existing = store.listJobs().find((j) => j.name === name);
      if (existing) {
        const same = existing.expr === expr && existing.prompt === prompt;
        return text(same ? `job ${existing.id} "${name}" already exists; next run ${when(existing.nextRun)}` : `a job named "${name}" already exists (id ${existing.id}); remove it first or pick another name`, !same);
      }
      const job = store.addJob(name, expr, prompt);
      changed();
      return text(`created job ${job.id} "${name}"; next run ${when(job.nextRun)}`);
    },
  });
  const list = defineTool({
    name: "cron_list",
    description: "List scheduled jobs with their schedule, state and next run.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      const jobs = store.listJobs();
      return text(jobs.length ? jobs.map((j) => `${j.id} ${j.name} [${j.expr}] ${j.enabled ? "on" : "off"} next=${when(j.nextRun)}\n   ${preview(j.prompt, 160, `cron_get id=${j.id} for the full prompt`)}`).join("\n") : "no jobs");
    },
  });
  const get = defineTool({
    name: "cron_get",
    description: "Show one job in full: schedule, state, type, model, report policy, active and last run, and the complete prompt.",
    parameters: Type.Object({ id: Type.Number() }),
    replay: "safe",
    async execute({ id }) {
      const j = store.getJob(id);
      return j ? text(jobDetail(store, j, scheduler()?.activeRuns() ?? [])) : text(`no job ${id}`, true);
    },
  });
  const update = defineTool({
    name: "cron_update",
    description:
      "Edit an existing job. Pass only the fields to change. A new expr or enabling the job recomputes the next run; " +
      "disabling stops future runs but does not stop an active run (use cron_stop for that).",
    parameters: Type.Object({
      id: Type.Number(),
      name: Type.Optional(Type.String()),
      expr: Type.Optional(Type.String({ description: "5-field cron in local time or @hourly/@daily/@weekly/@monthly/@yearly" })),
      prompt: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      reportPolicy: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("changes"), Type.Literal("failures")])),
    }),
    replay: "safe",
    async execute({ id, name, expr, prompt, enabled, reportPolicy }) {
      const j = store.getJob(id);
      if (!j) return text(`no job ${id}`, true);
      const patch: { name?: string; expr?: string; prompt?: string; enabled?: boolean; reportPolicy?: ReportPolicy } = {};
      if (name !== undefined) patch.name = name;
      if (expr !== undefined) patch.expr = expr;
      if (prompt !== undefined) patch.prompt = prompt;
      if (enabled !== undefined) patch.enabled = enabled;
      if (reportPolicy !== undefined) patch.reportPolicy = reportPolicy;
      if (!Object.keys(patch).length) return text("nothing to change: pass at least one of name, expr, prompt, enabled, reportPolicy", true);
      if (name !== undefined && name !== j.name && store.listJobs().some((o) => o.name === name)) return text(`a job named "${name}" already exists`, true);
      let u: Job;
      try { u = store.updateJob(id, patch); } catch (e) { return text((e as Error).message, true); }
      changed();
      return text(`updated job ${id} (${Object.keys(patch).join(", ")}); ${u.enabled ? `next run ${when(u.nextRun)}` : "disabled"}`);
    },
  });
  const toggle = defineTool({
    name: "cron_toggle",
    description: "Enable or disable a job by id.",
    parameters: Type.Object({ id: Type.Number(), enabled: Type.Boolean() }),
    replay: "safe",
    async execute({ id, enabled }) {
      try { store.setEnabled(id, enabled); } catch (e) { return text((e as Error).message, true); }
      changed();
      return text(`job ${id} ${enabled ? "enabled" : "disabled"}`);
    },
  });
  const remove = defineTool({
    name: "cron_remove",
    description: "Delete a job by id. Reports and run history are kept. Stop or wait for its active run first.",
    parameters: Type.Object({ id: Type.Number() }),
    replay: "safe",
    async execute({ id }) {
      if (!store.getJob(id)) return text(`no job ${id}`, true);
      try { store.removeJob(id); } catch (e) { return text((e as Error).message, true); }
      changed();
      return text(`removed job ${id}; reports and run history kept`);
    },
  });
  const runNow = defineTool({
    name: "cron_run",
    description: "Start a job now, outside its schedule (also works on a disabled job). The schedule is unchanged. Fails if the job already has an active run.",
    parameters: Type.Object({ id: Type.Number() }),
    // A replay would start a second run; the duplicate-run guard refuses it while the first is active.
    replay: "unsafe",
    async execute({ id }) {
      const s = scheduler();
      if (!s) return text("the scheduler is not running", true);
      try {
        const r = s.runNow(id);
        return text(`started run #${r.id} of job ${id}; check it with cron_run_get runId=${r.id}`);
      } catch (e) { return text((e as Error).message, true); }
    },
  });
  const stop = defineTool({
    name: "cron_stop",
    description:
      "Cancel an active run and report the real outcome. Agent runs abort their conversation; script runs are killed. " +
      "Pass runId, or id to stop that job's active run. This does not disable the job; use cron_update enabled=false for future runs.",
    parameters: Type.Object({ runId: Type.Optional(Type.Number()), id: Type.Optional(Type.Number({ description: "job id" })) }),
    replay: "safe",
    async execute({ runId, id }) {
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
        case "still_running": return text(`cancellation of run #${r.id} was requested, but the run has not settled yet; check cron_run_get runId=${r.id}`, true);
      }
    },
  });
  const runs = defineTool({
    name: "cron_runs",
    description: "Show recent runs (newest first), optionally for one job, with status and output or error.",
    parameters: Type.Object({ id: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number({ description: "default 10" })) }),
    replay: "safe",
    async execute({ id, limit }) {
      const rs = store.runs(id, Math.min(limit ?? 10, 100));
      return text(rs.length ? rs.map((r) => `#${r.id} job=${r.jobId} ${r.status} at ${when(r.startedAt)}: ${preview(r.error ?? r.output ?? "", 300, `cron_run_get runId=${r.id} for the full result`)}`).join("\n") : "no runs");
    },
  });
  const runGet = defineTool({
    name: "cron_run_get",
    description: `Show one run in full: status, timing, conversation, and the complete output or error. Results over ${PAGE} chars come in pages; use offset.`,
    parameters: Type.Object({ runId: Type.Number(), offset: Type.Optional(Type.Number({ description: "char offset into the result, default 0" })) }),
    replay: "safe",
    async execute({ runId, offset }) {
      const r = store.getRun(runId);
      if (!r) return text(`no run ${runId}`, true);
      const o = offset ?? 0;
      if (!Number.isSafeInteger(o) || o < 0) return text("offset must be a nonnegative integer", true);
      return text(runDetail(r, o));
    },
  });
  return defineExtension({ name: "cron", tools: [create, list, get, update, toggle, remove, runNow, stop, runs, runGet] });
}

/** POST a finished run to `url` (ntfy-compatible). */
export async function deliverRun(url: string, job: Job | undefined, run: Run, fetchImpl: typeof fetch = fetch) {
  const title = `luna cron: ${job?.name ?? `job ${run.jobId}`} ${run.status === "ok" ? "ok" : "FAILED"}`;
  const body = (run.status === "ok" ? run.output : run.error) ?? "";
  const res = await fetchImpl(url, { method: "POST", headers: { Title: title, "Content-Type": "text/plain; charset=utf-8" }, body: body.slice(0, 4000) || "(empty)" });
  if (!res.ok) throw new Error(`notify ${res.status} ${res.statusText}`);
}

export { nextRun };
