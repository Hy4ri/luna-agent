<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { backToChat, setDrawer } from "@/stores/app";
import { chat } from "@/stores/chat";
import { serverUrl, token, json } from "@/lib/api";
import { fetchGhStatus, fetchRepos, fetchItems, fetchItemDetail, fetchRepoInfo, dropRepo } from "./github/client";
import { get as cached, makeKey, forget } from "./github/cache";
import ChangesTab from "./source-control/ChangesTab.vue";
import ItemList from "./github/ItemList.vue";
import ItemDetail from "./github/ItemDetail.vue";
import type { GhStatus, ListItem, Detail, Kind, RepoInfo, ItemPage } from "../../../src/github";
import { GitPullRequest, Search, RefreshCw, ArrowLeft, Menu } from "@lucide/vue";

const section = ref<'changes' | 'pr' | 'issue'>('changes');
const sourceProjects = ref<{id:number;name:string;cwd:string;general?:boolean}[]>([]);
const sourceProject = ref<number | null>(chat.project);
const selector = computed(() => chat.session ? { session: String(chat.session) } : sourceProject.value !== null ? { project: sourceProject.value } : null);
const status = ref<GhStatus | null>(null);
const repos = ref<{ repo: string; projects: { id: number; name: string }[] }[]>([]);
const selectedRepo = ref("");
const customRepoInput = ref("");
const showCustomRepo = ref(false);
const repoInputError = ref("");
const kind = ref<Kind>("pr");
const stateFilter = ref<"open" | "closed" | "all">("open");
const searchQuery = ref("");
const appliedSearch = ref("");
const items = ref<ListItem[]>([]);
const totalCount = ref(0);
const nextCursor = ref<string | null>(null);
const loadingItems = ref(false);
const refreshingItems = ref(false);
const loadingMore = ref(false);
const listError = ref<string | null>(null);
const selectedItemNumber = ref<number | null>(null);
const detail = ref<Detail | null>(null);
const repoInfo = ref<RepoInfo | null>(null);
const loadingDetail = ref(false);
const detailError = ref<string | null>(null);
const lastUpdated = ref("");
const isWide = ref(window.innerWidth >= 900);
const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
let lastWorkspaceRepo: string | null = null;
let disposed = false, loadGeneration = 0, detailGeneration = 0, initGeneration = 0, infoGeneration = 0;
let displayedListKey = "";
let prefetchController: AbortController | null = null;
let prefetchedItem = "", prefetchedKey = "";
const context = () => JSON.stringify([serverUrl.value, token.value]);
const handleResize = () => { isWide.value = window.innerWidth >= 900; };
function cancelPrefetch() {
  if (prefetchController) {
    // Remove this pending entry before aborting, so a fast reselect cannot join it.
    forget(prefetchedKey); prefetchController.abort();
  }
  prefetchController = null; prefetchedItem = ''; prefetchedKey = '';
}
function storageKey() { return `luna.github.repo.${serverUrl.value || "default"}`; }
function itemKey(repo: string, number: number) {
  const [owner, name] = repo.toLowerCase().split("/");
  return makeKey("item-detail", { owner, name, number });
}
function listKey(repo: string, type: Kind, state: string, q: string) {
  const [owner, name] = repo.toLowerCase().split("/");
  return makeKey("items", { owner, name, kind: type, state, q, after: "" });
}
function followRepo(repo: string | null) {
  if (repo === lastWorkspaceRepo) return;
  lastWorkspaceRepo = repo;
  if (repo) selectedRepo.value = repo;
}
function setSection(value: 'changes' | 'pr' | 'issue') {
  if (value === section.value) return;
  section.value = value;
  if (value !== 'changes') {
    if (kind.value === value) void loadList();
    else kind.value = value;
  }
}
async function loadSourceProjects() {
  const scope = context();
  try {
    const result = await json<{projects: typeof sourceProjects.value}>('/v1/projects');
    if (disposed || scope !== context()) return;
    sourceProjects.value = result.projects.filter(p => !p.general && p.cwd);
    if (!sourceProjects.value.some(p => p.id === sourceProject.value)) sourceProject.value = sourceProjects.value[0]?.id ?? null;
  } catch (e) { if (!disposed && scope === context()) listError.value = (e as Error).message; }
}
async function init() {
  const gen = ++initGeneration, scope = context();
  const current = () => !disposed && gen === initGeneration && scope === context();
  if (!selectedRepo.value) {
    try {
      const saved = localStorage.getItem(storageKey());
      if (saved && REPO_REGEX.test(saved)) selectedRepo.value = saved;
    } catch {}
  }
  // Status and discovery must not block a known repository's list watcher.
  await Promise.all([
    fetchGhStatus().then(value => { if (current()) status.value = value; }).catch(e => {
      if (current()) status.value = { state: 'error', message: e.message };
    }),
    fetchRepos().then(result => {
      if (!current()) return;
      repos.value = result.repos;
      showCustomRepo.value = !result.repos.length && !selectedRepo.value;
      if (!selectedRepo.value) {
        const matched = result.repos.find(r => r.projects.some(p => p.id === chat.project));
        selectedRepo.value = matched?.repo ?? result.repos[0]?.repo ?? "";
      }
    }).catch(e => { if (current()) listError.value = e.message; }),
  ]);
}
async function loadInfo(fresh = false) {
  const repo = selectedRepo.value, scope = context(), gen = ++infoGeneration;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return;
  const key = makeKey('repo-info', { owner: owner.toLowerCase(), name: name.toLowerCase() });
  repoInfo.value = cached<RepoInfo>(key)?.data ?? null;
  try {
    const value = await fetchRepoInfo(owner, name, fresh);
    if (!disposed && gen === infoGeneration && repo === selectedRepo.value && scope === context()) repoInfo.value = value;
  } catch (e) {
    if (!disposed && gen === infoGeneration && repo === selectedRepo.value && scope === context()) listError.value = (e as Error).message;
  }
}
async function loadList(loadMore = false, fresh = false) {
  const repo = selectedRepo.value, type = kind.value, state = stateFilter.value, q = appliedSearch.value, scope = context();
  const [owner, name] = repo.split('/');
  if (!owner || !name || (loadMore && (loadingMore.value || !nextCursor.value))) return;
  const gen = ++loadGeneration;
  const current = () => !disposed && gen === loadGeneration && repo === selectedRepo.value && scope === context();
  const key = listKey(repo, type, state, q), cursor = loadMore ? nextCursor.value : null;
  listError.value = null;
  if (loadMore) loadingMore.value = true;
  else {
    const previous = cached<ItemPage>(key);
    if (previous) {
      items.value = previous.data.items; totalCount.value = previous.data.total; nextCursor.value = previous.data.next;
      lastUpdated.value = new Date(previous.fetchedAt).toLocaleTimeString();
    } else if (displayedListKey !== key) {
      items.value = []; totalCount.value = 0; nextCursor.value = null; lastUpdated.value = '';
    }
    displayedListKey = key;
    loadingItems.value = !previous && !items.value.length;
    loadingMore.value = false;
    refreshingItems.value = true;
  }
  try {
    const page = await fetchItems(owner, name, type, state, q, cursor, fresh);
    if (!current()) return;
    items.value = loadMore ? [...items.value, ...page.items.filter(row => !items.value.some(old => old.number === row.number))] : page.items;
    totalCount.value = page.total; nextCursor.value = page.next;
    lastUpdated.value = new Date().toLocaleTimeString();
    if (!loadMore && !q) {
      const other: Kind = type === 'pr' ? 'issue' : 'pr';
      if (!cached<ItemPage>(listKey(repo, other, state, q))) void fetchItems(owner, name, other, state, q).catch(() => {});
    }
  } catch (e) { if (current()) listError.value = (e as Error).message; }
  finally { if (current()) { loadingItems.value = false; loadingMore.value = false; refreshingItems.value = false; } }
}
async function loadDetail(number: number, fresh = false) {
  const repo = selectedRepo.value, scope = context(), gen = ++detailGeneration;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return;
  const current = () => !disposed && gen === detailGeneration && repo === selectedRepo.value && scope === context() && selectedItemNumber.value === number;
  detailError.value = null;
  const previous = cached<Detail>(itemKey(repo, number));
  if (previous) detail.value = previous.data;
  else if (detail.value?.number !== number) detail.value = null;
  loadingDetail.value = !detail.value;
  try {
    const value = await fetchItemDetail(owner, name, number, fresh);
    if (current()) detail.value = value;
  } catch (e) { if (current()) detailError.value = (e as Error).message; }
  finally { if (current()) loadingDetail.value = false; }
}
function prefetchItem(item: ListItem) {
  const repo = selectedRepo.value;
  if (selectedItemNumber.value === item.number || cached<Detail>(itemKey(repo, item.number))) return;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return;
  cancelPrefetch();
  const controller = new AbortController(); prefetchController = controller; prefetchedItem = `${repo}#${item.number}`; prefetchedKey = itemKey(repo, item.number);
  void fetchItemDetail(owner, name, item.number, false, controller.signal).catch(() => {}).finally(() => {
    if (prefetchController === controller) prefetchController = null;
  });
}
function handleSearchSubmit() { appliedSearch.value = searchQuery.value.trim(); void loadList(); }
function selectItem(item: ListItem) {
  // Promote this request: later hover changes must not cancel the selected detail.
  if (prefetchedItem === `${selectedRepo.value}#${item.number}`) { prefetchController = null; prefetchedItem = ''; prefetchedKey = ''; }
  else cancelPrefetch();
  selectedItemNumber.value = item.number; void loadDetail(item.number);
}
function backToList() { detailGeneration++; selectedItemNumber.value = null; detail.value = null; loadingDetail.value = false; detailError.value = null; }
function handleRepoChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  if (val === '__custom__') { showCustomRepo.value = true; repoInputError.value = ''; }
  else { showCustomRepo.value = false; selectedRepo.value = val; }
}
function confirmCustomRepo() {
  const trimmed = customRepoInput.value.trim();
  if (!REPO_REGEX.test(trimmed)) { repoInputError.value = 'Enter valid owner/repo'; return; }
  repoInputError.value = ''; showCustomRepo.value = false; selectedRepo.value = trimmed;
}
async function refreshAfterAction(updated?: Detail) {
  const repo = selectedRepo.value, scope = context(), number = selectedItemNumber.value;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return;
  loadGeneration++; detailGeneration++; infoGeneration++; cancelPrefetch();
  dropRepo(owner, name);
  if (updated) detail.value = updated;
  await Promise.all([loadList(false, true), loadInfo(true), !updated && number !== null ? loadDetail(number, true) : Promise.resolve()]);
  if (disposed || repo !== selectedRepo.value || scope !== context() || !detail.value || selectedItemNumber.value !== number) return;
  // Search indexing may lag. Never change the cached response object in place.
  const current = detail.value;
  items.value = items.value.map(row => row.number === current.number ? { ...row, state: current.state } : row);
  if (stateFilter.value !== 'all') items.value = items.value.filter(row => stateFilter.value === 'open' ? row.state === 'OPEN' : row.state !== 'OPEN');
}
async function handleDeleted() { backToList(); await refreshAfterAction(); }
function refresh() {
  cancelPrefetch();
  void loadInfo(true); void loadList(false, true);
  if (selectedItemNumber.value !== null) void loadDetail(selectedItemNumber.value, true);
  const scope = context();
  void fetchGhStatus(true).then(value => { if (!disposed && scope === context()) status.value = value; }).catch(() => {});
}
watch(selectedRepo, val => {
  cancelPrefetch(); loadGeneration++; infoGeneration++; backToList();
  if (val && REPO_REGEX.test(val)) {
    try { localStorage.setItem(storageKey(), val); } catch {}
    void loadInfo(); void loadList();
  }
}, { flush: 'sync' });
watch([kind, stateFilter], () => { cancelPrefetch(); backToList(); void loadList(); });
watch([serverUrl, token], () => {
  loadGeneration++; detailGeneration++; initGeneration++; infoGeneration++; cancelPrefetch();
  lastWorkspaceRepo = null; selectedRepo.value = ''; detail.value = null; items.value = []; repoInfo.value = null;
  totalCount.value = 0; nextCursor.value = null; displayedListKey = ''; lastUpdated.value = ''; listError.value = null; detailError.value = null;
  status.value = null; repos.value = []; sourceProjects.value = [];
  loadingItems.value = loadingMore.value = refreshingItems.value = loadingDetail.value = false;
  void init(); void loadSourceProjects();
}, { flush: 'sync' });
onMounted(() => { window.addEventListener('resize', handleResize); void loadSourceProjects(); void init(); });
onUnmounted(() => {
  disposed = true; loadGeneration++; detailGeneration++; initGeneration++; infoGeneration++; cancelPrefetch();
  window.removeEventListener('resize', handleResize);
});
</script>

<template>
  <div class="flex flex-col h-full bg-background text-foreground overflow-hidden min-w-0 min-h-0 flex-1">
    <!-- Header -->
    <header class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 min-h-14 border-b border-border bg-card shrink-0">
      <div class="flex items-center gap-3 min-w-0">
        <button
          type="button"
          id="source-control-menu"
          @click="setDrawer(true)"
          class="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
          title="Open menu"
        >
          <Menu class="w-5 h-5" />
        </button>
        <div class="flex items-center gap-2">
          <GitPullRequest class="w-5 h-5 text-primary" />
          <h1 tabindex="-1" class="font-semibold text-base">Source Control</h1>
        </div>
      </div>

      <div v-if="section !== 'changes' && status?.state === 'ok'" class="flex flex-wrap items-center gap-2 min-w-0">
        <!-- Repo Selector -->
        <select
          :value="showCustomRepo ? '__custom__' : selectedRepo"
          @change="handleRepoChange"
          class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
        >
          <option v-if="selectedRepo && !repos.some(r => r.repo === selectedRepo)" :value="selectedRepo">{{ selectedRepo }}</option>
          <option v-for="r in repos" :key="r.repo" :value="r.repo">{{ r.repo }}</option>
          <option value="__custom__">Other repository…</option>
        </select>

        <div v-if="showCustomRepo" class="flex items-center gap-1">
          <input
            v-model="customRepoInput"
            type="text"
            placeholder="owner/repo"
            class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground w-32 focus:outline-none focus:border-primary"
            @keydown.enter="confirmCustomRepo"
          />
          <button
            type="button"
            @click="confirmCustomRepo"
            class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded"
          >
            Go
          </button>
        </div>
        <span v-if="repoInputError" class="text-xs text-destructive">{{ repoInputError }}</span>

        <button
          type="button"
          @click="refresh"
          class="p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': refreshingItems }" />
        </button>

        <button
          type="button"
          @click="backToChat"
          class="px-3 py-1.5 text-xs bg-card hover:bg-accent rounded border border-border"
        >
          Close
        </button>
      </div>
    </header>

    <div role="tablist" aria-label="Source Control sections" class="flex shrink-0 gap-1 px-3 py-2 border-b border-border">
      <button v-for="tab in ([{id:'changes',label:'Changes'},{id:'pr',label:'Pull requests'},{id:'issue',label:'Issues'}] as const)" :key="tab.id" type="button" role="tab" :aria-selected="section === tab.id" class="px-3 py-1.5 rounded text-xs" :class="section === tab.id ? 'bg-secondary text-foreground' : 'text-muted-foreground'" @click="setSection(tab.id)">{{ tab.label }}</button>
      <button v-if="section === 'changes'" type="button" class="ml-auto text-xs px-2" @click="backToChat">Close</button>
    </div>
    <template v-if="section === 'changes'">
      <div v-if="!chat.session" class="px-3 py-2 border-b border-border text-xs">
        <label>Project <select v-model="sourceProject" aria-label="Source Control project" class="bg-secondary border border-border rounded px-2 py-1"><option v-for="project in sourceProjects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
      </div>
      <p v-if="chat.runActive" class="px-3 py-1 text-xs text-muted-foreground">The session is running. Files can change while you work.</p>
      <ChangesTab v-if="selector" v-bind="selector" :run-active="chat.runActive" @repo="followRepo" />
      <p v-else class="p-5 text-sm text-muted-foreground">Select a project with a directory on this host to use source control.</p>
    </template>
    <!-- Main Content Area -->
    <div v-else class="flex-1 min-h-0 overflow-hidden min-w-0">
      <!-- Status Checks -->
      <div v-if="!status" class="flex items-center justify-center h-full text-muted-foreground text-sm">
        Checking GitHub status…
      </div>
      <div v-else-if="status.state !== 'ok'" class="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
        <div class="text-destructive font-medium">GitHub CLI is not available or logged out.</div>
        <div class="text-sm text-muted-foreground max-w-md">{{ status.message }}</div>
        <div class="text-xs text-muted-foreground">Run `gh auth login` on the host daemon environment.</div>
      </div>

      <!-- Main Layout -->
      <div v-else class="flex h-full min-w-0 min-h-0">
        <!-- List Pane (Visible if wide OR no item selected on narrow) -->
        <div
          class="flex flex-col border-r border-border bg-card shrink-0 h-full min-w-0"
          :class="[isWide ? 'w-[400px]' : 'w-full', !isWide && selectedItemNumber !== null ? 'hidden' : 'flex']"
        >
          <!-- Controls Bar -->
          <div class="p-3 border-b border-border space-y-2 shrink-0">
            <!-- Search & State Filter -->
            <div class="flex gap-2">
              <div class="relative flex-1">
                <Search class="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  v-model="searchQuery"
                  type="text"
                  placeholder="Search (Enter)"
                  @keydown.enter="handleSearchSubmit"
                  class="w-full bg-muted border border-border rounded pl-8 pr-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                />
              </div>
              <select
                v-model="stateFilter"
                class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </select>
            </div>
          </div>

          <!-- List Error -->
          <div v-if="listError" class="p-3 bg-destructive/10 text-destructive text-xs border-b border-border">
            {{ listError }}
          </div>

          <!-- List -->
          <div class="flex-1 min-h-0 min-w-0">
            <ItemList
              :items="items"
              :selected-number="selectedItemNumber"
              :loading="loadingItems"
              :has-next="nextCursor !== null"
              :loading-more="loadingMore"
              @select="selectItem"
              @prefetch="prefetchItem"
              @load-more="loadList(true)"
            />
          </div>

          <!-- Footer status -->
          <div class="px-3 py-2 border-t border-border text-[11px] text-muted-foreground flex justify-between shrink-0">
            <span>{{ totalCount }} items</span>
            <span v-if="lastUpdated">Updated {{ lastUpdated }}</span>
          </div>
        </div>

        <!-- Detail Pane (Visible if wide OR item selected on narrow) -->
        <div
          class="flex-1 min-h-0 min-w-0 flex flex-col h-full bg-background"
          :class="[!isWide && selectedItemNumber === null ? 'hidden' : 'flex']"
        >
          <!-- Narrow Back bar -->
          <div v-if="!isWide && selectedItemNumber !== null" class="flex items-center px-4 h-12 border-b border-border bg-card shrink-0">
            <button
              type="button"
              @click="backToList"
              class="flex items-center gap-2 text-xs font-medium text-primary hover:underline"
            >
              <ArrowLeft class="w-4 h-4" />
              <span>Back to list</span>
            </button>
          </div>

          <ItemDetail
            :key="`${selectedRepo}:${selectedItemNumber}`"
            :repo="selectedRepo"
            :info="repoInfo"
            :detail="detail"
            @changed="refreshAfterAction"
            @deleted="handleDeleted"
            :loading="loadingDetail"
            :error="detailError"
          />
        </div>
      </div>
    </div>
  </div>
</template>
