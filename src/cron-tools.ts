// Cron extension: lets the model manage scheduled jobs (create/list/enable/disable/remove/runs) in cron.db,
// plus result delivery to a notify URL (ntfy-compatible: plain-text POST with a Title header).
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { nextRun, parseCron } from "./cron-expr.js";
import type { CronStore, Job, Run } from "./scheduler.js";

const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());

/** Tools: cron_create, cron_list, cron_toggle, cron_remove, cron_runs. `changed` re-arms the scheduler. */
export function createCronExtension(store: CronStore, changed: () => void = () => {}) {
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
      return text(jobs.length ? jobs.map((j) => `${j.id} ${j.name} [${j.expr}] ${j.enabled ? "on" : "off"} next=${when(j.nextRun)}\n   ${j.prompt.slice(0, 160).replace(/\s+/g, " ")}`).join("\n") : "no jobs");
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
    description: "Delete a job and its run history by id.",
    parameters: Type.Object({ id: Type.Number() }),
    replay: "safe",
    async execute({ id }) {
      if (!store.getJob(id)) return text(`no job ${id}`, true);
      store.removeJob(id);
      changed();
      return text(`removed job ${id}`);
    },
  });
  const runs = defineTool({
    name: "cron_runs",
    description: "Show recent runs (newest first), optionally for one job, with status and output or error.",
    parameters: Type.Object({ id: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number({ description: "default 10" })) }),
    replay: "safe",
    async execute({ id, limit }) {
      const rs = store.runs(id, Math.min(limit ?? 10, 100));
      return text(rs.length ? rs.map((r) => `#${r.id} job=${r.jobId} ${r.status} at ${when(r.startedAt)}: ${(r.error ?? r.output ?? "").slice(0, 300).replace(/\s+/g, " ")}`).join("\n") : "no runs");
    },
  });
  return defineExtension({ name: "cron", tools: [create, list, toggle, remove, runs] });
}

/** POST a finished run to `url` (ntfy-compatible). */
export async function deliverRun(url: string, job: Job | undefined, run: Run, fetchImpl: typeof fetch = fetch) {
  const title = `luna cron: ${job?.name ?? `job ${run.jobId}`} ${run.status === "ok" ? "ok" : "FAILED"}`;
  const body = (run.status === "ok" ? run.output : run.error) ?? "";
  const res = await fetchImpl(url, { method: "POST", headers: { Title: title, "Content-Type": "text/plain; charset=utf-8" }, body: body.slice(0, 4000) || "(empty)" });
  if (!res.ok) throw new Error(`notify ${res.status} ${res.statusText}`);
}

export { nextRun };
