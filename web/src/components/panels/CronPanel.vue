<script setup lang="ts">
import { confirmAction } from "@/lib/confirm";
// Cron floating panel: an unread report inbox, job management, and one shared report history.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { CheckCheck, Plus, RefreshCw } from "@lucide/vue";
import { json, post, serverUrl, token } from "@/lib/api";
import { handleTablistKeydown } from "@/lib/keyboard";
import { closePanel, ui } from "@/stores/app";
import { continueCronRun } from "@/stores/chat";
import { cronPanel as panel, type CronEditor, type CronJob, type CronRun, type CronTab } from "./cron/state";
import CronReportsTab from "./cron/CronReportsTab.vue";
import CronJobsTab from "./cron/CronJobsTab.vue";
import CronHistoryTab from "./cron/CronHistoryTab.vue";
import CronJobEditor from "./cron/CronJobEditor.vue";
import CronRunDetail from "./cron/CronRunDetail.vue";
import CronJobDetail from "./cron/CronJobDetail.vue";

const PAGE = 20;
const tabs: { id: CronTab; label: string }[] = [
  { id: "reports", label: "Reports" },
  { id: "jobs", label: "Jobs" },
  { id: "history", label: "History" },
];

const jobs = ref<CronJob[]>([]);
const inbox = ref<CronRun[]>([]);
const inboxCursor = ref<string | null>(null);
const inboxMore = ref(false);
const inboxLoading = ref(false);
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
let inboxSeq = 0, disposed = false;
const context = () => JSON.stringify([serverUrl.value, token.value]);

let inboxAbortController: AbortController | null = null;
let historyAbortController: AbortController | null = null;
let jobRunsAbortController: AbortController | null = null;
let jobsAbortController: AbortController | null = null;

function message(text: string, error = false) {
  panel.status = text;
  panel.statusError = error;
}
function fail(e: unknown) {
  if (e instanceof DOMException && e.name === "AbortError") return;
  message(e instanceof Error ? e.message : String(e), true);
}
async function guard(action: () => Promise<void>) {
  if (disposed) return;
  const scope = context();
  if (busy.value) return;
  busy.value = true;
  panel.status = "";
  try {
    await action();
  } catch (e) {
    if (!disposed && scope === context()) fail(e);
  } finally {
    if (!disposed && scope === context()) busy.value = false;
  }
}

async function loadJobs() {
  if (disposed) return;
  jobsAbortController?.abort();
  const controller = new AbortController();
  jobsAbortController = controller;
  try {
    const data = await json("/v1/cron?summary=1", { signal: controller.signal });
    if (controller.signal.aborted) return;
    jobs.value = data.jobs;
    if (data.unreadCount !== undefined) ui.cronUnread = data.unreadCount;
    if (!jobs.value.some(j => j.id === panel.jobId)) panel.jobId = jobs.value[0]?.id ?? null;
  } finally {
    if (jobsAbortController === controller) jobsAbortController = null;
  }
}

async function loadInbox(reset = true, refreshLoaded = false) {
  if (disposed) return;
  inboxAbortController?.abort();
  const controller = new AbortController();
  inboxAbortController = controller;
  const seq = ++inboxSeq;

  inboxLoading.value = true;

  try {
    // Background refresh keeps the expanded window. Initial and explicit pages stay bounded to PAGE.
    const target = refreshLoaded ? Math.max(PAGE, inbox.value.length) : PAGE;
    const rows: CronRun[] = [];
    let cursor = reset ? null : inboxCursor.value;
    let unreadCount: number | undefined;
    do {
      const q = new URLSearchParams({ order: "attention", limit: String(Math.min(100, target - rows.length)) });
      if (cursor) q.set("cursor", cursor);
      const data = await json<{ reports: CronRun[]; nextCursor?: string | null; unreadCount?: number }>("/v1/cron/reports?" + q, { signal: controller.signal });
      if (seq !== inboxSeq || controller.signal.aborted) return;
      rows.push(...data.reports);
      cursor = data.nextCursor ?? null;
      unreadCount = data.unreadCount;
    } while (refreshLoaded && cursor && rows.length < target);
    inbox.value = reset ? rows : [...inbox.value, ...rows];
    inboxCursor.value = cursor;
    inboxMore.value = !!cursor;
    if (unreadCount !== undefined) ui.cronUnread = unreadCount;
  } finally {
    if (seq === inboxSeq) inboxLoading.value = false;
    if (inboxAbortController === controller) inboxAbortController = null;
  }
}

async function loadHistory(reset = true) {
  if (disposed) return;
  historyAbortController?.abort();
  const controller = new AbortController();
  historyAbortController = controller;
  const seq = ++historySeq;

  try {
    const q = new URLSearchParams({ history: "1", limit: String(PAGE) });
    if (panel.historyJob) q.set("jobId", panel.historyJob);
    const before = reset ? null : historyRows.value.at(-1)?.id;
    if (before) q.set("before", String(before));

    const data = await json("/v1/cron/reports?" + q, { signal: controller.signal });
    if (seq !== historySeq || controller.signal.aborted) return;

    historyRows.value = reset ? data.reports : [...historyRows.value, ...data.reports];
    historyMore.value = data.reports.length === PAGE;
  } finally {
    if (historyAbortController === controller) historyAbortController = null;
  }
}

async function loadJobRuns() {
  if (disposed) return;
  jobRunsAbortController?.abort();
  const id = panel.jobId, seq = ++jobRunsSeq;
  if (id === null) { jobRuns.value = []; return; }

  const controller = new AbortController();
  jobRunsAbortController = controller;

  try {
    const data = await json(`/v1/cron/runs?jobId=${id}&history=1&limit=10`, { signal: controller.signal });
    if (seq !== jobRunsSeq || panel.jobId !== id || controller.signal.aborted) return;
    jobRuns.value = data.runs;
  } finally {
    if (jobRunsAbortController === controller) jobRunsAbortController = null;
  }
}

function selectTab(tab: CronTab) {
  if (busy.value || panel.tab === tab) return;
  panel.tab = tab;
  panel.detail = null;
  message("");
  void guard(async () => {
    if (tab === "history") await loadHistory(true);
    if (tab === "jobs") { await loadJobs(); await loadJobRuns(); }
    if (tab === "reports") await loadInbox(true);
  });
}

function applyHistoryFilter() {
  panel.detail = null;
  void guard(() => loadHistory(true));
}
function loadMoreHistory() {
  void guard(() => loadHistory(false));
}
function loadMoreInbox() {
  void guard(() => loadInbox(false));
}

function openReport(run: CronRun) {
  panel.detail = run;
  if (run.readAt !== null) return;
  void guard(async () => {
    const updated = await post(`/v1/cron/reports/${run.id}`, { read: true }, "PATCH");
    if (panel.detail?.id === run.id) panel.detail = updated;
    // Keep the selected detail visible; older reports stay superseded in History.
    await loadInbox(true);
  });
}
function markUnread(run: CronRun) {
  void guard(async () => {
    const updated = await post(`/v1/cron/reports/${run.id}`, { read: false }, "PATCH");
    if (panel.detail?.id === run.id) panel.detail = updated;
    await loadInbox(true);
  });
}
function markAllRead() {
  void guard(async () => {
    const res = await post("/v1/cron/reports/read-all", {});
    if (res?.unreadCount !== undefined) ui.cronUnread = res.unreadCount;
    await loadInbox(true);
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
  panel.editor = { jobId: null, name: "", expr: "@daily", prompt: "", reportPolicy: "always", hidden: false };
  message("");
}
function editJob(job: CronJob) {
  panel.editor = {
    jobId: job.id,
    name: job.name,
    expr: job.expr,
    prompt: job.prompt,
    reportPolicy: job.reportPolicy,
    hidden: !!job.hidden,
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
    const body: Record<string, unknown> = { name, prompt, reportPolicy: ed.reportPolicy, hidden: ed.hidden };
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
    message(`Started "${job.name}".`);
    await loadJobs();
  });
}
function toggleJob(job: CronJob) {
  void guard(async () => {
    await post(`/v1/cron/${job.id}`, { enabled: !job.enabled }, "PATCH");
    await loadJobs();
  });
}
async function deleteJob(job: CronJob) {
  if (!(await confirmAction({ title: `Delete job "${job.name}"?`, message: 'Reports and run history will be kept.', confirmLabel: 'Delete', danger: true }))) return;
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

watch([serverUrl, token], () => {
  inboxSeq++; historySeq++; jobRunsSeq++;
  inboxAbortController?.abort(); historyAbortController?.abort(); jobRunsAbortController?.abort(); jobsAbortController?.abort();
  inbox.value = []; historyRows.value = []; jobRuns.value = []; jobs.value = [];
  inboxCursor.value = null; inboxMore.value = false; historyMore.value = false; busy.value = false; ui.cronUnread = 0;
  void guard(async () => { await loadInbox(); await loadJobs(); });
}, { flush: "sync" });
onMounted(() => {
  void guard(async () => {
    await loadInbox(true);
    await loadJobs();
    if (panel.tab === "history") await loadHistory(true);
    if (panel.tab === "jobs") await loadJobRuns();
  });
  timer = setInterval(() => {
    if (document.hidden || busy.value) return;
    // Revalidate only the loaded window, without collapsing expanded pages.
    if (panel.tab === "reports") {
      if (!inboxLoading.value) {
        void loadInbox(true, true).catch((e: unknown) => { fail(e); });
      }
    }
    else if (panel.tab === "jobs") { void loadJobs().then(loadJobRuns).catch((e: unknown) => { fail(e); }); }
  }, 5000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  inboxAbortController?.abort();
  historyAbortController?.abort();
  jobRunsAbortController?.abort();
  jobsAbortController?.abort();
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
      <div class="cron-tabs" role="tablist" aria-label="Cron sections" @keydown="handleTablistKeydown">
        <button
          v-for="tab in tabs"
          :id="`cron-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          role="tab"
          class="cron-tab"
          :aria-selected="panel.tab === tab.id"
          :tabindex="panel.tab === tab.id ? 0 : -1"
          :aria-disabled="busy"
          :class="{ 'opacity-50': busy }"
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
        <CronReportsTab
          v-if="panel.tab === 'reports'"
          :inbox="inbox"
          :detail-id="detail?.id"
          :busy="busy"
          :has-more="inboxMore"
          :loading="inboxLoading"
          @open-report="openReport"
          @load-more="loadMoreInbox"
        />
        <CronJobsTab
          v-else-if="panel.tab === 'jobs'"
          :jobs="jobs"
          :selected-job-id="panel.jobId"
          @select-job="selectJob"
        />
        <CronHistoryTab
          v-else
          :jobs="jobs"
          :history-rows="historyRows"
          :history-more="historyMore"
          v-model:history-job="panel.historyJob"
          :detail-id="detail?.id"
          :busy="busy"
          @filter-change="applyHistoryFilter"
          @open-report="openReport"
          @load-more="loadMoreHistory"
        />
      </aside>

      <section class="cron-detail" aria-label="Selected item">
        <CronRunDetail
          v-if="detail && (panel.tab === 'reports' || panel.tab === 'history')"
          :detail="detail"
          :tab="panel.tab"
          :report-job="reportJob"
          :busy="busy"
          @back="backToList"
          @mark-unread="markUnread"
          @run-now="runNow"
          @continue-run="continueRun"
        />
        <CronJobEditor
          v-else-if="panel.tab === 'jobs' && editor"
          :editor="editor"
          :busy="busy"
          @save="saveJob"
          @cancel="cancelEdit"
        />
        <CronJobDetail
          v-else-if="panel.tab === 'jobs' && detailJob"
          :detail-job="detailJob"
          :job-runs="jobRuns"
          :open-runs="openRuns"
          :busy="busy"
          @edit="editJob"
          @run-now="runNow"
          @toggle="toggleJob"
          @show-history="showJobHistory"
          @delete="deleteJob"
          @toggle-run="onRunToggle"
          @continue-run="continueRun"
        />
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

<style>
@import "./cron/cron.css";
</style>
