<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { json, post } from "@/lib/api";
import { ui, navigate, setDrawer } from "@/stores/app";
import { continueCronRun } from "@/stores/chat";
import { refreshCronBadge } from "./cron/badge";
import Markdown from "@/components/chat/Markdown.vue";

const PAGE = 20;
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

const view = ref<"reports" | "jobs" | "runs">("reports");
const selectedJob = ref<string>("");
const selectedStatus = ref<string>("");

const snapshot = reactive({ jobs: [] as any[], timezone: "" });
const statusText = ref("");
const statusError = ref(false);

const runListEl = ref<HTMLElement | null>(null);
const historyDetailsEl = ref<HTMLDetailsElement | null>(null);
const editorHostEl = ref<HTMLElement | null>(null);

const latestMore = ref(false);
const historyMore = ref(false);
const historyLoaded = ref(false);
const historyFetching = ref(false);

const latest = ref<any[]>([]);
const historical = ref<any[]>([]);
const jobs = ref<any[]>([]);

const activeRunId = ref<number | null>(null);
const activeJobId = ref<number | null>(null);

let epoch = 0;
let viewVersion = 0;
let historyRequest = 0;
let pending = false;
let loading = false;
let pollTimer: any = null;
let badgeTimer: any = null;

const jobsMap = ref<Map<string, string>>(new Map());

const activeRun = computed(() => {
  const all = [...latest.value, ...historical.value];
  if (activeRunId.value !== null) {
    const found = all.find((r) => r.id === activeRunId.value);
    if (found) return found;
  }
  return latest.value[0] || historical.value[0] || null;
});

const activeJob = computed(() => {
  if (activeJobId.value !== null) {
    const found = jobs.value.find((j) => j.id === activeJobId.value);
    if (found) return found;
  }
  return jobs.value[0] || null;
});

const inspectedJobForRun = computed(() => {
  const r = activeRun.value;
  if (!r) return null;
  return snapshot.jobs.find((j: any) => j.id === r.jobId) || null;
});

const runningJobsCount = computed(
  () => snapshot.jobs.filter((j: any) => j.lastRun?.status === "running").length,
);

function message(text: string, error = false) {
  statusText.value = text;
  statusError.value = error;
}

function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

function durationText(run: any) {
  if (!run) return "—";
  return run.endedAt
    ? Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1) + " seconds"
    : "Running";
}

function runMarkdown(run: any) {
  if (!run) return "No output.";
  return [run.output, run.error ? "Error: " + run.error : null].filter(Boolean).join("\n\n") || "No output.";
}

function runSnippet(run: any) {
  if (run.error) return `Failed — ${run.error}`;
  if (run.output) {
    const line = String(run.output)
      .replace(/^#+\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    return line.slice(0, 140) || "Completed run.";
  }
  return run.status === "running" ? "Execution in progress…" : "No output.";
}

async function mutate(action: () => Promise<void>) {
  if (pending) return;
  pending = true;
  message("");
  try {
    await action();
  } catch (e: any) {
    message(e.message || String(e), true);
  } finally {
    pending = false;
  }
}

function updateFilters() {
  const m = new Map<string, string>(snapshot.jobs.map((j: any) => [String(j.id), j.name]));
  for (const run of [...latest.value, ...historical.value]) {
    if (!m.has(String(run.jobId))) m.set(String(run.jobId), run.jobName + " (deleted)");
  }
  if (selectedJob.value && !m.has(selectedJob.value)) {
    m.set(selectedJob.value, "Job #" + selectedJob.value + " (deleted)");
  }
  jobsMap.value = m;
}

function resetLists() {
  viewVersion++;
  historyRequest++;
  historyFetching.value = false;
  latest.value = [];
  historical.value = [];
  historyLoaded.value = false;
  latestMore.value = false;
  historyMore.value = false;
  if (historyDetailsEl.value) historyDetailsEl.value.open = false;
}

function selectView(next: "reports" | "jobs" | "runs") {
  if (view.value === next) return;
  view.value = next;
  resetLists();
  message("");
  dismissEditor();
  load();
}

function query(isHistory: boolean, before?: number | string, limit = PAGE) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (isHistory) q.set("history", "1");
  if (selectedJob.value) q.set("jobId", selectedJob.value);
  if (view.value === "runs" && selectedStatus.value) q.set("status", selectedStatus.value);
  if (before) q.set("before", String(before));
  return `/v1/cron/${view.value === "reports" ? "reports" : "runs"}?${q}`;
}

function rows(data: any) {
  return view.value === "reports" ? data.reports : data.runs;
}

const valid = (e: number, v: number) => ui.view === "cron" && epoch === e && viewVersion === v;

async function fetchRange(isHistory: boolean, count: number, e: number, v: number) {
  let result: any[] = [], data: any, page: any[] = [];
  do {
    data = await json(query(isHistory, result.at(-1)?.id, Math.min(100, Math.max(PAGE, count - result.length))));
    if (!valid(e, v)) return { items: [], more: false, unreadCount: 0 };
    page = rows(data);
    result.push(...page);
  } while (result.length < count && page.length === 100);
  return { items: result, more: page.length >= PAGE, unreadCount: data.unreadCount };
}

let loadSeq = 0;
async function load() {
  if (ui.view !== "cron" || document.hidden) return;
  const e = epoch, v = viewVersion, currentView = view.value;
  const ticket = ++loadSeq;
  loading = true;
  try {
    const summary = await json("/v1/cron?summary=1");
    if (!valid(e, v) || ticket !== loadSeq) return;
    Object.assign(snapshot, summary);
    ui.cronUnread = summary.unreadCount;
    updateFilters();
    if (currentView === "jobs") {
      jobs.value = summary.jobs;
      if (activeJobId.value === null && jobs.value.length > 0) {
        activeJobId.value = jobs.value[0].id;
      }
      latestMore.value = false;
    } else {
      const data = await fetchRange(false, Math.max(PAGE, latest.value.length), e, v);
      if (!valid(e, v) || ticket !== loadSeq) return;
      latest.value = data.items;
      if (activeRunId.value === null && latest.value.length > 0) {
        activeRunId.value = latest.value[0].id;
      }
      latestMore.value = data.more;
      if (currentView === "reports") ui.cronUnread = data.unreadCount;
      if (historyDetailsEl.value?.open && historyLoaded.value) {
        await refreshHistory(e, v, ticket);
      }
    }
    if (valid(e, v)) updateFilters();
  } catch (error: any) {
    if (valid(e, v) && ticket === loadSeq) message(error.message, true);
  } finally {
    if (ticket === loadSeq) loading = false;
  }
}

async function refreshHistory(e: number, v: number, ticket: number) {
  const request = ++historyRequest;
  const data = await fetchRange(true, Math.max(PAGE, historical.value.length), e, v);
  if (!valid(e, v) || request !== historyRequest || ticket !== loadSeq) return;
  historical.value = data.items;
  historyMore.value = data.more;
}

async function loadHistory() {
  const e = epoch, v = viewVersion, request = ++historyRequest;
  historyFetching.value = true;
  try {
    const data = await json(query(true));
    if (!valid(e, v) || request !== historyRequest) return;
    historical.value = rows(data);
    historyLoaded.value = true;
    historyMore.value = historical.value.length === PAGE;
    updateFilters();
  } catch (error: any) {
    if (valid(e, v) && request === historyRequest) message(error.message, true);
  } finally {
    if (request === historyRequest) historyFetching.value = false;
  }
}

async function loadMore(isHistory: boolean) {
  await mutate(async () => {
    const ticket = ++loadSeq;
    const request = ++historyRequest;
    const e = epoch, v = viewVersion, source = isHistory ? historical : latest;
    const data = await json(query(isHistory, source.value.at(-1)?.id));
    if (!valid(e, v)) return;
    const additional = rows(data);
    const combined = [...new Map([...source.value, ...additional].map((r: any) => [r.id, r])).values()];
    if (isHistory) {
      historical.value = combined;
      historyMore.value = additional.length === PAGE;
    } else {
      latest.value = combined;
      latestMore.value = additional.length === PAGE;
    }
  });
}

function onHistoryToggle(e: Event) {
  const target = e.target as HTMLDetailsElement;
  if (target.open && !historyLoaded.value && !historyFetching.value) {
    loadHistory();
  }
}

async function selectRun(run: any, markIfReport = false) {
  activeRunId.value = run.id;
  if (markIfReport && view.value === "reports" && run.readAt === null) {
    await toggleRead(run);
  }
}

async function toggleRead(run: any) {
  await mutate(async () => {
    await post(`/v1/cron/reports/${run.id}`, { read: run.readAt === null }, "PATCH");
    await load();
    await refreshCronBadge();
  });
}

async function runJob(job: any) {
  await mutate(async () => {
    await post(`/v1/cron/${job.id}/run`, {});
    await load();
  });
}

async function toggleJobEnabled(job: any) {
  await mutate(async () => {
    try {
      await post(`/v1/cron/${job.id}`, { enabled: !job.enabled }, "PATCH");
      await load();
    } catch (e: any) {
      message(e.message || String(e), true);
      job.enabled = true;
    }
  });
}

async function deleteJob(job: any) {
  if (confirm(`Delete job "${job.name}"? Reports and run history will be kept.`)) {
    await mutate(async () => {
      await post(`/v1/cron/${job.id}`, {}, "DELETE");
      if (editorState.active && editorState.job?.id === job.id) dismissEditor();
      if (activeJobId.value === job.id) activeJobId.value = null;
      await load();
    });
  }
}

function showJobReports(job: any) {
  selectedJob.value = String(job.id);
  selectView("reports");
}

function showJobRuns(job: any) {
  selectedJob.value = String(job.id);
  selectView("runs");
}

const editorState = reactive({
  active: false,
  job: null as any | null,
  name: "",
  expr: "@daily",
  prompt: "",
  reportPolicy: "always",
});

function showEditor(job?: any) {
  editorState.active = true;
  editorState.job = job || null;
  editorState.name = job?.name || "";
  editorState.expr = job?.expr || "@daily";
  editorState.prompt = job?.prompt || "";
  editorState.reportPolicy = job?.reportPolicy || "always";
  if (job?.id) activeJobId.value = job.id;
}

function dismissEditor() {
  editorState.active = false;
  editorState.job = null;
}

async function saveJob(e: Event) {
  e.preventDefault();
  await mutate(async () => {
    const job = editorState.job;
    const body: any = {
      name: editorState.name.trim(),
      prompt: editorState.prompt,
      reportPolicy: editorState.reportPolicy,
    };
    if (!job?.intervalMs) body.expr = editorState.expr.trim();
    const saved: any = await post(job ? `/v1/cron/${job.id}` : "/v1/cron", body, job ? "PATCH" : "POST");
    if (saved?.id) activeJobId.value = saved.id;
    dismissEditor();
    await load();
    message("Job saved.");
  });
}

function scheduleDesc(job: any) {
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
  };
  if (aliases[job.expr]) return aliases[job.expr];
  if (job.expr === "* * * * *") return "Every minute";
  return job.expr;
}

async function handleContinueCronRun(run: any) {
  try {
    await continueCronRun(run);
  } catch (e: any) {
    message(e.message || String(e), true);
  }
}

function startTimers() {
  clearInterval(pollTimer);
  clearInterval(badgeTimer);
  if (document.hidden) return;
  pollTimer = setInterval(() => {
    if (ui.view === "cron" && !pending && !loading) load();
  }, 3000);
  badgeTimer = setInterval(refreshCronBadge, 15000);
}

onMounted(() => {
  epoch++;
  load();
  startTimers();
  document.addEventListener("visibilitychange", startTimers);
});

onUnmounted(() => {
  epoch++;
  clearInterval(pollTimer);
  clearInterval(badgeTimer);
  document.removeEventListener("visibilitychange", startTimers);
});
</script>

<template>
  <div id="cron-screen" class="cron-workbench-screen">
    <!-- Top Bar -->
    <header class="cron-top-bar">
      <div class="cron-top-left">
        <button id="cron-menu" type="button" class="icon-button" @click="setDrawer(true)" aria-label="Open navigation" aria-controls="side">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-menu"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
        </button>
        <div class="cron-top-title">
          <h1>Cron</h1>
          <span class="cron-tz-tag">{{ snapshot.timezone || 'Local time' }}</span>
        </div>

        <nav class="cron-tabs" aria-label="Cron sections">
          <button
            type="button"
            class="cron-seg-tab"
            :aria-pressed="view === 'reports'"
            :aria-selected="view === 'reports'"
            @click="selectView('reports')"
          >
            Reports
          </button>
          <button
            type="button"
            class="cron-seg-tab"
            :aria-pressed="view === 'jobs'"
            :aria-selected="view === 'jobs'"
            @click="selectView('jobs')"
          >
            Jobs
          </button>
          <button
            type="button"
            class="cron-seg-tab"
            :aria-pressed="view === 'runs'"
            :aria-selected="view === 'runs'"
            @click="selectView('runs')"
          >
            Runs
          </button>
        </nav>

        <div class="cron-top-badges">
          <span v-if="ui.cronUnread > 0" class="cron-mini-badge unread">{{ ui.cronUnread }} unread</span>
          <span v-if="runningJobsCount > 0" class="cron-mini-badge running">● {{ runningJobsCount }} running</span>
        </div>
      </div>

      <div class="cron-top-actions">
        <button v-show="view === 'jobs'" type="button" class="cron-btn primary" @click="showEditor()">New job</button>
        <button type="button" class="cron-btn" @click="navigate('chat')">Back to chat</button>
      </div>
    </header>

    <p v-show="statusText" class="cron-status-banner muted" role="status" aria-live="polite" :class="{ 'cron-error': statusError }">
      {{ statusText }}
    </p>
    <p v-show="!statusText" class="sr-only" role="status" aria-live="polite"></p>

    <!-- Split Workbench: Master Feed (Left) + Persistent Inspector (Right) -->
    <div class="cron-split-workbench">
      <!-- LEFT: Master Pane -->
      <aside class="cron-master-pane">
        <div class="cron-master-filters" v-show="view !== 'jobs'">
          <label class="cron-filter-field">
            <span>Job</span>
            <select aria-label="Job" v-model="selectedJob" @change="resetLists(); load();">
              <option value="">All jobs</option>
              <option v-for="[id, name] in jobsMap" :key="id" :value="id">{{ name }}</option>
            </select>
          </label>
          <label class="cron-filter-field" v-show="view === 'runs'">
            <span>Status</span>
            <select aria-label="Status" v-model="selectedStatus" @change="resetLists(); load();">
              <option value="">Active and recent failures</option>
              <option value="running">Running</option>
              <option value="ok">Success</option>
              <option value="error">Failed</option>
            </select>
          </label>
        </div>

        <div class="cron-master-scroll">
          <!-- Inline Editor Host (inside master flow on mobile, or when active) -->
          <div ref="editorHostEl" v-if="editorState.active" class="cron-editor-wrap">
            <form class="card grid cron-editor-card" :aria-label="editorState.job ? 'Edit job' : 'New job'" :data-job="editorState.job?.id || 'new'" @submit="saveJob">
              <div class="cron-editor-head">
                <h2>{{ editorState.job ? 'Edit job' : 'New job' }}</h2>
                <span class="cron-tz-tag">{{ editorState.job ? `#${editorState.job.id}` : 'Draft' }}</span>
              </div>
              <label class="field-label">
                <span>Job name</span>
                <input aria-label="Job name" v-model="editorState.name" required />
              </label>
              <p class="muted" v-if="editorState.job?.intervalMs">
                Interval: {{ editorState.job.intervalMs / 60000 }} minutes. The imported interval is preserved.
              </p>
              <label class="field-label" v-else>
                <span>Schedule</span>
                <input aria-label="Schedule" v-model="editorState.expr" required />
                <div class="cron-preset-row">
                  <button
                    v-for="preset in schedulePresets"
                    :key="preset.expr"
                    type="button"
                    class="cron-preset-chip"
                    @click="editorState.expr = preset.expr"
                  >
                    {{ preset.label }}
                  </button>
                </div>
              </label>
              <p class="muted cron-help-note">
                Schedules use {{ snapshot.timezone || 'server local time' }}. Use five cron fields or @daily, @hourly, @weekly.
              </p>
              <label class="field-label">
                <span>Prompt</span>
                <textarea aria-label="Prompt" v-model="editorState.prompt" rows="5" :required="!editorState.job?.execution"></textarea>
              </label>
              <label class="field-label">
                <span>Reporting</span>
                <select aria-label="Reporting" v-model="editorState.reportPolicy">
                  <option v-for="[val, txt] in Object.entries(policies)" :key="val" :value="val">{{ txt }}</option>
                </select>
              </label>
              <p class="muted cron-help-note">Output changes compares exact text after trimming outer spaces. Every failure creates a report.</p>
              <div class="row">
                <button type="submit" class="cron-btn primary">Save job</button>
                <button type="button" class="cron-btn" @click="dismissEditor()">Cancel</button>
              </div>
            </form>
          </div>

          <!-- Latest List -->
          <div class="cron-feed-list" data-cron-list="latest" ref="runListEl">
            <template v-if="view === 'jobs'">
              <article
                class="card grid cron-job"
                :class="{ 'is-selected': activeJob?.id === job.id, 'is-paused': !job.enabled }"
                v-for="job in jobs"
                :key="job.id"
                :data-job="job.id"
                @click="activeJobId = job.id"
              >
                <div class="cron-row-top">
                  <b class="cron-job-title">{{ job.name }}</b>
                  <span class="pill" :class="job.lastRun?.status === 'running' ? 'running' : job.enabled ? 'ok' : ''">
                    {{ job.enabled ? "Enabled" : "Paused" }}
                  </span>
                </div>
                <div class="cron-sched-row">
                  <span>{{ scheduleDesc(job) }}</span>
                  <code class="cron-expr-pill muted">{{ job.intervalMs ? `Interval: ${job.intervalMs} ms` : job.expr }}</code>
                </div>
                <span class="muted cron-meta-line">Timezone: {{ snapshot.timezone || job.timezone }} (server local time) · Next run: {{ date(job.nextRun) }}</span>
                <span class="muted cron-meta-line">Last result: {{ job.lastRun ? job.lastRun.status + " · " + date(job.lastRun.endedAt || job.lastRun.startedAt) : "No runs yet" }}</span>
                <span class="muted cron-meta-line">Reporting: {{ policies[job.reportPolicy] }}</span>
                <pre v-if="job.execution" class="cron-script-box">Script: {{ job.execution.command.join(" ") }}
Directory: {{ job.execution.cwd || "Server default" }}</pre>
                <div class="row cron-job-actions" @click.stop>
                  <button type="button" class="cron-btn sm" @click="showEditor(job)">Edit</button>
                  <button type="button" class="cron-btn sm" :disabled="job.lastRun?.status === 'running'" @click="runJob(job)">Run now</button>
                  <button type="button" class="cron-btn sm" @click="toggleJobEnabled(job)">{{ job.enabled ? "Pause" : "Resume" }}</button>
                  <button type="button" class="cron-btn sm danger" :disabled="job.lastRun?.status === 'running'" @click="deleteJob(job)">Delete</button>
                  <button type="button" class="cron-btn sm" @click="showJobReports(job)">Reports</button>
                  <button type="button" class="cron-btn sm" @click="showJobRuns(job)">Runs</button>
                </div>
              </article>
              <p class="muted cron-empty-msg" v-if="!jobs.length">No matching records.</p>
            </template>

            <template v-else>
              <article
                v-for="run in latest"
                :key="run.id"
                class="card cron-run"
                :class="{
                  'cron-unread': (view === 'reports' && run.readAt === null),
                  'is-selected': activeRun?.id === run.id
                }"
                :data-run="run.id"
                @click="selectRun(run, true)"
              >
                <div class="cron-feed-summary">
                  <div class="cron-row-top">
                    <span class="cron-job-title">
                      <span v-if="view === 'reports' && run.readAt === null" class="cron-unread-pip" aria-hidden="true"></span>
                      <b>{{ run.jobName }}</b>
                    </span>
                    <span class="muted cron-time-stamp">{{ date(run.endedAt || run.startedAt) }}</span>
                  </div>
                  <div class="cron-feed-snippet">{{ runSnippet(run) }}</div>
                  <div class="cron-feed-tags">
                    <span class="pill" :class="run.status">
                      {{ run.status === 'ok' ? 'Success' : run.status === 'error' ? 'Failed' : 'Running' }}
                    </span>
                    <span class="pill unread" v-if="view === 'reports' && run.readAt === null">Unread</span>
                    <span class="cron-tag-mono">#{{ run.id }} · {{ durationText(run) }}</span>
                  </div>
                </div>
              </article>
              <p class="muted cron-empty-msg" v-if="!latest.length">No matching records.</p>
            </template>
          </div>

          <div class="cron-more-wrap" v-show="view !== 'jobs' && latestMore">
            <button type="button" class="cron-btn" @click="loadMore(false)">Load more</button>
          </div>

          <!-- History details -->
          <details class="cron-history" v-show="view !== 'jobs'" ref="historyDetailsEl" @toggle="onHistoryToggle">
            <summary>Show history</summary>
            <div class="cron-feed-list" data-cron-list="history">
              <article
                v-for="run in historical"
                :key="run.id"
                class="card cron-run"
                :class="{
                  'cron-unread': (view === 'reports' && run.readAt === null),
                  'is-selected': activeRun?.id === run.id
                }"
                :data-run="run.id"
                @click="selectRun(run, false)"
              >
                <div class="cron-feed-summary">
                  <div class="cron-row-top">
                    <span class="cron-job-title">
                      <span v-if="view === 'reports' && run.readAt === null" class="cron-unread-pip" aria-hidden="true"></span>
                      <b>{{ run.jobName }}</b>
                    </span>
                    <span class="muted cron-time-stamp">{{ date(run.endedAt || run.startedAt) }}</span>
                  </div>
                  <div class="cron-feed-snippet">{{ runSnippet(run) }}</div>
                  <div class="cron-feed-tags">
                    <span class="pill" :class="run.status">
                      {{ run.status === 'ok' ? 'Success' : run.status === 'error' ? 'Failed' : 'Running' }}
                    </span>
                    <span class="pill unread" v-if="view === 'reports' && run.readAt === null">Unread</span>
                    <span class="cron-tag-mono">#{{ run.id }} · {{ durationText(run) }}</span>
                  </div>
                </div>
              </article>
              <p class="muted cron-empty-msg" v-if="!historical.length && !historyFetching">No history records.</p>
              <p class="muted cron-empty-msg" v-if="historyFetching">Loading history…</p>
            </div>
            <div class="cron-more-wrap" v-show="historyMore">
              <button type="button" class="cron-btn" @click="loadMore(true)">Load more history</button>
            </div>
          </details>
        </div>
      </aside>

      <!-- RIGHT: Persistent Detail Inspector (Desktop Master-Detail Workbench) -->
      <section class="cron-inspector-pane" data-cron-inspector aria-label="Selected item inspector">
        <template v-if="view === 'jobs' && activeJob">
          <div class="cron-inspector-header">
            <div class="cron-insp-titles">
              <div class="cron-insp-eyebrow">
                <span class="pill" :class="activeJob.enabled ? 'ok' : ''">
                  {{ activeJob.enabled ? 'ENABLED' : 'PAUSED' }}
                </span>
                <span>JOB #{{ activeJob.id }}</span>
                <span>·</span>
                <span>{{ scheduleDesc(activeJob) }}</span>
              </div>
              <h2 class="cron-insp-heading">{{ activeJob.name }}</h2>
            </div>
            <div class="cron-insp-actions">
              <button type="button" class="cron-btn" @click="showEditor(activeJob)">Edit job</button>
              <button type="button" class="cron-btn" :disabled="activeJob.lastRun?.status === 'running'" @click="runJob(activeJob)">Run now</button>
              <button type="button" class="cron-btn" @click="showJobReports(activeJob)">View reports</button>
              <button type="button" class="cron-btn" @click="showJobRuns(activeJob)">View runs</button>
            </div>
          </div>

          <div class="cron-telemetry-strip">
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Schedule</span>
              <span class="cron-tel-val">{{ activeJob.intervalMs ? `${activeJob.intervalMs} ms` : activeJob.expr }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Next Scheduled Run</span>
              <span class="cron-tel-val">{{ date(activeJob.nextRun) }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Last Status</span>
              <span class="cron-tel-val">{{ activeJob.lastRun?.status || 'No runs yet' }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Reporting Policy</span>
              <span class="cron-tel-val">{{ policies[activeJob.reportPolicy] }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Timezone</span>
              <span class="cron-tel-val">{{ snapshot.timezone || activeJob.timezone || 'Local' }}</span>
            </div>
          </div>

          <div class="cron-inspector-body">
            <div class="cron-markdown-surface">
              <h3>{{ activeJob.execution ? 'Imported Script Execution' : 'Configured Prompt' }}</h3>
              <pre v-if="activeJob.execution" class="cron-inspector-pre">Command: {{ activeJob.execution.command.join(" ") }}
Working directory: {{ activeJob.execution.cwd || "Server default" }}</pre>
              <pre v-else class="cron-inspector-pre">{{ activeJob.prompt }}</pre>
            </div>
          </div>
        </template>

        <template v-else-if="view !== 'jobs' && activeRun">
          <div class="cron-inspector-header">
            <div class="cron-insp-titles">
              <div class="cron-insp-eyebrow">
                <span class="pill" :class="activeRun.status">
                  {{ activeRun.status === 'ok' ? 'SUCCESS' : activeRun.status === 'error' ? 'FAILED' : 'RUNNING' }}
                </span>
                <span>RUN #{{ activeRun.id }}</span>
                <span>·</span>
                <span>JOB #{{ activeRun.jobId }}</span>
              </div>
              <h2 class="cron-insp-heading">{{ activeRun.jobName }}</h2>
            </div>
            <div class="cron-insp-actions">
              <button v-if="view === 'reports'" type="button" class="cron-btn" @click="toggleRead(activeRun)">
                {{ activeRun.readAt === null ? 'Mark read' : 'Mark unread' }}
              </button>
              <button v-if="inspectedJobForRun" type="button" class="cron-btn" :disabled="inspectedJobForRun.lastRun?.status === 'running'" @click="runJob(inspectedJobForRun)">
                Run job now
              </button>
              <button v-if="activeRun.status !== 'running'" type="button" class="cron-btn primary" @click="handleContinueCronRun(activeRun)">
                Continue in chat
              </button>
            </div>
          </div>

          <div class="cron-telemetry-strip">
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Schedule</span>
              <span class="cron-tel-val">{{ inspectedJobForRun ? scheduleDesc(inspectedJobForRun) : 'Deleted job' }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Started</span>
              <span class="cron-tel-val">{{ date(activeRun.startedAt) }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Duration</span>
              <span class="cron-tel-val">{{ durationText(activeRun) }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Slot</span>
              <span class="cron-tel-val">{{ date(activeRun.slot) }}</span>
            </div>
            <div class="cron-tel-cell">
              <span class="cron-tel-label">Conversation ID</span>
              <span class="cron-tel-val">Conversation: {{ activeRun.conversationId || 'None' }}</span>
            </div>
          </div>

          <div class="cron-inspector-body">
            <details v-if="inspectedJobForRun" class="cron-prompt-disclosure">
              <summary>Job Prompt &amp; Reporting Policy ({{ policies[inspectedJobForRun.reportPolicy] }})</summary>
              <pre>{{ inspectedJobForRun.execution ? inspectedJobForRun.execution.command.join(' ') : inspectedJobForRun.prompt }}</pre>
            </details>

            <article class="cron-markdown-surface">
              <Markdown :content="runMarkdown(activeRun)" />
            </article>
          </div>
        </template>

        <div v-else class="cron-inspector-empty">
          <div class="cron-empty-box">
            <h3>No item selected</h3>
            <p class="muted">Select a report, job, or execution run from the master list on the left to inspect its telemetry and full Markdown output.</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cron-workbench-screen {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background);
  color: var(--foreground);
  overflow: hidden;
}

.cron-top-bar {
  min-height: 58px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
  background: var(--background);
}

.cron-top-left {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  min-width: 0;
}

.cron-top-title {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.cron-top-title h1 {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin: 0;
}

.cron-tz-tag {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted-foreground);
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--secondary);
  border: 1px solid var(--border);
  white-space: nowrap;
}

.cron-tabs {
  display: inline-flex;
  padding: 3px;
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--border);
  gap: 2px;
}

.cron-seg-tab {
  padding: 5px 13px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}

.cron-seg-tab:hover {
  color: var(--foreground);
}

.cron-seg-tab[aria-selected="true"] {
  background: var(--secondary);
  color: var(--foreground);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.cron-top-badges {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cron-mini-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 99px;
  font-variant-numeric: tabular-nums;
}

.cron-mini-badge.unread {
  background: var(--primary);
  color: var(--primary-foreground);
}

.cron-mini-badge.running {
  background: var(--acc-soft);
  color: var(--primary);
  border: 1px solid rgba(169, 184, 255, 0.3);
}

.cron-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cron-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--card);
  color: var(--foreground);
  font-size: 12.5px;
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
  height: 29px;
  padding: 0 9px;
  font-size: 12px;
}

.cron-status-banner {
  margin: 0;
  padding: 8px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
  font-size: 12.5px;
}

.cron-status-banner.cron-error {
  color: var(--destructive);
  background: rgba(248, 113, 113, 0.08);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Split Workbench */
.cron-split-workbench {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(360px, 460px) minmax(0, 1fr);
  overflow: hidden;
}

.cron-master-pane {
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: #101317;
}

.cron-master-filters {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.cron-filter-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
  flex: 1;
  min-width: 120px;
}

.cron-filter-field select {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--input);
  background: var(--card);
  color: var(--foreground);
  font-size: 12.5px;
}

.cron-master-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.cron-editor-wrap {
  padding: 14px;
  border-bottom: 1px solid var(--border);
  background: var(--background);
}

.cron-editor-card {
  border: 1px solid var(--primary);
  border-radius: 10px;
  padding: 16px;
  background: var(--card);
  display: grid;
  gap: 12px;
}

.cron-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cron-editor-head h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: var(--primary);
}

.cron-Editor-card input,
.cron-editor-card input,
.cron-editor-card textarea,
.cron-editor-card select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--input);
  border-radius: 6px;
  background: var(--background);
  color: var(--foreground);
  padding: 7px 10px;
  font-size: 13px;
}

.cron-preset-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.cron-preset-chip {
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--secondary);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted-foreground);
  cursor: pointer;
}

.cron-preset-chip:hover {
  color: var(--foreground);
  border-color: var(--primary);
}

.cron-help-note {
  font-size: 11.5px;
  margin: 0;
}

/* Feed rows & cards */
.cron-feed-list {
  display: flex;
  flex-direction: column;
}

.cron-job,
.cron-run {
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  padding: 14px 16px;
  margin: 0;
  transition: background 120ms ease;
}

.cron-job:hover,
.cron-run:hover {
  background: #161b21;
}

.cron-job.is-selected,
.cron-run.is-selected {
  background: var(--card);
  box-shadow: inset 3px 0 0 var(--primary);
}

.cron-job {
  display: flex;
  flex-direction: column;
  gap: 7px;
  cursor: pointer;
}

.cron-job.is-paused {
  opacity: 0.78;
}

.cron-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.cron-job-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--foreground);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cron-unread-pip {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
  flex-shrink: 0;
}

.cron-time-stamp {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.cron-sched-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}

.cron-expr-pill {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--secondary);
  border: 1px solid var(--border);
}

.cron-meta-line {
  font-size: 11.5px;
  line-height: 1.4;
}

.cron-script-box,
.cron-prompt-details pre {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--background);
  border: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cron-prompt-details summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted-foreground);
}

.cron-job-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}

/* Run rows */
.cron-run {
  cursor: pointer;
  padding: 14px 16px;
}

.cron-feed-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cron-feed-snippet {
  font-size: 12.5px;
  color: var(--muted-foreground);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.cron-feed-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.pill {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
  font-family: var(--mono);
  text-transform: uppercase;
  background: var(--secondary);
  color: var(--muted-foreground);
  border: 1px solid var(--border);
}

.pill.ok {
  background: rgba(143, 211, 165, 0.12);
  color: #8fd3a5;
  border-color: rgba(143, 211, 165, 0.28);
}

.pill.error {
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
  border-color: rgba(248, 113, 113, 0.3);
}

.pill.running {
  background: var(--acc-soft);
  color: var(--primary);
  border-color: rgba(169, 184, 255, 0.3);
}

.pill.unread {
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: var(--primary);
}

.cron-tag-mono {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--faint);
}

.cron-inline-body {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border);
  background: var(--background);
  display: grid;
  gap: 12px;
}

.cron-inline-meta {
  font-size: 11.5px;
  font-family: var(--mono);
  display: grid;
  gap: 4px;
}

.cron-empty-msg {
  padding: 20px 16px;
  margin: 0;
  font-size: 13px;
}

.cron-more-wrap {
  padding: 12px 16px;
}

.cron-history {
  border-top: 1px solid var(--border);
}

.cron-history > summary {
  cursor: pointer;
  padding: 12px 16px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted-foreground);
  background: #0e1114;
}

/* Right Detail Inspector */
.cron-inspector-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--background);
  overflow: hidden;
}

.cron-inspector-header {
  padding: 18px 26px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  background: var(--card);
  flex-wrap: wrap;
}

.cron-insp-titles {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.cron-insp-eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted-foreground);
  flex-wrap: wrap;
}

.cron-insp-heading {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin: 0;
}

.cron-insp-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.cron-telemetry-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-bottom: 1px solid var(--border);
  background: #111519;
  flex-shrink: 0;
}

.cron-tel-cell {
  padding: 10px 16px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cron-tel-cell:last-child {
  border-right: none;
}

.cron-tel-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--faint);
}

.cron-tel-val {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cron-inspector-body {
  flex: 1;
  overflow-y: auto;
  padding: 22px 26px 40px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 960px;
}

.cron-prompt-disclosure {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  padding: 10px 14px;
  font-size: 12.5px;
}

.cron-prompt-disclosure summary {
  cursor: pointer;
  color: var(--muted-foreground);
  font-weight: 500;
}

.cron-prompt-disclosure pre {
  margin: 10px 0 0;
  padding: 10px;
  border-radius: 6px;
  background: var(--background);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cron-markdown-surface {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card);
  padding: 20px 24px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.cron-markdown-surface h3 {
  font-size: 14px;
  margin: 0 0 10px;
  color: var(--primary);
}

.cron-inspector-pre {
  margin: 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--background);
  border: 1px solid var(--border);
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cron-inspector-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.cron-empty-box {
  max-width: 360px;
  text-align: center;
  padding: 24px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--card);
}

.cron-empty-box h3 {
  font-size: 15px;
  margin: 0 0 6px;
}

.cron-empty-box p {
  font-size: 12.5px;
  margin: 0;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .cron-split-workbench {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .cron-master-pane {
    flex: none;
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow: visible;
  }
  .cron-master-scroll {
    flex: none;
    overflow-y: visible;
  }
  .cron-inspector-pane {
    flex: none;
    overflow: visible;
  }
  .cron-inspector-body {
    flex: none;
    overflow-y: visible;
    padding: 16px;
  }
  .cron-inspector-header {
    padding: 14px 16px;
  }
  .cron-telemetry-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cron-top-bar {
    padding: 8px 12px;
    gap: 8px;
  }
  .cron-top-left {
    gap: 8px;
  }
  .cron-seg-tab {
    padding: 4px 9px;
    font-size: 12px;
  }
  .cron-btn {
    padding: 0 9px;
    font-size: 12px;
  }
}
</style>
