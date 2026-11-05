<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RefreshCw, ChevronLeft, AlertCircle, GitCompare, ArrowUp, ArrowDown } from "@lucide/vue";
import { ago } from "@/lib/mention-sources";
import { serverUrl, token } from "@/lib/api";
import { fetchBranches, fetchCompare, fetchRangeDiff, isAbortError, type Branches, type Compare, type SelectorParams, type FileStat } from "./client";
import FileDiffList from "./FileDiffList.vue";

const props = defineProps<{ session?: string; project?: number; wide: boolean }>();
const selector = computed<SelectorParams>(() => ({ session: props.session, project: props.project }));
const branches = ref<Branches | null>(null), loading = ref(false), error = ref<string | null>(null);
const base = ref(""), head = ref("");
const result = ref<Compare | null>(null), comparing = ref(false), compareError = ref<string | null>(null), shownCompare = ref<{ base: string; head: string } | null>(null);
let epoch = 0, compareTicket = 0;
let branchesController: AbortController | null = null;
let compareController: AbortController | null = null;

function cancelBranches() {
  if (branchesController) {
    branchesController.abort();
    branchesController = null;
  }
}

function cancelCompare() {
  if (compareController) {
    compareController.abort();
    compareController = null;
  }
}

onUnmounted(() => {
  epoch++;
  compareTicket++;
  cancelBranches();
  cancelCompare();
});

/** A branch with no commit for this long is marked stale. */
const STALE_DAYS = 90;
const stale = (iso: string) => !!iso && Date.now() - Date.parse(iso) > STALE_DAYS * 86_400_000;
const names = computed(() => branches.value ? [...branches.value.local.map(b => b.name), ...branches.value.remote] : []);

async function load() {
  cancelBranches();
  const mine = ++epoch, owner = { ...selector.value };
  const controller = new AbortController();
  branchesController = controller;
  loading.value = true;
  error.value = null;
  try {
    const b = await fetchBranches(owner, controller.signal);
    if (mine !== epoch) return;
    branches.value = b;
    if (!base.value) base.value = b.default ?? b.local[0]?.name ?? "";
    if (!head.value) head.value = b.current || b.local[0]?.name || "";
  } catch (e) {
    if (mine === epoch && !isAbortError(e)) error.value = (e as Error).message;
  } finally {
    if (mine === epoch) {
      if (branchesController === controller) branchesController = null;
      loading.value = false;
    }
  }
}

async function compare(from = base.value.trim(), to = head.value.trim()) {
  if (!from || !to) return;
  cancelCompare();
  base.value = from;
  head.value = to;
  const mine = ++compareTicket, owner = { ...selector.value };
  const controller = new AbortController();
  compareController = controller;
  shownCompare.value = { base: from, head: to };
  result.value = null;
  compareError.value = null;
  comparing.value = true;
  try {
    const r = await fetchCompare(owner, from, to, controller.signal);
    if (mine === compareTicket) result.value = r;
  } catch (e) {
    if (mine === compareTicket && !isAbortError(e)) compareError.value = (e as Error).message;
  } finally {
    if (mine === compareTicket) {
      if (compareController === controller) compareController = null;
      comparing.value = false;
    }
  }
}

function closeCompare() {
  compareTicket++;
  cancelCompare();
  shownCompare.value = null;
  result.value = null;
  compareError.value = null;
  comparing.value = false;
}

function loadFile(file: FileStat, signal?: AbortSignal) {
  const r = result.value!, owner = { ...selector.value };
  return fetchRangeDiff(owner, r.mergeBase, r.head, file, signal);
}
/** Compare a branch with the default branch, or with its upstream when it is the default. */
function compareBranch(name: string, upstream?: string) {
  const def = branches.value?.default;
  // Without a local default branch, compare with origin's copy.
  if (def && name !== def && name !== `origin/${def}`) return compare(branches.value!.local.some(b => b.name === def) ? def : `origin/${def}`, name);
  if (upstream) return compare(upstream, name);
}

watch(() => [props.session, props.project, serverUrl.value, token.value], () => {
  epoch++;
  cancelBranches();
  branches.value = null;
  base.value = "";
  head.value = "";
  closeCompare();
  void load();
}, { immediate: true });
const when = (iso: string) => iso ? ago(Date.parse(iso)) : "";
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0 bg-background text-foreground overflow-hidden text-xs">
    <form class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border bg-card shrink-0" @submit.prevent="compare()">
      <GitCompare class="w-3.5 h-3.5 text-primary shrink-0" aria-hidden="true" />
      <input v-model="base" list="sc-branch-names" aria-label="Base revision" placeholder="base" class="bg-muted border border-border rounded px-2 py-1 w-36 focus:outline-none focus:border-primary" />
      <span class="text-muted-foreground" aria-hidden="true">…</span>
      <input v-model="head" list="sc-branch-names" aria-label="Compare revision" placeholder="compare" class="bg-muted border border-border rounded px-2 py-1 w-36 focus:outline-none focus:border-primary" />
      <datalist id="sc-branch-names"><option v-for="n in names" :key="n" :value="n" /></datalist>
      <button type="submit" class="px-2.5 py-1 bg-primary text-primary-foreground rounded disabled:opacity-50" :disabled="comparing || !base.trim() || !head.trim()">Compare</button>
      <button type="button" class="ml-auto p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label="Refresh branches" title="Refresh branches" :disabled="loading" @click="load">
        <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
      </button>
    </form>
    <div v-if="error" role="alert" class="px-3 py-2 bg-destructive/10 text-destructive border-b border-border flex items-center gap-2 shrink-0">
      <AlertCircle class="w-4 h-4 shrink-0" aria-hidden="true" /><span class="break-words">{{ error }}</span>
    </div>

    <!-- Comparison -->
    <div v-if="shownCompare" class="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div class="px-3 py-2 border-b border-border space-y-1 shrink-0 max-h-[40%] overflow-auto">
        <div class="flex items-center gap-2">
          <button type="button" class="p-1 -ml-1 hover:bg-accent rounded" aria-label="Back to branches" @click="closeCompare"><ChevronLeft class="w-4 h-4" /></button>
          <span class="font-mono truncate">{{ shownCompare.base }} … {{ shownCompare.head }}</span>
        </div>
        <p v-if="comparing" class="text-muted-foreground">Comparing…</p>
        <p v-else-if="compareError" role="alert" class="text-destructive break-words">{{ compareError }}</p>
        <template v-else-if="result">
          <p class="text-muted-foreground">
            {{ shownCompare.head }} has {{ result.ahead }} commit{{ result.ahead === 1 ? '' : 's' }} not in {{ shownCompare.base }}<template v-if="result.behind">, and is {{ result.behind }} behind it</template>.
            Files show the changes since they split (<span class="font-mono">{{ result.mergeBase.slice(0, 7) }}</span>).
          </p>
          <ul v-if="result.commits.length" class="space-y-0.5">
            <li v-for="c in result.commits" :key="c.oid" class="flex items-center gap-2 min-w-0 vl vl-sm">
              <span class="font-mono text-muted-foreground shrink-0">{{ c.oid.slice(0, 7) }}</span>
              <span class="truncate flex-1">{{ c.subject }}</span>
              <span class="shrink-0 text-muted-foreground">{{ c.author }} · {{ when(c.date) }}</span>
            </li>
            <li v-if="result.commitsTruncated" class="text-muted-foreground">Only the newest {{ result.commits.length }} commits are listed.</li>
          </ul>
        </template>
      </div>
      <div v-if="result" class="flex-1 min-h-0 overflow-hidden">
        <FileDiffList :files="result.files" :truncated="result.filesTruncated" :load="loadFile" :wide="wide" />
      </div>
    </div>

    <!-- Branch list -->
    <div v-else class="flex-1 min-h-0 overflow-auto">
      <p v-if="branches && !branches.local.length && !branches.remote.length" class="p-4 text-muted-foreground">No branches yet.</p>
      <section v-if="branches?.local.length" class="p-2">
        <h2 class="px-2 pb-1 font-medium text-muted-foreground">Local branches ({{ branches.local.length }})</h2>
        <div v-for="b in branches.local" :key="b.name" class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted min-w-0 vl vl-md">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="font-medium truncate">{{ b.name }}</span>
              <span v-if="b.name === branches.current" class="px-1 rounded text-[10px] bg-primary text-primary-foreground shrink-0">current</span>
              <span v-if="b.name === branches.default" class="px-1 rounded text-[10px] bg-muted text-muted-foreground shrink-0">default</span>
              <span v-if="stale(b.date)" class="px-1 rounded text-[10px] bg-amber-500/15 text-amber-400 shrink-0" :title="`No commits for more than ${STALE_DAYS} days`">stale</span>
            </div>
            <div class="flex items-center gap-2 text-muted-foreground min-w-0">
              <span class="truncate">{{ b.subject }}</span>
              <span class="shrink-0" :title="b.date ? new Date(b.date).toLocaleString() : undefined">{{ when(b.date) }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
            <span v-if="!b.upstream" title="No upstream branch">local only</span>
            <template v-else>
              <span v-if="b.ahead" class="flex items-center" :title="`${b.ahead} ahead of ${b.upstream}`"><ArrowUp class="w-3 h-3" />{{ b.ahead }}</span>
              <span v-if="b.behind" class="flex items-center" :title="`${b.behind} behind ${b.upstream}`"><ArrowDown class="w-3 h-3" />{{ b.behind }}</span>
              <span v-if="!b.ahead && !b.behind" :title="`Same as ${b.upstream}`">synced</span>
            </template>
            <button v-if="(branches.default && b.name !== branches.default) || b.upstream" type="button" class="px-2 py-0.5 border border-border rounded hover:bg-accent"
              :title="branches.default && b.name !== branches.default ? `Compare with ${branches.default}` : `Compare with ${b.upstream}`" @click="compareBranch(b.name, b.upstream)">Compare</button>
          </div>
        </div>
      </section>
      <section v-if="branches?.remote.length" class="p-2 border-t border-border">
        <h2 class="px-2 pb-1 font-medium text-muted-foreground">Remote branches without a local branch ({{ branches.remote.length }})</h2>
        <div v-for="r in branches.remote" :key="r" class="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted vl vl-sm">
          <span class="flex-1 truncate font-mono">{{ r }}</span>
          <button v-if="branches.default && r !== `origin/${branches.default}`" type="button" class="px-2 py-0.5 border border-border rounded hover:bg-accent shrink-0" :title="`Compare with ${branches.default}`" @click="compareBranch(r)">Compare</button>
        </div>
      </section>
    </div>
  </div>
</template>
