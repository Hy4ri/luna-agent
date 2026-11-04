import type { CronJob, CronRun } from "./state";

const reasons: Record<string, string> = {
  overlap: "A previous run was still active",
  missed: "Schedule slot missed",
  timeout: "Time limit reached",
  stopped: "Stopped by you",
  interrupted: "Interrupted by a restart",
  script_failed: "Script failed",
  agent_failed: "Agent failed",
};

export const policies: Record<string, string> = {
  always: "Every run",
  changes: "Only when output changes",
  failures: "Failures only",
};

export const schedulePresets = [
  { label: "*/5m", expr: "*/5 * * * *" },
  { label: "*/15m", expr: "*/15 * * * *" },
  { label: "@hourly", expr: "@hourly" },
  { label: "@daily", expr: "@daily" },
  { label: "@weekly", expr: "@weekly" },
];

export function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

export function timeAgo(value: number | null | undefined) {
  if (!value) return "—";
  const diff = Math.max(0, Date.now() - value);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  if (diff < 604_800_000) return Math.round(diff / 86_400_000) + "d ago";
  return new Date(value).toLocaleDateString();
}

/** A scheduled time: future times read forward, past times read backward. */
export function whenText(value: number | null | undefined) {
  if (!value) return "—";
  const diff = value - Date.now();
  if (diff <= 60_000) return "due now";
  if (diff < 3_600_000) return "in " + Math.round(diff / 60_000) + "m";
  if (diff < 86_400_000) return "in " + Math.round(diff / 3_600_000) + "h";
  if (diff < 604_800_000) return "in " + Math.round(diff / 86_400_000) + "d";
  return new Date(value).toLocaleDateString();
}

export function durationText(run: CronRun) {
  return run.endedAt ? Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1) + "s" : "Running";
}

export function reasonText(reason: string | null) {
  return reason ? reasons[reason] || reason : "";
}

export function statusLabel(run: CronRun) {
  return run.status === "ok" ? "Success" : run.status === "error" ? "Failed" : run.status === "skipped" ? "Skipped" : "Running";
}

function runSnippet(run: CronRun) {
  if (!run.output) return run.status === "ok" ? "Completed with no output." : "";
  return String(run.output)
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** The result first: what happened matters more than which job produced it. */
export function outcome(run: CronRun) {
  if (run.status === "running") return "Running…";
  if (run.status === "skipped") return "Skipped — " + (reasonText(run.reason) || run.error || "no run");
  if (run.status === "error") {
    const why = run.error || reasonText(run.reason);
    return why ? "Failed — " + why : "Failed — the run recorded no error text.";
  }
  return runSnippet(run) || "Completed with no output.";
}

export function runMarkdown(run: CronRun) {
  return [
    run.output,
    run.error ? (run.status === "skipped" ? run.error : "Error: " + run.error) : null,
  ].filter(Boolean).join("\n\n") || "No output.";
}

export function scheduleDesc(job: CronJob | null) {
  if (!job) return "—";
  if (job.intervalMs) return `Every ${job.intervalMs / 60000} minutes`;
  const aliases: Record<string, string> = {
    "@hourly": "Every hour",
    "@daily": "Every day at 00:00",
    "@midnight": "Every day at 00:00",
    "@weekly": "Every Sunday at 00:00",
    "@monthly": "First day of each month at 00:00",
    "@yearly": "Every January 1 at 00:00",
    "@annually": "Every January 1 at 00:00",
    "* * * * *": "Every minute",
  };
  return aliases[job.expr] || job.expr;
}
