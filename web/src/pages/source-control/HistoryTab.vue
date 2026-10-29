<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RefreshCw, ChevronLeft, AlertCircle } from "@lucide/vue";
import { ago } from "@/lib/mention-sources";
import { fetchLog, fetchCommit, fetchRangeDiff, type LogCommit, type CommitDetail, type SelectorParams, type FileStat } from "./client";
import { layoutGraph, laneColor } from "./graph";
import FileDiffList from "./FileDiffList.vue";
import RefChips from "./RefChips.vue";

/** wide: commit list beside the detail. filesWide: file list beside the diff inside the detail. */
const props = defineProps<{ session?: string; project?: number; wide: boolean; filesWide: boolean }>();
const selector = computed<SelectorParams>(() => ({ session: props.session, project: props.project }));
const SCOPE_KEY = "luna.git.historyScope";
const scope = ref<"head" | "all">(localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "head");
const commits = ref<LogCommit[]>([]), more = ref(false), loading = ref(false), error = ref<string | null>(null);
const selected = ref<string | null>(null), detail = ref<CommitDetail | null>(null), loadingDetail = ref(false), detailError = ref<string | null>(null);
let epoch = 0, detailTicket = 0;
onUnmounted(() => { epoch++; detailTicket++; });

const graph = computed(() => layoutGraph(commits.value));
/** Lanes drawn; more lanes than this are clipped so the subject stays readable. */
const MAX_LANES = 12, LANE = 12, ROW = 28;
const graphWidth = computed(() => Math.min(MAX_LANES, Math.max(1, ...graph.value.map(r => r.width))) * LANE + 4);
const x = (lane: number) => 8 + lane * LANE;
function edge(from: number, to: number, y1: number, y2: number) {
  const a = x(from), b = x(to);
  return a === b ? `M${a} ${y1}V${y2}` : `M${a} ${y1}C${a} ${(y1 + y2) / 2} ${b} ${(y1 + y2) / 2} ${b} ${y2}`;
}

async function load(reset: boolean) {
  const mine = reset ? ++epoch : epoch, owner = { ...selector.value }, skip = reset ? 0 : commits.value.length;
  loading.value = true; error.value = null;
  try {
    const page = await fetchLog(owner, scope.value, skip);
    if (mine !== epoch) return;
    commits.value = reset ? page.commits : [...commits.value, ...page.commits];
    more.value = page.more;
  } catch (e) { if (mine === epoch) error.value = (e as Error).message; }
  finally { if (mine === epoch) loading.value = false; }
}

async function select(oid: string) {
  const mine = ++detailTicket, owner = { ...selector.value };
  selected.value = oid; detail.value = null; detailError.value = null; loadingDetail.value = true;
  try { const d = await fetchCommit(owner, oid); if (mine === detailTicket) detail.value = d; }
  catch (e) { if (mine === detailTicket) detailError.value = (e as Error).message; }
  finally { if (mine === detailTicket) loadingDetail.value = false; }
}
function closeDetail() { detailTicket++; selected.value = null; detail.value = null; detailError.value = null; loadingDetail.value = false; }
function loadFile(file: FileStat) {
  const d = detail.value!, owner = { ...selector.value };
  return fetchRangeDiff(owner, d.base, d.oid, file);
}

watch(scope, value => { localStorage.setItem(SCOPE_KEY, value); void load(true); });
watch(() => [props.session, props.project], () => { commits.value = []; more.value = false; closeDetail(); void load(true); }, { immediate: true });

const when = (iso: string) => ago(Date.parse(iso));
const subject = (message: string) => message.split("\n")[0] ?? "";
const body = (message: string) => message.split("\n").slice(1).join("\n").trim();
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0 bg-background text-foreground overflow-hidden">
    <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-card text-xs shrink-0">
      <label class="flex items-center gap-1.5 text-muted-foreground">Show
        <select v-model="scope" aria-label="History scope" class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground">
          <option value="head">Current branch</option>
          <option value="all">All branches</option>
        </select>
      </label>
      <span class="text-muted-foreground">{{ commits.length }}{{ more ? '+' : '' }} commits</span>
      <button type="button" class="ml-auto p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label="Refresh history" title="Refresh history" :disabled="loading" @click="load(true)">
        <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
      </button>
    </div>
    <div v-if="error" role="alert" class="px-3 py-2 bg-destructive/10 text-destructive text-xs border-b border-border flex items-center gap-2 shrink-0">
      <AlertCircle class="w-4 h-4 shrink-0" aria-hidden="true" /><span class="break-words">{{ error }}</span>
    </div>

    <div class="flex-1 min-h-0 flex overflow-hidden" :class="wide ? 'flex-row' : 'flex-col'">
      <!-- Commit list with graph -->
      <div class="min-h-0 overflow-auto bg-card text-xs" :class="[wide ? 'w-[460px] shrink-0 border-r border-border' : 'flex-1', !wide && selected ? 'hidden' : 'block']">
        <p v-if="!loading && !commits.length && !error" class="p-4 text-muted-foreground">No commits yet.</p>
        <button v-for="(commit, i) in commits" :key="commit.oid" type="button"
          class="flex items-center w-full text-left hover:bg-muted pr-2" :style="{ height: ROW + 'px' }"
          :class="selected === commit.oid ? 'bg-accent' : ''" :aria-label="`Commit ${commit.oid.slice(0, 7)}: ${commit.subject}`"
          @click="select(commit.oid)">
          <svg :width="graphWidth" :height="ROW" class="shrink-0" aria-hidden="true">
            <path v-for="([a, b], k) in graph[i]!.through" :key="'t' + k" :d="edge(a, b, 0, ROW)" :stroke="laneColor(a)" stroke-width="1.5" fill="none" />
            <path v-for="([a, b], k) in graph[i]!.top" :key="'u' + k" :d="edge(a, b, 0, ROW / 2)" :stroke="laneColor(a)" stroke-width="1.5" fill="none" />
            <path v-for="([a, b], k) in graph[i]!.bottom" :key="'d' + k" :d="edge(a, b, ROW / 2, ROW)" :stroke="laneColor(b)" stroke-width="1.5" fill="none" />
            <circle :cx="x(graph[i]!.column)" :cy="ROW / 2" r="3.5" :fill="commit.parents.length > 1 ? 'var(--color-card, #121212)' : laneColor(graph[i]!.column)" :stroke="laneColor(graph[i]!.column)" stroke-width="1.5" />
          </svg>
          <span class="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
            <RefChips :refs="commit.refs" :limit="2" />
            <span class="truncate">{{ commit.subject }}</span>
          </span>
          <span class="shrink-0 pl-2 text-muted-foreground hidden sm:inline">{{ commit.author }}</span>
          <span class="shrink-0 w-8 text-right text-muted-foreground" :title="new Date(commit.date).toLocaleString()">{{ when(commit.date) }}</span>
        </button>
        <button v-if="more" type="button" class="m-2 px-2 py-1 underline text-muted-foreground disabled:opacity-50" :disabled="loading" @click="load(false)">{{ loading ? 'Loading…' : 'Load more commits' }}</button>
      </div>

      <!-- Commit detail -->
      <div class="flex-1 min-h-0 min-w-0 flex-col" :class="!wide && !selected ? 'hidden' : 'flex'">
        <div v-if="!selected" class="flex-1 flex items-center justify-center text-xs text-muted-foreground">Select a commit to view its changes</div>
        <template v-else>
          <div class="px-3 py-2 border-b border-border bg-card text-xs space-y-1 shrink-0 max-h-[40%] overflow-auto">
            <div class="flex items-start gap-2">
              <button v-if="!wide" type="button" class="p-1 -ml-1 hover:bg-accent rounded" aria-label="Back to history" @click="closeDetail"><ChevronLeft class="w-4 h-4" /></button>
              <p v-if="loadingDetail" class="text-muted-foreground py-1">Loading commit…</p>
              <p v-else-if="detailError" role="alert" class="text-destructive py-1">{{ detailError }}</p>
              <div v-else-if="detail" class="min-w-0 flex-1 space-y-1">
                <p class="font-medium text-sm break-words">{{ subject(detail.message) }}</p>
                <pre v-if="body(detail.message)" class="whitespace-pre-wrap break-words font-sans text-muted-foreground">{{ body(detail.message) }}</pre>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span :title="detail.email">{{ detail.author }}</span>
                  <span :title="detail.date">{{ new Date(detail.date).toLocaleString() }}</span>
                  <span v-if="detail.committer !== detail.author">committed by {{ detail.committer }}</span>
                  <span class="font-mono select-all" :title="detail.oid">{{ detail.oid.slice(0, 10) }}</span>
                  <span v-if="detail.parents.length" class="flex items-center gap-1">{{ detail.parents.length > 1 ? 'parents' : 'parent' }}
                    <button v-for="p in detail.parents" :key="p" type="button" class="font-mono underline hover:text-foreground" :title="`Open ${p}`" @click="select(p)">{{ p.slice(0, 7) }}</button>
                  </span>
                  <span v-else>root commit</span>
                  <RefChips :refs="detail.refs" />
                </div>
                <p v-if="detail.parents.length > 1" class="text-muted-foreground">Merge commit: changes are shown against the first parent.</p>
              </div>
            </div>
          </div>
          <div v-if="detail" class="flex-1 min-h-0 overflow-hidden">
            <FileDiffList :files="detail.files" :truncated="detail.filesTruncated" :load="loadFile" :wide="filesWide" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
