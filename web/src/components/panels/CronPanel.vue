<script setup lang="ts">
// Cron floating panel: an unread report inbox, job management, and one shared report history.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ArrowLeft, CheckCheck, Pause, Pencil, Play, Plus, RefreshCw, Trash2 } from "@lucide/vue";
import { json, post } from "@/lib/api";
import { closePanel, ui } from "@/stores/app";
import { continueCronRun } from "@/stores/chat";
import Markdown from "@/components/chat/Markdown.vue";
import { cronPanel as panel, type CronEditor, type CronJob, type CronRun, type CronTab } from "./cron/state";

const PAGE = 20;
const tabs: { id: CronTab; label: string }[] = [
  { id: "reports", label: "Reports" },
  { id: "jobs", label: "Jobs" },
  { id: "history", label: "History" },
];
const policies: Record<string, string> = {
  always: "Every run",
  changes: "Only when output changes",
  failures: "Failures only",
};
const schedulePresets = [
  { label: "*/5m", expr: "*/5 * * * *" },
  { label: "*/15m", expr: "*/15 * * * *" },
  { label: "@hourly", expr: "@hourly" },
  { label: "@daily", expr: "@daily" },
  { label: "@weekly", expr: "@weekly" },
];
const reasons: Record<string, string> = {
  overlap: "A previous run was still active",
  missed: "Schedule slot missed",
  timeout: "Time limit reached",
  stopped: "Stopped by you",
  interrupted: "Interrupted by a restart",
  script_failed: "Script failed",
  agent_failed: "Agent failed",
};

const jobs = ref<CronJob[]>([]);
const inbox = ref<CronRun[]>([]);
const historyRows = ref<CronRun[]>([]);
const historyMore = ref(false);
const jobRuns = ref<CronRun[]>([]);
const busy = ref(false);
const editor = computed<CronEditor | null>(() => panel.editor);
const detail = computed<CronRun | null>(() => panel.detail);
const detailJob = computed<CronJob | null>(() => jobs.value.find(j => j.id === panel.jobId) ?? null);
/** The report's job, when that job still exists. */
const reportJob = computed<CronJob | null>(() => jobs.value.find(j => j.id === panel.detail?.jobId) ?? null);
const detailOnly = computed(() => !!panel.detail && (panel.tab === "reports" || panel.tab === "history"));
const openRuns = ref(new Set<number>());

let timer: ReturnType<typeof setInterval> | undefined;
let jobRunsSeq = 0;
let historySeq = 0;
let inboxSeq = 0;

function message(text: string, error = false) {
  panel.status = text;
  panel.statusError = error;
}
function fail(e: unknown) {
  message(e instanceof Error ? e.message : String(e), true);
}
async function guard(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  panel.status = "";
  try {
    await action();
  } catch (e) {
    fail(e);
  } finally {
    busy.value = false;
  }
}

function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}
function timeAgo(value: number | null | undefined) {
  if (!value) return "—";
  const diff = Math.max(0, Date.now() - value);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.round(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.round(diff / 3_600_000) + "h ago";
  if (diff < 604_800_000) return Math.round(diff / 86_400_000) + "d ago";
  return new Date(value).toLocaleDateString();
}
/** A scheduled time: future times read forward, past times read backward. */
function whenText(value: number | null | undefined) {
  if (!value) return "—";
  const diff = value - Date.now();
  if (diff <= 60_000) return "due now";
  if (diff < 3_600_000) return "in " + Math.round(diff / 60_000) + "m";
  if (diff < 86_400_000) return "in " + Math.round(diff / 3_600_000) + "h";
  if (diff < 604_800_000) return "in " + Math.round(diff / 86_400_000) + "d";
  return new Date(value).toLocaleDateString();
}
function durationText(run: CronRun) {
  return run.endedAt ? Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1) + "s" : "Running";
}
function reasonText(reason: string | null) {
  return reason ? reasons[reason] || reason : "";
}
function statusLabel(run: CronRun) {
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
function outcome(run: CronRun) {
  if (run.status === "running") return "Running…";
  if (run.status === "skipped") return "Skipped — " + (reasonText(run.reason) || run.error || "no run");
  if (run.status === "error") {
    const why = run.error || reasonText(run.reason);
    return why ? "Failed — " + why : "Failed — the run recorded no error text.";
  }
  return runSnippet(run) || "Completed with no output.";
}
function runMarkdown(run: CronRun) {
  return [
    run.output,
    run.error ? (run.status === "skipped" ? run.error : "Error: " + run.error) : null,
  ].filter(Boolean).join("\n\n") || "No output.";
}
function scheduleDesc(job: CronJob | null) {
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

async function loadJobs() {
  const data = await json("/v1/cron?summary=1");
  jobs.value = data.jobs;
  if (data.unreadCount !== undefined) ui.cronUnread = data.unreadCount;
  if (!jobs.value.some(j => j.id === panel.jobId)) panel.jobId = jobs.value[0]?.id ?? null;
}
async function loadInbox() {
  const seq = ++inboxSeq;
  const rows: CronRun[] = [];
  let before: number | undefined;
  let unread = 0;
  for (;;) {
    const data = await json("/v1/cron/reports?limit=100" + (before ? `&before=${before}` : ""));
    if (seq !== inboxSeq) return;
    rows.push(...data.reports);
    unread = data.unreadCount ?? 0;
    if (data.reports.length < 100) break;
    before = data.reports.at(-1).id;
  }
  inbox.value = rows.sort((a, b) => Number(b.status === "error") - Number(a.status === "error") || b.id - a.id);
  ui.cronUnread = unread;
}
async function loadHistory(reset = true) {
  const seq = ++historySeq;
  const q = new URLSearchParams({ history: "1", limit: String(PAGE) });
  if (panel.historyJob) q.set("jobId", panel.historyJob);
  const before = reset ? null : historyRows.value.at(-1)?.id;
  if (before) q.set("before", String(before));
  const data = await json("/v1/cron/reports?" + q);
  if (seq !== historySeq) return;
  historyRows.value = reset ? data.reports : [...historyRows.value, ...data.reports];
  historyMore.value = data.reports.length === PAGE;
}
async function loadJobRuns() {
  const id = panel.jobId, seq = ++jobRunsSeq;
  if (id === null) { jobRuns.value = []; return; }
  const data = await json(`/v1/cron/runs?jobId=${id}&history=1&limit=10`);
  if (seq !== jobRunsSeq || panel.jobId !== id) return;
  jobRuns.value = data.runs;
}

function selectTab(tab: CronTab) {
  if (panel.tab === tab) return;
  panel.tab = tab;
  panel.detail = null;
  message("");
  void guard(async () => {
    if (tab === "history") await loadHistory(true);
    if (tab === "jobs") { await loadJobs(); await loadJobRuns(); }
    if (tab === "reports") await loadInbox();
  });
}
function applyHistoryFilter() {
  panel.detail = null;
  void guard(() => loadHistory(true));
}
function loadMoreHistory() {
  void guard(() => loadHistory(false));
}

function openReport(run: CronRun) {
  panel.detail = run;
  if (run.readAt !== null) return;
  void guard(async () => {
    const updated = await post(`/v1/cron/reports/${run.id}`, { read: true }, "PATCH");
    if (panel.detail?.id === run.id) panel.detail = updated;
    // Keep the selected detail visible; older reports stay superseded in History.
    await loadInbox();
  });
}
function markUnread(run: CronRun) {
  void guard(async () => {
    const updated = await post(`/v1/cron/reports/${run.id}`, { read: false }, "PATCH");
    if (panel.detail?.id === run.id) panel.detail = updated;
    await loadInbox();
  });
}
function markAllRead() {
  void guard(async () => {
    await Promise.all(inbox.value.map(run => post(`/v1/cron/reports/${run.id}`, { read: true }, "PATCH")));
    await loadInbox();
  });
}
function backToList() {
  panel.detail = null;
  if (panel.tab === "history") void guard(() => loadHistory(true));
}
async function continueRun(run: CronRun) {
  try {
    await continueCronRun(run);
    closePanel();
  } catch (e) {
    fail(e);
  }
}

function selectJob(job: CronJob) {
  if (panel.jobId === job.id) return;
  panel.jobId = job.id;
  panel.editor = null;
  message("");
  void guard(loadJobRuns);
}
function newJob() {
  panel.editor = { jobId: null, name: "", expr: "@daily", prompt: "", reportPolicy: "always" };
  message("");
}
function editJob(job: CronJob) {
  panel.editor = {
    jobId: job.id,
    name: job.name,
    expr: job.expr,
    prompt: job.prompt,
    reportPolicy: job.reportPolicy,
    intervalMs: job.intervalMs,
    script: !!job.execution,
  };
  message("");
}
function cancelEdit() {
  panel.editor = null;
  message("");
}
function saveJob() {
  const ed = panel.editor;
  if (!ed) return;
  const name = ed.name.trim(), prompt = ed.prompt;
  if (!name) { message("Job name is required.", true); return; }
  if (!prompt.trim() && !ed.script) { message("Prompt is required.", true); return; }
  void guard(async () => {
    const body: Record<string, unknown> = { name, prompt, reportPolicy: ed.reportPolicy };
    if (!ed.intervalMs) body.expr = ed.expr.trim();
    const saved = await post(ed.jobId ? `/v1/cron/${ed.jobId}` : "/v1/cron", body, ed.jobId ? "PATCH" : "POST");
    panel.editor = null;
    if (saved?.id) panel.jobId = saved.id;
    message("Job saved.");
    await loadJobs();
    await loadJobRuns();
    await loadInbox();
  });
}
function runNow(job: CronJob | null) {
  if (!job) return;
  void guard(async () => {
    await post(`/v1/cron/${job.id}/run`, {});
    message(`Started “${job.name}”.`);
    await loadJobs();
  });
}
function toggleJob(job: CronJob) {
  void guard(async () => {
    await post(`/v1/cron/${job.id}`, { enabled: !job.enabled }, "PATCH");
    await loadJobs();
  });
}
function deleteJob(job: CronJob) {
  if (!confirm(`Delete job “${job.name}”? Reports and run history will be kept.`)) return;
  void guard(async () => {
    await post(`/v1/cron/${job.id}`, {}, "DELETE");
    if (panel.jobId === job.id) panel.jobId = null;
    if (panel.editor?.jobId === job.id) panel.editor = null;
    await loadJobs();
    await loadJobRuns();
    await loadInbox();
  });
}
function showJobHistory(job: CronJob) {
  panel.historyJob = String(job.id);
  selectTab("history");
}
function onRunToggle(event: Event, id: number) {
  const open = (event.target as HTMLDetailsElement).open;
  const next = new Set(openRuns.value);
  if (open) next.add(id); else next.delete(id);
  openRuns.value = next;
}

onMounted(() => {
  void guard(async () => {
    await loadInbox();
    await loadJobs();
    if (panel.tab === "history") await loadHistory(true);
    if (panel.tab === "jobs") await loadJobRuns();
  });
  timer = setInterval(() => {
    if (document.hidden || busy.value) return;
    if (panel.tab === "reports") void loadInbox().catch(() => {});
    else if (panel.tab === "jobs") { void loadJobs().then(loadJobRuns).catch(() => {}); }
  }, 5000);
});
onUnmounted(() => {
  clearInterval(timer);
  ++inboxSeq;
  ++historySeq;
  ++jobRunsSeq;
  // A read report stays visible while it is open. Closing the panel returns the next open to the list.
  panel.detail = null;
});
</script>

<template>
  <div class="cron-panel" :class="{ 'detail-only': detailOnly }">
    <div class="cron-tabbar">
      <div class="cron-tabs" role="tablist" aria-label="Cron sections">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="cron-tab"
          :aria-selected="panel.tab === tab.id"
          :disabled="busy"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}
          <span v-if="tab.id === 'reports' && ui.cronUnread > 0" class="cron-tab-count">{{ ui.cronUnread }}</span>
        </button>
      </div>
      <div class="cron-tab-actions">
        <button v-if="panel.tab === 'reports' && inbox.length" type="button" class="cron-btn" :disabled="busy" @click="markAllRead">
          <CheckCheck :size="15" /> Mark all read
        </button>
        <button v-if="panel.tab === 'jobs'" type="button" class="cron-btn primary" @click="newJob">
          <Plus :size="15" /> New job
        </button>
        <button v-if="panel.tab === 'history'" type="button" class="cron-btn" :disabled="busy" @click="guard(() => loadHistory(true))">
          <RefreshCw :size="15" /> Refresh
        </button>
      </div>
    </div>

    <p v-if="panel.status" class="cron-status" :class="{ error: panel.statusError }" role="status" aria-live="polite">
      {{ panel.status }}
    </p>

    <div class="cron-split">
      <aside class="cron-list" :aria-label="panel.tab === 'reports' ? 'Unread reports' : panel.tab === 'jobs' ? 'Jobs' : 'Report history'">
        <template v-if="panel.tab === 'reports'">
          <button
            v-for="run in inbox"
            :key="run.id"
            :disabled="busy"
            type="button"
            class="cron-item"
            :class="{ active: detail?.id === run.id }"
            :data-run="run.id"
            @click="openReport(run)"
          >
            <span class="cron-item-outcome" :class="run.status" dir="auto">{{ outcome(run) }}</span>
            <span class="cron-item-meta">
              <span class="cron-pill" :class="run.status">{{ statusLabel(run) }}</span>
              <span class="cron-item-job" dir="auto">{{ run.jobName }}</span>
              <span class="cron-item-time" :title="date(run.endedAt || run.startedAt)">{{ timeAgo(run.endedAt || run.startedAt) }}</span>
            </span>
          </button>
          <div v-if="!inbox.length" class="cron-empty">
            <h3>No new reports.</h3>
            <p>Read and replaced reports are in History.</p>
          </div>
        </template>

        <template v-else-if="panel.tab === 'jobs'">
          <button
            v-for="job in jobs"
            :key="job.id"
            type="button"
            class="cron-item"
            :class="{ active: panel.jobId === job.id }"
            :data-job="job.id"
            @click="selectJob(job)"
          >
            <span class="cron-item-title" dir="auto">{{ job.name }}</span>
            <span class="cron-item-meta">
              <span class="cron-pill" :class="{ ok: job.enabled && job.lastRun?.status !== 'running', running: job.lastRun?.status === 'running' }">
                {{ job.lastRun?.status === "running" ? "Running" : job.enabled ? "Enabled" : "Paused" }}
              </span>
              <span class="cron-item-job">{{ scheduleDesc(job) }}</span>
              <span class="cron-item-time" :title="date(job.nextRun)">{{ job.nextRun ? whenText(job.nextRun) : "not scheduled" }}</span>
            </span>
          </button>
          <div v-if="!jobs.length" class="cron-empty">
            <h3>No jobs yet.</h3>
            <p>Create a scheduled prompt with New job.</p>
          </div>
        </template>

        <template v-else>
          <div class="cron-filter">
            <label class="cron-filter-field">
              <span>Job</span>
              <select aria-label="Filter history by job" v-model="panel.historyJob" @change="applyHistoryFilter">
                <option value="">All jobs</option>
                <option v-for="job in jobs" :key="job.id" :value="String(job.id)">{{ job.name }}</option>
              </select>
            </label>
          </div>
          <button
            v-for="run in historyRows"
            :key="run.id"
            :disabled="busy"
            type="button"
            class="cron-item"
            :class="{ active: detail?.id === run.id }"
            :data-run="run.id"
            @click="openReport(run)"
          >
            <span class="cron-item-outcome" :class="run.status" dir="auto">{{ outcome(run) }}</span>
            <span class="cron-item-meta">
              <span class="cron-pill" :class="run.status">{{ statusLabel(run) }}</span>
              <span v-if="run.readAt === null" class="cron-pill unread">Unread</span>
              <span class="cron-item-job" dir="auto">{{ run.jobName }}</span>
              <span class="cron-item-time" :title="date(run.endedAt || run.startedAt)">{{ timeAgo(run.endedAt || run.startedAt) }}</span>
            </span>
          </button>
          <p v-if="!historyRows.length" class="cron-empty-line">No reports in history.</p>
          <button v-if="historyMore" type="button" class="cron-btn cron-load-more" :disabled="busy" @click="loadMoreHistory">Load more</button>
        </template>
      </aside>

      <section class="cron-detail" aria-label="Selected item">
        <template v-if="detail && (panel.tab === 'reports' || panel.tab === 'history')">
          <header class="cron-detail-head">
            <button type="button" class="cron-back" @click="backToList">
              <ArrowLeft :size="15" /> {{ panel.tab === "reports" ? "Reports" : "History" }}
            </button>
            <div class="cron-detail-titles">
              <span class="cron-pill" :class="detail.status">{{ statusLabel(detail) }}</span>
              <h3 dir="auto">{{ detail.jobName }}</h3>
              <span class="cron-detail-time">{{ date(detail.endedAt || detail.startedAt) }}</span>
            </div>
            <div class="cron-detail-actions">
              <button v-if="detail.readAt !== null" type="button" class="cron-btn" :disabled="busy" @click="markUnread(detail)">
                Mark unread
              </button>
              <button v-if="reportJob" type="button" class="cron-btn" :disabled="busy" @click="runNow(reportJob)">
                <Play :size="15" /> Run now
              </button>
              <button type="button" class="cron-btn primary" @click="continueRun(detail)">Continue in chat</button>
            </div>
            <div class="cron-detail-meta">
              <span>Run #{{ detail.id }}</span>
              <span>{{ durationText(detail) }}</span>
              <span v-if="detail.reason">{{ reasonText(detail.reason) }}</span>
            </div>
          </header>
          <article class="cron-report-body">
            <Markdown :content="runMarkdown(detail)" />
          </article>
        </template>

        <template v-else-if="panel.tab === 'jobs' && editor">
          <form class="cron-form" :aria-label="editor.jobId ? 'Edit job' : 'New job'" @submit.prevent="saveJob">
            <div class="cron-form-head">
              <h3>{{ editor.jobId ? "Edit job" : "New job" }}</h3>
              <span class="cron-tz-tag">{{ editor.jobId ? `#${editor.jobId}` : "Draft" }}</span>
            </div>
            <label class="cron-field">
              <span>Job name</span>
              <input dir="auto" aria-label="Job name" v-model="editor.name" required />
            </label>
            <label v-if="!editor.intervalMs" class="cron-field">
              <span>Schedule</span>
              <input aria-label="Schedule" v-model="editor.expr" required />
              <span class="cron-presets">
                <button v-for="preset in schedulePresets" :key="preset.expr" type="button" class="cron-preset" @click="editor.expr = preset.expr">
                  {{ preset.label }}
                </button>
              </span>
            </label>
            <p v-else class="cron-help">
              Imported interval: every {{ editor.intervalMs / 60000 }} minutes. The interval is preserved.
            </p>
            <p class="cron-help">Schedules use server local time ({{ jobs[0]?.timezone || "local" }}). Use five cron fields or @daily, @hourly, @weekly.</p>
            <label class="cron-field">
              <span>Prompt</span>
              <textarea dir="auto" aria-label="Prompt" v-model="editor.prompt" rows="5" />
            </label>
            <label class="cron-field">
              <span>Reporting</span>
              <select aria-label="Reporting" v-model="editor.reportPolicy">
                <option v-for="(text, value) in policies" :key="value" :value="value">{{ text }}</option>
              </select>
            </label>
            <p class="cron-help">
              A failure always creates a report. “Output changes” compares the exact text after trimming outer spaces.
            </p>
            <div class="cron-form-actions">
              <button type="submit" class="cron-btn primary" :disabled="busy">Save job</button>
              <button type="button" class="cron-btn" @click="cancelEdit">Cancel</button>
            </div>
          </form>
        </template>

        <template v-else-if="panel.tab === 'jobs' && detailJob">
          <header class="cron-detail-head">
            <div class="cron-detail-titles">
              <span class="cron-pill" :class="{ ok: detailJob.enabled, running: detailJob.lastRun?.status === 'running' }">
                {{ detailJob.enabled ? "Enabled" : "Paused" }}
              </span>
              <h3 dir="auto">{{ detailJob.name }}</h3>
              <span class="cron-detail-time">{{ scheduleDesc(detailJob) }}</span>
            </div>
            <div class="cron-detail-actions">
              <button type="button" class="cron-btn" @click="editJob(detailJob)"><Pencil :size="15" /> Edit</button>
              <button type="button" class="cron-btn" :disabled="busy || detailJob.lastRun?.status === 'running'" @click="runNow(detailJob)">
                <Play :size="15" /> Run now
              </button>
              <button type="button" class="cron-btn" :disabled="busy" @click="toggleJob(detailJob)">
                <Pause :size="15" /> {{ detailJob.enabled ? "Pause" : "Resume" }}
              </button>
              <button type="button" class="cron-btn" @click="showJobHistory(detailJob)">Report history</button>
              <button type="button" class="cron-btn danger" :disabled="busy || detailJob.lastRun?.status === 'running'" @click="deleteJob(detailJob)">
                <Trash2 :size="15" /> Delete
              </button>
            </div>
            <div class="cron-detail-meta">
              <span>Next run: {{ date(detailJob.nextRun) }}</span>
              <span>Last result: {{ detailJob.lastRun ? statusLabel(detailJob.lastRun) : "No runs yet" }}</span>
              <span>Reporting: {{ policies[detailJob.reportPolicy] }}</span>
            </div>
          </header>
          <div class="cron-job-body">
            <section class="cron-block">
              <h4>{{ detailJob.execution ? "Imported script" : "Prompt" }}</h4>
              <pre v-if="detailJob.execution" class="cron-pre">Command: {{ detailJob.execution.command.join(" ") }}
Directory: {{ detailJob.execution.cwd || "Server default" }}</pre>
              <pre v-else class="cron-pre" dir="auto">{{ detailJob.prompt }}</pre>
            </section>
            <section class="cron-block">
              <h4>Recent runs</h4>
              <details v-for="run in jobRuns" :key="run.id" class="cron-run" @toggle="onRunToggle($event, run.id)">
                <summary>
                  <span class="cron-pill" :class="run.status">{{ statusLabel(run) }}</span>
                  <span class="cron-run-snippet" dir="auto">{{ outcome(run) }}</span>
                  <span class="cron-run-time">{{ date(run.endedAt || run.startedAt) }}</span>
                </summary>
                <div v-if="openRuns.has(run.id)" class="cron-run-body">
                  <div class="cron-run-actions">
                    <span class="cron-muted">Run #{{ run.id }} · {{ durationText(run) }}</span>
                    <button type="button" class="cron-btn sm" @click="continueRun(run)">Continue in chat</button>
                  </div>
                  <Markdown :content="runMarkdown(run)" />
                </div>
              </details>
              <p v-if="!jobRuns.length" class="cron-muted">No runs yet.</p>
            </section>
          </div>
        </template>

        <div v-else class="cron-empty cron-empty-detail">
          <h3 v-if="panel.tab === 'reports'">No report selected.</h3>
          <h3 v-else-if="panel.tab === 'jobs'">No job selected.</h3>
          <h3 v-else>No history entry selected.</h3>
          <p>{{ panel.tab === "reports" ? "Open a report to read it. Opening marks it read and leaves it visible until you go back." : panel.tab === "jobs" ? "Select a job to inspect its schedule, health, and recent runs." : "Select a report to read what it recorded." }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cron-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
  color: var(--foreground);
}

.cron-tabbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.cron-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
}

.cron-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 13px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
}

.cron-tab:hover {
  color: var(--foreground);
}

.cron-tab[aria-selected="true"] {
  background: var(--secondary);
  color: var(--foreground);
  font-weight: 600;
}

.cron-tab-count {
  font-size: 11px;
  font-weight: 600;
  padding: 0 5px;
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-foreground);
  font-variant-numeric: tabular-nums;
}

.cron-tab-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cron-status {
  margin: 0;
  padding: 7px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
  font-size: 13px;
  color: var(--muted-foreground);
}

.cron-status.error {
  color: var(--destructive);
  background: var(--err-soft);
}

.cron-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.cron-btn:hover:not(:disabled) {
  background: var(--secondary);
}

.cron-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cron-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground);
  font-weight: 600;
}

.cron-btn.danger {
  color: var(--destructive);
  border-color: rgba(248, 113, 113, 0.3);
}

.cron-btn.sm {
  height: 27px;
  padding: 0 8px;
  font-size: 12.5px;
}

.cron-split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(300px, 400px) minmax(0, 1fr);
}

.cron-list {
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--sidebar);
}

.cron-detail {
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
}

.cron-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: inherit;
  padding: 12px 14px;
  cursor: pointer;
}

.cron-item:hover {
  background: var(--card);
}

.cron-item.active {
  background: var(--card);
  box-shadow: inset 2px 0 0 var(--primary-text);
}

.cron-item-outcome {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.cron-item-outcome.error {
  color: var(--destructive);
}

.cron-item-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cron-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--muted-foreground);
}

.cron-item-job {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cron-item-time {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: var(--faint);
}

.cron-pill {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--secondary);
  color: var(--muted-foreground);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.cron-pill.ok {
  color: var(--ok);
  background: rgba(143, 211, 165, 0.12);
  border-color: rgba(143, 211, 165, 0.28);
}

.cron-pill.error {
  color: var(--destructive);
  background: rgba(248, 113, 113, 0.12);
  border-color: rgba(248, 113, 113, 0.3);
}

.cron-pill.running {
  color: var(--primary-text);
  background: var(--acc-soft);
  border-color: rgba(169, 184, 255, 0.3);
}

.cron-pill.unread {
  background: var(--acc-soft);
  color: var(--primary-text);
}

.cron-empty {
  padding: 22px 16px;
}

.cron-empty h3 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.cron-empty p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted-foreground);
}

.cron-empty-line {
  margin: 0;
  padding: 18px 16px;
  font-size: 13px;
  color: var(--muted-foreground);
}

.cron-empty-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px;
}

.cron-empty-detail p {
  max-width: 340px;
}

.cron-filter {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.cron-filter-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--muted-foreground);
}

.cron-filter-field select {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--input);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--foreground);
  font-size: 13px;
}

.cron-load-more {
  margin: 12px 14px;
}

.cron-detail-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
}

.cron-back {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  cursor: pointer;
}

.cron-back:hover {
  color: var(--foreground);
}

.cron-detail-titles {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.cron-detail-titles h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.cron-detail-time {
  font-size: 12.5px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.cron-detail-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.cron-detail-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--faint);
}

.cron-report-body {
  padding: 20px 22px 36px;
  max-width: 900px;
  line-height: 1.65;
}

.cron-job-body {
  padding: 18px 22px 36px;
  display: grid;
  gap: 18px;
  max-width: 900px;
}

.cron-block h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.cron-pre {
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  font-family: var(--mono);
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cron-run {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  margin-bottom: 6px;
}

.cron-run > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  cursor: pointer;
  list-style: none;
}

.cron-run > summary::-webkit-details-marker {
  display: none;
}

.cron-run-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--muted-foreground);
}

.cron-run-time {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

.cron-run-body {
  border-top: 1px solid var(--border);
  padding: 11px 12px;
}

.cron-run-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.cron-muted {
  font-size: 12.5px;
  color: var(--muted-foreground);
}

.cron-form {
  display: grid;
  gap: 12px;
  padding: 18px 22px 36px;
  max-width: 640px;
}

.cron-form-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.cron-form-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}

.cron-tz-tag {
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--secondary);
  color: var(--muted-foreground);
}

.cron-field {
  display: grid;
  gap: 5px;
  font-size: 12.5px;
  color: var(--muted-foreground);
}

.cron-field input,
.cron-field textarea,
.cron-field select {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--input);
  border-radius: var(--radius);
  background: var(--background);
  color: var(--foreground);
  font-size: 14px;
}

.cron-field textarea {
  font-size: 14.5px;
  line-height: 1.5;
  resize: vertical;
}

.cron-presets {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.cron-preset {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--secondary);
  color: var(--muted-foreground);
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
}

.cron-preset:hover {
  color: var(--foreground);
  border-color: var(--primary);
}

.cron-help {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--faint);
}

.cron-form-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 760px) {
  .cron-split {
    display: flex;
    flex-direction: column;
  }
  .cron-list {
    flex: 0 1 45%;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .cron-panel.detail-only .cron-list {
    display: none;
  }
  .cron-detail {
    flex: 1;
  }
  .cron-tabbar {
    padding: 8px 10px;
  }
  .cron-tab {
    padding: 5px 10px;
    font-size: 13px;
  }
  .cron-detail-head {
    padding: 10px 12px;
  }
  .cron-report-body,
  .cron-job-body,
  .cron-form {
    padding: 14px 14px 28px;
  }
}
</style>
