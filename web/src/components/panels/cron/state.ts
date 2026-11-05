// Cron panel state lives outside the component so closing the floating window keeps the active tab,
// the selected job, the history filter, and any unfinished job edit. Report detail is cleared on close.
import { reactive, watch } from "vue";
import { serverUrl, token } from "@/lib/api";

export type CronTab = "reports" | "jobs" | "history";
export type ReportPolicy = "always" | "changes" | "failures";

export interface CronRun {
  id: number;
  jobId: number;
  slot: number;
  jobName: string;
  status: "running" | "ok" | "error" | "skipped";
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
  output: string | null;
  error: string | null;
  conversationId: string | null;
  report: boolean;
  readAt: number | null;
}

export interface CronJob {
  id: number;
  name: string;
  expr: string;
  prompt: string;
  enabled: boolean;
  nextRun: number | null;
  reportPolicy: ReportPolicy;
  intervalMs?: number;
  execution?: { command: string[]; cwd?: string };
  lastRun: CronRun | null;
  timezone?: string;
}

/** An unfinished job edit: kept across panel open/close until Save or Cancel. */
export interface CronEditor {
  jobId: number | null;
  name: string;
  expr: string;
  prompt: string;
  reportPolicy: ReportPolicy;
  /** Imported interval jobs keep their interval; the schedule field is not editable. */
  intervalMs?: number;
  /** Imported script jobs run a command instead of a prompt. */
  script?: boolean;
}

export const cronPanel = reactive({
  tab: "reports" as CronTab,
  /** Open report (Reports tab) or history entry. Cleared when the panel closes. */
  detail: null as CronRun | null,
  /** Selected job in the Jobs tab. */
  jobId: null as number | null,
  /** History job filter: job id as a string, empty means all jobs. */
  historyJob: "",
  editor: null as CronEditor | null,
  status: "",
  statusError: false,
});

// Drafts and selected private reports belong only to one authenticated connection.
watch([serverUrl, token], () => {
  cronPanel.detail = null; cronPanel.jobId = null; cronPanel.historyJob = "";
  cronPanel.editor = null; cronPanel.status = ""; cronPanel.statusError = false;
}, { flush: "sync" });
