<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";
import { json, post } from "@/lib/api";
import { ui, navigate, setDrawer } from "@/stores/app";
import { continueCronRun } from "@/stores/chat";
import { refreshCronBadge } from "./cron/badge";
import Markdown from "@/components/chat/Markdown.vue";

const PAGE = 20;
const policies: Record<string, string> = { always: "Every run", changes: "Only when output changes", failures: "Failures only" };

const view = ref<"reports" | "jobs" | "runs">("reports");
const selectedJob = ref<string>("");
const selectedStatus = ref<string>("");

const snapshot = reactive({ jobs: [] as any[], timezone: "" });
const statusText = ref("");
const statusError = ref(false);

const jobListEl = ref<HTMLElement | null>(null);
const runListEl = ref<HTMLElement | null>(null);
const historyListEl = ref<HTMLElement | null>(null);
const historyDetailsEl = ref<HTMLDetailsElement | null>(null);
const editorHostEl = ref<HTMLElement | null>(null);

const latestMore = ref(false);
const historyMore = ref(false);
const historyLoaded = ref(false);
const historyFetching = ref(false);

const latest = ref<any[]>([]);
const historical = ref<any[]>([]);
const jobs = ref<any[]>([]);

let epoch = 0;
let viewVersion = 0;
let historyRequest = 0;
let pending = false;
let loading = false;
let pollTimer: any = null;
let badgeTimer: any = null;

const jobsMap = ref<Map<string, string>>(new Map());

function message(text: string, error = false) {
  statusText.value = text;
  statusError.value = error;
}

function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
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
      latestMore.value = false;
    } else {
      const data = await fetchRange(false, Math.max(PAGE, latest.value.length), e, v);
      if (!valid(e, v) || ticket !== loadSeq) return;
      latest.value = data.items;
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
    await post(job ? `/v1/cron/${job.id}` : "/v1/cron", body, job ? "PATCH" : "POST");
    dismissEditor();
    await load();
    message("Job saved.");
  });
}

function scheduleDesc(job: any) {
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
  <div id="cron-screen">
    <header>
      <button id="cron-menu" type="button" @click="setDrawer(true)" aria-label="Open navigation" aria-controls="side">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-menu"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
      </button>
      <h1>Cron</h1>
      <span class="grow"></span>
      <button type="button" @click="navigate('chat')">Back to chat</button>
    </header>

    <nav class="cron-tabs" aria-label="Cron sections">
      <button
        type="button"
        :aria-pressed="view === 'reports'"
        :aria-selected="view === 'reports'"
        @click="selectView('reports')"
      >
        Reports
      </button>
      <button
        type="button"
        :aria-pressed="view === 'jobs'"
        :aria-selected="view === 'jobs'"
        @click="selectView('jobs')"
      >
        Jobs
      </button>
      <button
        type="button"
        :aria-pressed="view === 'runs'"
        :aria-selected="view === 'runs'"
        @click="selectView('runs')"
      >
        Runs
      </button>
    </nav>

    <p class="muted" role="status" aria-live="polite" :class="{ 'cron-error': statusError }">
      {{ statusText }}
    </p>

    <div class="cron-content">
      <div class="row" v-show="view !== 'jobs'">
        <label>
          Job
          <select aria-label="Job" v-model="selectedJob" @change="resetLists(); load();">
            <option value="">All jobs</option>
            <option v-for="[id, name] in jobsMap" :key="id" :value="id">{{ name }}</option>
          </select>
        </label>
        <label v-show="view === 'runs'">
          Status
          <select aria-label="Status" v-model="selectedStatus" @change="resetLists(); load();">
            <option value="">Active and recent failures</option>
            <option value="running">Running</option>
            <option value="ok">Success</option>
            <option value="error">Failed</option>
          </select>
        </label>
      </div>

      <div class="row" v-show="view === 'jobs'">
        <button type="button" @click="showEditor()">New job</button>
      </div>

      <!-- Editor Host -->
      <div ref="editorHostEl" v-if="editorState.active">
        <form class="card grid" :aria-label="editorState.job ? 'Edit job' : 'New job'" :data-job="editorState.job?.id || 'new'" @submit="saveJob">
          <h2>{{ editorState.job ? 'Edit job' : 'New job' }}</h2>
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
          </label>
          <p class="muted">
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
          <p class="muted">Output changes compares exact text after trimming outer spaces. Every failure creates a report.</p>
          <div class="row">
            <button type="submit">Save job</button>
            <button type="button" @click="dismissEditor()">Cancel</button>
          </div>
        </form>
      </div>

      <!-- Reports / Runs / Jobs Latest List -->
      <div class="grid" data-cron-list="latest" ref="runListEl">
        <template v-if="view === 'jobs'">
          <article class="card grid cron-job" v-for="job in jobs" :key="job.id" :data-job="job.id">
            <div class="row">
              <b class="grow">{{ job.name }}</b>
              <span class="pill">{{ job.enabled ? "Enabled" : "Paused" }}</span>
            </div>
            <div>{{ scheduleDesc(job) }}</div>
            <code class="muted">{{ job.intervalMs ? `Interval: ${job.intervalMs} ms` : job.expr }}</code>
            <span class="muted">Timezone: {{ snapshot.timezone || job.timezone }} (server local time) · Next run: {{ date(job.nextRun) }}</span>
            <span class="muted">Last result: {{ job.lastRun ? job.lastRun.status + " · " + date(job.lastRun.endedAt || job.lastRun.startedAt) : "No runs yet" }}</span>
            <span class="muted">Reporting: {{ policies[job.reportPolicy] }}</span>
            <pre v-if="job.execution">Script: {{ job.execution.command.join(" ") }}\nDirectory: {{ job.execution.cwd || "Server default" }}</pre>
            <details v-else>
              <summary>Prompt</summary>
              <pre>{{ job.prompt }}</pre>
            </details>
            <div class="row">
              <button type="button" @click="showEditor(job)">Edit</button>
              <button type="button" :disabled="job.lastRun?.status === 'running'" @click="runJob(job)">Run now</button>
              <button type="button" @click="toggleJobEnabled(job)">{{ job.enabled ? "Pause" : "Resume" }}</button>
              <button type="button" :disabled="job.lastRun?.status === 'running'" @click="deleteJob(job)">Delete</button>
              <button type="button" @click="showJobReports(job)">Reports</button>
              <button type="button" @click="showJobRuns(job)">Runs</button>
            </div>
          </article>
          <p class="muted" v-if="!jobs.length">No matching records.</p>
        </template>
        <template v-else>
          <details
            v-for="run in latest"
            :key="run.id"
            class="card cron-run"
            :class="{ 'cron-unread': (view === 'reports' && run.readAt === null) }"
            :data-run="run.id"
            @toggle="async (e: Event) => {
              const el = e.target as HTMLDetailsElement;
              if (el.open && view === 'reports' && run.readAt === null) {
                await toggleRead(run);
              }
            }"
          >
            <summary>
              <span class="row">
                <span class="pill" :class="run.status">
                  {{ run.status === 'ok' ? 'Success' : run.status === 'error' ? 'Failed' : 'Running' }}
                </span>
                <b class="grow">{{ run.jobName }}</b>
                <span class="muted">{{ date(run.endedAt || run.startedAt) }}</span>
                <span class="pill" v-if="view === 'reports' && run.readAt === null">Unread</span>
              </span>
            </summary>
            <Markdown :content="[run.output, run.error ? 'Error: ' + run.error : null].filter(Boolean).join('\n\n') || 'No output.'" />
            <div class="grid muted">
              <span>Run #{{ run.id }} · Started: {{ date(run.startedAt) }} · Finished: {{ date(run.endedAt) }}</span>
              <span>Duration: {{ run.endedAt ? Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1) + ' seconds' : 'Running' }} · Slot: {{ date(run.slot) }}</span>
              <span>Conversation: {{ run.conversationId || 'None (script or interrupted run)' }} · Submission: {{ run.submissionId || 'None' }}</span>
            </div>
            <div class="row">
              <button type="button" v-if="view === 'reports'" @click="toggleRead(run)">
                {{ run.readAt === null ? 'Mark read' : 'Mark unread' }}
              </button>
              <button type="button" v-if="run.status !== 'running'" @click="handleContinueCronRun(run)">Continue in chat</button>
            </div>
          </details>
          <p class="muted" v-if="!latest.length">No matching records.</p>
        </template>
      </div>

      <button type="button" v-show="view !== 'jobs' && latestMore" @click="loadMore(false)">Load more</button>

      <!-- History details -->
      <details class="cron-history" v-show="view !== 'jobs'" ref="historyDetailsEl" @toggle="onHistoryToggle">
        <summary>Show history</summary>
        <div class="grid" data-cron-list="history">
          <details
            v-for="run in historical"
            :key="run.id"
            class="card cron-run"
            :class="{ 'cron-unread': (view === 'reports' && run.readAt === null) }"
            :data-run="run.id"
          >
            <summary>
              <span class="row">
                <span class="pill" :class="run.status">
                  {{ run.status === 'ok' ? 'Success' : run.status === 'error' ? 'Failed' : 'Running' }}
                </span>
                <b class="grow">{{ run.jobName }}</b>
                <span class="muted">{{ date(run.endedAt || run.startedAt) }}</span>
                <span class="pill" v-if="view === 'reports' && run.readAt === null">Unread</span>
              </span>
            </summary>
            <Markdown :content="[run.output, run.error ? 'Error: ' + run.error : null].filter(Boolean).join('\n\n') || 'No output.'" />
            <div class="grid muted">
              <span>Run #{{ run.id }} · Started: {{ date(run.startedAt) }} · Finished: {{ date(run.endedAt) }}</span>
              <span>Duration: {{ run.endedAt ? Math.max(0, (run.endedAt - run.startedAt) / 1000).toFixed(1) + ' seconds' : 'Running' }} · Slot: {{ date(run.slot) }}</span>
              <span>Conversation: {{ run.conversationId || 'None (script or interrupted run)' }} · Submission: {{ run.submissionId || 'None' }}</span>
            </div>
            <div class="row">
              <button type="button" v-if="view === 'reports'" @click="toggleRead(run)">
                {{ run.readAt === null ? 'Mark read' : 'Mark unread' }}
              </button>
              <button type="button" v-if="run.status !== 'running'" @click="handleContinueCronRun(run)">Continue in chat</button>
            </div>
          </details>
          <p class="muted" v-if="!historical.length && !historyFetching">No history records.</p>
          <p class="muted" v-if="historyFetching">Loading history…</p>
        </div>
        <button type="button" v-show="historyMore" @click="loadMore(true)">Load more history</button>
      </details>
    </div>
  </div>
</template>
