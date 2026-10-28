<script setup lang="ts">
// One collapsed disclosure for this conversation's live work: tasks, background processes, subagents.
import { computed, onUnmounted, ref, watch } from "vue";
import { Activity, ArrowUpRight, Check, ChevronRight, Circle, CircleAlert, LoaderCircle, Square } from "@lucide/vue";
import ReviewInspector from "./ReviewInspector.vue";
import { json } from "@/lib/api";
import { activityVisible, reviewJobs, chat, childLive, sortChildren, sortProcesses, openSession, stopChild, stopProcess, type ChildRow, type ProcessRow } from "@/stores/chat";

// Docked in the session rail: independently collapsible cards.
const props = defineProps<{ docked?: boolean }>();

const todos = computed(() => (chat.extras?.todos || []).filter((t: any) => t.status !== "deleted"));
const processes = computed(() => chat.extras?.processes || []);
const reviews = reviewJobs;
const liveReviews = computed(() => reviews.value.filter(j => j.status === "running"));
const selectedReview = ref<string | null>(null);
const reviewJob = computed(() => reviews.value.find(j => j.id === selectedReview.value) || null);
const children = computed(() => chat.extras?.children || []);
const doneTasks = computed(() => todos.value.filter((t: any) => t.status === "completed").length);
const activeTask = computed(() => todos.value.find((t: any) => t.status === "in_progress"));
const liveProcesses = computed(() => processes.value.filter(p => p.running));
const liveChildren = computed(() => children.value.filter(childLive));
const sortedProcesses = computed(() => sortProcesses(processes.value));
const sortedChildren = computed(() => sortChildren(children.value));
const live = computed(() => !!activeTask.value || liveProcesses.value.length > 0 || liveChildren.value.length > 0 || (!!props.docked && liveReviews.value.length > 0));
const visible = computed(() => activityVisible.value || (props.docked && reviews.value.length > 0));

const label = computed(() => {
  if (activeTask.value) return activeTask.value.activeForm || activeTask.value.subject;
  if (liveProcesses.value[0]) return liveProcesses.value[0].command.split("\n")[0];
  if (liveChildren.value[0]) return liveChildren.value[0].task.split("\n")[0];
  if (props.docked && liveReviews.value[0]) return "Review agent · " + liveReviews.value[0].prompt;
  if (todos.value.length && doneTasks.value === todos.value.length) return "All tasks complete";
  return "Nothing running";
});
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const open = ref(false);
const collapsed = ref<Record<string, boolean>>({});
const expanded = ref<string | null>(null);
const output = ref<{ id: string; text: string; error?: string } | null>(null);
let outputTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => chat.session, () => { selectedReview.value = null; collapsed.value = {}; open.value = false; expanded.value = null; output.value = null; clearTimeout(outputTimer); });
onUnmounted(() => clearTimeout(outputTimer));

async function loadOutput(id: string) {
  clearTimeout(outputTimer);
  const sid = chat.session, epoch = chat.epoch;
  try {
    const r = await json(`/v1/sessions/${sid}/processes/${encodeURIComponent(id)}`);
    if (epoch !== chat.epoch || expanded.value !== id) return;
    output.value = { id, text: (r.truncated || r.offset > 0 ? "…\n" : "") + (r.output || "") };
    if (r.running) outputTimer = setTimeout(() => loadOutput(id), 2000);
  } catch (e) {
    if (epoch === chat.epoch && expanded.value === id) output.value = { id, text: "", error: (e as Error).message };
  }
}
function toggleOutput(p: ProcessRow) {
  clearTimeout(outputTimer);
  if (expanded.value === p.id) { expanded.value = null; output.value = null; return; }
  expanded.value = p.id; output.value = null; void loadOutput(p.id);
}

const now = ref(Date.now());
const clock = setInterval(() => { if ((open.value || props.docked) && live.value) now.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(clock));
function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}
function processMeta(p: ProcessRow) {
  if (p.running) return `running · ${duration(now.value - p.createdAt)}`;
  const took = p.finishedAt ? ` · ${duration(p.finishedAt - p.createdAt)}` : "";
  return p.status === "complete" ? `done${took}` : p.exitCode !== null ? `${p.status} · exit ${p.exitCode}${took}` : `${p.status}${took}`;
}
const CHILD_LABEL: Record<string, string> = { running: "running", needs_input: "waiting for input", needs_approval: "waiting for approval", finished: "done", ready: "done", failed: "failed", stopped: "stopped", limit_reached: "limit reached", deleted: "deleted" };
const childMeta = (c: ChildRow) => CHILD_LABEL[c.status] || c.status;
const bad = (status: string) => ["failed", "stopped", "interrupted", "limit_reached", "deleted"].includes(status);
</script>

<template>
  <component :is="docked ? 'section' : 'details'" v-if="visible" class="card activity" :class="{ live, docked }" v-bind="docked ? { 'aria-label': 'Session activity' } : { open }" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary v-if="!docked" aria-label="Session activity">
      <Activity :size="15" aria-hidden="true" />
      <span class="activity-counts">
        <span v-if="todos.length">Tasks {{ doneTasks }}/{{ todos.length }}</span>
        <span v-if="processes.length" :class="{ on: liveProcesses.length }">{{ liveProcesses.length ? plural(liveProcesses.length, 'process', 'processes') : plural(processes.length, 'process', 'processes') + ' done' }}</span>
        <span v-if="children.length" :class="{ on: liveChildren.length }">{{ liveChildren.length ? plural(liveChildren.length, 'agent', 'agents') : plural(children.length, 'agent', 'agents') + ' done' }}</span>
      </span>
      <span class="activity-label">{{ label }}</span>
      <ChevronRight :size="14" class="disclosure-chevron" aria-hidden="true" />
    </summary>
    <div class="activity-body">
      <section v-if="todos.length" class="activity-section" aria-label="Tasks">
        <h4>
          <button v-if="docked" type="button" class="activity-section-toggle" :aria-expanded="!collapsed.tasks" @click="collapsed.tasks = !collapsed.tasks">
            <ChevronRight :size="13" :class="{ 'section-open': !collapsed.tasks }" aria-hidden="true" />
            Tasks <span>{{ doneTasks }}/{{ todos.length }}</span>
          </button>
          <template v-else>Tasks <span>{{ doneTasks }}/{{ todos.length }}</span></template>
        </h4>
        <div v-show="!docked || !collapsed.tasks">
          <div v-for="t in todos" :key="t.id" class="todo-item" :class="{ done: t.status === 'completed' }">
            <Check v-if="t.status === 'completed'" :size="14" aria-label="Complete" />
            <LoaderCircle v-else-if="t.status === 'in_progress'" :size="14" class="spin" aria-label="In progress" />
            <Circle v-else :size="14" aria-label="Pending" />
            <div><span dir="auto">{{ t.subject }}</span><small v-if="t.blockedBy?.length">Blocked by {{ t.blockedBy.map((i: number) => '#' + i).join(', ') }}</small></div>
          </div>
        </div>
      </section>

      <section v-if="processes.length" class="activity-section" aria-label="Background processes">
        <h4>
          <button v-if="docked" type="button" class="activity-section-toggle" :aria-expanded="!collapsed.processes" @click="collapsed.processes = !collapsed.processes">
            <ChevronRight :size="13" :class="{ 'section-open': !collapsed.processes }" aria-hidden="true" />
            Processes <span>{{ liveProcesses.length }} running</span>
          </button>
          <template v-else>Processes <span>{{ liveProcesses.length }} running</span></template>
        </h4>
        <div v-show="!docked || !collapsed.processes">
          <div v-for="p in sortedProcesses" :key="p.id" class="activity-row" :data-process="p.id" :data-status="p.status">
            <div class="activity-line">
              <LoaderCircle v-if="p.running" :size="14" class="spin" aria-label="Running" />
              <CircleAlert v-else-if="bad(p.status)" :size="14" class="bad" :aria-label="p.status" />
              <Check v-else :size="14" aria-label="Complete" />
              <button type="button" class="activity-main" :aria-expanded="expanded === p.id" :title="p.command" @click="toggleOutput(p)">
                <code>{{ p.command.split('\n')[0] }}</code>
                <small>{{ processMeta(p) }}</small>
              </button>
              <button v-if="p.running" type="button" class="icon-button" aria-label="Stop process" title="Stop" @click="stopProcess(p.id)"><Square :size="13" /></button>
            </div>
            <div v-if="expanded === p.id" class="activity-output">
              <span v-if="output?.error" class="bad">{{ output.error }}</span>
              <pre v-else-if="output">{{ output.text || '(no output yet)' }}</pre>
              <span v-else class="muted">Loading output…</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="docked && reviews.length" class="activity-section" aria-label="Review agents">
        <h4>Review agents <span>{{ liveReviews.length }} running</span></h4>
        <div v-for="job in reviews" :key="job.id" class="activity-row" :data-review="job.id" :data-status="job.status">
          <div class="activity-line">
            <LoaderCircle v-if="job.status === 'running'" :size="14" class="spin" aria-label="Running" />
            <CircleAlert v-else-if="job.status === 'failed'" :size="14" class="bad" aria-label="Failed" />
            <Check v-else :size="14" aria-label="Complete" />
            <button type="button" class="activity-main" :title="job.prompt" @click="selectedReview = job.id">
              <span dir="auto">{{ job.prompt }}</span>
              <small class="max-w-full truncate">{{ job.status === 'running' ? (job.activity?.at(-1)?.text || 'Starting review…') : job.status === 'complete' ? 'Review complete' : 'Review failed' }}</small>
            </button>
            <button type="button" class="icon-button" aria-label="Inspect review agent" title="Inspect review" @click="selectedReview = job.id"><ArrowUpRight :size="14" /></button>
          </div>
        </div>
      </section>

      <section v-if="children.length" class="activity-section" aria-label="Subagents">
        <h4>
          <button v-if="docked" type="button" class="activity-section-toggle" :aria-expanded="!collapsed.children" @click="collapsed.children = !collapsed.children">
            <ChevronRight :size="13" :class="{ 'section-open': !collapsed.children }" aria-hidden="true" />
            Subagents <span>{{ liveChildren.length }} running</span>
          </button>
          <template v-else>Subagents <span>{{ liveChildren.length }} running</span></template>
        </h4>
        <div v-show="!docked || !collapsed.children">
          <div v-for="c in sortedChildren" :key="c.id" class="activity-row" :data-child="c.id" :data-status="c.status">
            <div class="activity-line">
              <LoaderCircle v-if="childLive(c)" :size="14" class="spin" aria-label="Running" />
              <CircleAlert v-else-if="bad(c.status)" :size="14" class="bad" :aria-label="c.status" />
              <Check v-else :size="14" aria-label="Done" />
              <div class="activity-main static" :title="c.statusReason || c.task">
                <span dir="auto">{{ c.task.split('\n')[0] }}</span>
                <small>#{{ c.id }}<template v-if="c.profile"> · {{ c.profile }}</template> · {{ childMeta(c) }}</small>
                <small v-if="c.resultStatus === 'valid'">Result schema valid · work not verified</small>
                <small v-else-if="c.resultStatus === 'missing' && c.status === 'failed'" class="bad">{{ c.statusReason }}</small>
              </div>
              <button v-if="childLive(c)" type="button" class="icon-button" aria-label="Stop subagent" title="Stop" @click="stopChild(c.id)"><Square :size="13" /></button>
              <button v-if="c.status !== 'deleted'" type="button" class="icon-button" aria-label="Open subagent conversation" title="Open" @click="openSession(c.id)"><ArrowUpRight :size="14" /></button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </component>
  <ReviewInspector :job="reviewJob" @select="selectedReview = $event" @close="selectedReview = null" />
</template>
