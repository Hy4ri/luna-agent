<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted, onUnmounted, watch } from "vue";
import { backToChat, setDrawer } from "@/stores/app";
import { chat } from "@/stores/chat";
import { serverUrl, token } from "@/lib/api";
import { history, loadProjects } from "@/stores/sessions";
import { workers, loadWorkers } from "@/stores/workers";
import { handleTablistKeydown } from "@/lib/keyboard";
import { type ItemFilters, fetchGhStatus, fetchRepos, fetchItems, fetchItemDetail, fetchRepoInfo, dropRepo } from "./github/client";
import { get as cached, makeKey } from "./github/cache";
const ChangesTab = defineAsyncComponent(() => import("./source-control/ChangesTab.vue"));
const HistoryTab = defineAsyncComponent(() => import("./source-control/HistoryTab.vue"));
const BranchesTab = defineAsyncComponent(() => import("./source-control/BranchesTab.vue"));
import ItemList from "./github/ItemList.vue";
import NewItemDialog from "./github/NewItemDialog.vue";
import ContextBar from "./source-control/ContextBar.vue";
const ItemDetail = defineAsyncComponent(() => import("./github/ItemDetail.vue"));
import type { GhStatus, ListItem, Detail, Kind, RepoInfo, ItemPage } from "../../../src/github";
import { GitPullRequest, Search, RefreshCw, ArrowLeft, Menu, X } from "@lucide/vue";

import { formatHash, parseHash, readPrefs, mergePrefs, type Section, type Prefs } from "./source-control/state";
const prefsKey = () => `luna.sourceControl.${serverUrl.value || "default"}`;
const readSaved = (): Prefs => { try { return readPrefs(localStorage.getItem(prefsKey())); } catch { return {}; } };
const savePrefs = (patch: Prefs) => { try { localStorage.setItem(prefsKey(), JSON.stringify(mergePrefs(readSaved(), patch))); } catch {} };
/** A deep link wins over the saved section. */
const startHash = parseHash(location.hash), startPrefs = readSaved();
const hashed = location.hash.startsWith('#source-control/');
const section = ref<Section>(hashed ? startHash.section : startPrefs.section ?? 'changes');
/** Item from the URL; opened once the first list for its repository has loaded. */
let pendingOpen: number | null = hashed ? startHash.number ?? null : null;
/** Sections that read the local repository instead of GitHub. */
const local = computed(() => section.value === 'changes' || section.value === 'history' || section.value === 'branches');
type SourceProject = { id: number; name: string; cwd: string; general?: boolean; workerDirs?: { worker: number; cwd: string }[] };
/** A project is usable when it has a directory on the main host or on any machine. */
const usable = (projects: readonly SourceProject[]) => projects.filter(p => !p.general && (p.cwd || p.workerDirs?.some(d => d.cwd)));
const sourceProjects = ref<SourceProject[]>([]);
const sourceProject = ref<number | null>(chat.project);
/** `''` lets the server choose: the main host first, else the first online machine. */
const sourceMachine = ref('');
const machineChoices = computed(() => {
  const p = sourceProjects.value.find(x => x.id === sourceProject.value);
  if (!p) return [];
  const name = (id: number) => workers.list.find(w => w.id === id);
  return [
    ...(p.cwd ? [{ value: 'main', label: 'Main host', online: true }] : []),
    ...(p.workerDirs ?? []).filter(d => d.cwd).map(d => ({ value: String(d.worker), label: name(d.worker)?.name ?? `Machine ${d.worker}`, online: name(d.worker)?.online === true })),
  ];
});
watch([sourceProject, machineChoices], () => {
  if (sourceMachine.value && !machineChoices.value.some(m => m.value === sourceMachine.value)) sourceMachine.value = '';
});
const selector = computed(() => chat.session ? { session: String(chat.session) } : sourceProject.value !== null ? { project: sourceProject.value, ...(sourceMachine.value ? { machine: sourceMachine.value } : {}) } : null);
// A directory switch keeps the session ID but changes every local Git request target.
// Remount local tabs to discard old selections and fence their in-flight reads.
const workspaceKey = computed(() => JSON.stringify([selector.value, chat.cwd, chat.machine?.id, serverUrl.value, token.value]));
const status = ref<GhStatus | null>(null);
const repos = ref<{ repo: string; projects: { id: number; name: string }[] }[]>([]);
const selectedRepo = ref("");
const customRepoInput = ref("");
const showCustomRepo = ref(false);
const repoInputError = ref("");
const kind = ref<Kind>(section.value === 'issue' ? 'issue' : 'pr');
const stateFilter = ref<"open" | "closed" | "all">(startPrefs.state ?? "open");
/** Open-item totals per kind, from the last unfiltered list; absent until loaded. */
const counts = ref<{ pr?: number; issue?: number; changes?: number }>({});
const searchQuery = ref("");
const newOpen = ref(false);
const mineOnly = ref(false), labelFilter = ref(""), draftFilter = ref(""), reviewFilter = ref("");
const activeFilters = computed<ItemFilters>(() => ({
  ...(mineOnly.value ? { author: "@me" } : {}),
  ...(labelFilter.value.trim() ? { label: labelFilter.value.trim() } : {}),
  ...(kind.value === "pr" && draftFilter.value ? { draft: draftFilter.value } : {}),
  ...(kind.value === "pr" && reviewFilter.value ? { review: reviewFilter.value } : {}),
}));
const hasFilters = computed(() => Object.keys(activeFilters.value).length > 0);
function clearFilters() { mineOnly.value = false; labelFilter.value = ""; draftFilter.value = ""; reviewFilter.value = ""; }
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
/** Room for a file list beside a diff inside a pane that already has a list on its left. */
const isVeryWide = ref(window.innerWidth >= 1280);
const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
let lastWorkspaceRepo: string | null = null;
/** Origin of the local checkout, for display in the context bar. */
const localRepo = ref<string | null>(null);
let disposed = false, loadGeneration = 0, detailGeneration = 0, initGeneration = 0, infoGeneration = 0;
let displayedListKey = "";
let listController: AbortController | undefined, detailController: AbortController | undefined, infoController: AbortController | undefined, initController: AbortController | undefined;
let prefetchController: AbortController | null = null;
function cancelReads() { listController?.abort(); detailController?.abort(); infoController?.abort(); initController?.abort(); }
const context = () => JSON.stringify([serverUrl.value, token.value]);
const handleResize = () => { isWide.value = window.innerWidth >= 900; isVeryWide.value = window.innerWidth >= 1280; };
function cancelPrefetch() {
  if (prefetchController) {
    prefetchController.abort();
  }
  prefetchController = null;
}
function storageKey() { return `luna.github.repo.${serverUrl.value || "default"}`; }
function itemKey(repo: string, number: number) {
  const [owner, name] = repo.toLowerCase().split("/");
  return makeKey("item-detail", { owner, name, number });
}
function listKey(repo: string, type: Kind, state: string, q: string, filters: ItemFilters = activeFilters.value) {
  const [owner, name] = repo.toLowerCase().split("/");
  return makeKey("items", { owner, name, kind: type, state, q, after: "", ...filters });
}
function followRepo(repo: string | null) {
  if (repo === lastWorkspaceRepo) return;
  lastWorkspaceRepo = repo; localRepo.value = repo;
  if (repo) selectedRepo.value = repo;
}
const SECTIONS = [
  { id: 'changes', label: 'Changes' },
  { id: 'history', label: 'History' },
  { id: 'branches', label: 'Branches' },
  { id: 'pr', label: 'Pull requests' },
  { id: 'issue', label: 'Issues' },
] as const;

function syncHash() {
  if (disposed) return;
  const next = formatHash({ section: section.value, ...(!local.value && selectedItemNumber.value !== null ? { number: selectedItemNumber.value } : {}) });
  if (location.hash !== next) window.history.replaceState(null, "", next);
}
watch([section, selectedItemNumber], syncHash);
watch(section, value => savePrefs({ section: value }));
watch(stateFilter, value => savePrefs({ state: value }));
function setSection(value: Section) {
  if (value === section.value) return;
  section.value = value;
  if (value === 'pr' || value === 'issue') {
    if (kind.value === value) void loadList();
    else kind.value = value;
  }
}

async function loadSourceProjects() {
  const scope = context();
  try {
    await loadProjects();
    if (disposed || scope !== context()) return;
    sourceProjects.value = usable(history.projects);
    if (!sourceProjects.value.some(p => p.id === sourceProject.value)) sourceProject.value = sourceProjects.value[0]?.id ?? null;
  } catch (e) { if (!disposed && scope === context()) listError.value = (e as Error).message; }
}
async function init() {
  initController?.abort(); const controller = initController = new AbortController();
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
    fetchGhStatus(false, controller.signal).then(value => { if (current()) status.value = value; }).catch(e => {
      if (current()) status.value = { state: 'error', message: e.message };
    }),
    fetchRepos(controller.signal).then(result => {
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
  infoController?.abort(); const controller = infoController = new AbortController();
  const repo = selectedRepo.value, scope = context(), gen = ++infoGeneration;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return;
  const key = makeKey('repo-info', { owner: owner.toLowerCase(), name: name.toLowerCase() });
  repoInfo.value = cached<RepoInfo>(key)?.data ?? null;
  try {
    const value = await fetchRepoInfo(owner, name, fresh, controller.signal);
    if (!disposed && gen === infoGeneration && repo === selectedRepo.value && scope === context()) repoInfo.value = value;
  } catch (e) {
    if (!disposed && gen === infoGeneration && repo === selectedRepo.value && scope === context() && !controller.signal.aborted) listError.value = (e as Error).message;
  }
}
async function loadList(loadMore = false, fresh = false) {
  const repo = selectedRepo.value, type = kind.value, state = stateFilter.value, q = appliedSearch.value, scope = context();
  const [owner, name] = repo.split('/');
  if (!owner || !name || (loadMore && (loadingMore.value || !nextCursor.value))) return;
  listController?.abort(); const controller = listController = new AbortController();
  const gen = ++loadGeneration;
  const current = () => !disposed && gen === loadGeneration && repo === selectedRepo.value && scope === context();
  const filters = { ...activeFilters.value }, key = listKey(repo, type, state, q, filters), cursor = loadMore ? nextCursor.value : null;
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
    const page = await fetchItems(owner, name, type, state, q, cursor, fresh, controller.signal, filters);
    if (!current()) return;
    items.value = loadMore ? [...items.value, ...page.items.filter(row => !items.value.some(old => old.number === row.number))] : page.items;
    totalCount.value = page.total; nextCursor.value = page.next;
    if (!loadMore && state === 'open' && !q && !Object.keys(filters).length) counts.value = { ...counts.value, [type]: page.total };
    lastUpdated.value = new Date().toLocaleTimeString();
    if (pendingOpen !== null && !loadMore) { const n = pendingOpen; pendingOpen = null; selectedItemNumber.value = n; void loadDetail(n); }

  } catch (e) { if (current() && !controller.signal.aborted) listError.value = (e as Error).message; }
  finally { if (current()) { loadingItems.value = false; loadingMore.value = false; refreshingItems.value = false; } }
}
async function loadDetail(number: number, fresh = false) {
  detailController?.abort(); const controller = detailController = new AbortController();
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
    const value = await fetchItemDetail(owner, name, number, fresh, controller.signal);
    if (current()) detail.value = value;
  } catch (e) { if (current() && !controller.signal.aborted) detailError.value = (e as Error).message; }
  finally { if (current()) loadingDetail.value = false; }
}
function prefetchItem(item: ListItem) {
  const repo = selectedRepo.value;
  if (selectedItemNumber.value === item.number || cached<Detail>(itemKey(repo, item.number))) return;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return;
  cancelPrefetch();
  const controller = new AbortController(); prefetchController = controller;
  void fetchItemDetail(owner, name, item.number, false, controller.signal).catch(() => {}).finally(() => {
    if (prefetchController === controller) prefetchController = null;
  });
}
function handleSearchSubmit() { appliedSearch.value = searchQuery.value.trim(); void loadList(); }
function selectItem(item: ListItem) {
  selectedItemNumber.value = item.number;
  // Subscribe the selected detail before cancelling a hover consumer of the same request.
  void loadDetail(item.number);
  cancelPrefetch();
}
function backToList() { detailController?.abort(); detailGeneration++; selectedItemNumber.value = null; detail.value = null; loadingDetail.value = false; detailError.value = null; }
function handleRepoChange(val: string) {
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
/** The repository follows the selected project, but only when the project maps to one. A manual pick holds until the project changes. */
function repoOfProject(id: number | null) { return id === null ? undefined : repos.value.find(r => r.projects.some(p => p.id === id))?.repo; }
watch(() => chat.session ? chat.project : sourceProject.value, id => {
  const repo = repoOfProject(id);
  if (repo && repo !== selectedRepo.value) { showCustomRepo.value = false; selectedRepo.value = repo; }
});
watch(selectedRepo, val => {
  counts.value = { ...counts.value, pr: undefined, issue: undefined };
  cancelPrefetch(); listController?.abort(); infoController?.abort(); loadGeneration++; infoGeneration++; backToList();
  if (val && REPO_REGEX.test(val)) {
    try { localStorage.setItem(storageKey(), val); } catch {}
    void loadInfo(); void loadList();
  }
}, { flush: 'sync' });
watch([kind, stateFilter, mineOnly, draftFilter, reviewFilter], () => { cancelPrefetch(); backToList(); void loadList(); });
watch([serverUrl, token], () => {
  loadGeneration++; detailGeneration++; initGeneration++; infoGeneration++; cancelReads(); cancelPrefetch();
  lastWorkspaceRepo = null; localRepo.value = null; selectedRepo.value = ''; detail.value = null; items.value = []; repoInfo.value = null;
  totalCount.value = 0; nextCursor.value = null; displayedListKey = ''; lastUpdated.value = ''; listError.value = null; detailError.value = null;
  status.value = null; repos.value = []; sourceProjects.value = [];
  loadingItems.value = loadingMore.value = refreshingItems.value = loadingDetail.value = false;
  void init(); void loadSourceProjects();
}, { flush: 'sync' });
watch(() => history.projects, projects => {
  sourceProjects.value = usable(projects);
  if (!sourceProjects.value.some(p => p.id === sourceProject.value)) sourceProject.value = sourceProjects.value[0]?.id ?? null;
});
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.key === 'r' && !local.value && status.value?.state === 'ok') { e.preventDefault(); refresh(); }
  else if (e.key === '/' && !local.value) { e.preventDefault(); document.querySelector<HTMLInputElement>('#sc-search')?.focus(); }
  else if (e.key === 'Escape' && !isWide.value && selectedItemNumber.value !== null) backToList();
}
onMounted(() => { syncHash(); window.addEventListener('keydown', onKey); window.addEventListener('resize', handleResize); void loadSourceProjects(); void loadWorkers().catch(() => {}); void init(); });
onUnmounted(() => {
  disposed = true; loadGeneration++; detailGeneration++; initGeneration++; infoGeneration++; cancelReads(); cancelPrefetch();
  window.removeEventListener('resize', handleResize); window.removeEventListener('keydown', onKey);
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
          class="md:hidden p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
          title="Open menu"
          aria-label="Open navigation"
        >
          <Menu class="w-5 h-5" />
        </button>
        <div class="flex items-center gap-2">
          <GitPullRequest class="w-5 h-5 text-primary" />
          <h1 tabindex="-1" class="font-semibold text-base">Source Control</h1>
        </div>
      </div>

      <div v-if="!local && status?.state === 'ok'" class="flex flex-wrap items-center gap-2 min-w-0">
        <button
          type="button"
          @click="refresh"
          class="p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': refreshingItems }" />
        </button>

      </div>
      <button
        type="button"
        @click="backToChat"
        class="ml-auto p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
        title="Close"
        aria-label="Close Source Control"
      >
        <X class="w-[18px] h-[18px]" />
      </button>
    </header>

    <div role="tablist" aria-label="Source Control sections" @keydown="handleTablistKeydown" class="flex shrink-0 gap-1 px-3 py-2 border-b border-border overflow-x-auto">
      <button
        v-for="tab in SECTIONS"
        :id="`sc-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="section === tab.id"
        :tabindex="section === tab.id ? 0 : -1"
        class="px-3 py-1.5 rounded text-xs whitespace-nowrap shrink-0"
        :class="section === tab.id ? 'bg-secondary text-foreground' : 'text-muted-foreground'"
        @click="setSection(tab.id)"
      >{{ tab.label }}<span v-if="counts[tab.id as 'pr' | 'issue' | 'changes'] !== undefined" class="ml-1.5 text-muted-foreground tabular-nums">{{ counts[tab.id as 'pr' | 'issue' | 'changes'] }}</span></button>
    </div>
    <ContextBar
      v-model:project="sourceProject"
      v-model:machine="sourceMachine"
      v-model:custom-input="customRepoInput"
      :session-target="chat.session ? { machine: chat.machine?.name ?? (chat.machine ? `Machine ${chat.machine.id}` : 'main'), cwd: chat.cwd ?? '' } : null"
      :projects="sourceProjects"
      :machines="machineChoices"
      :repos="repos"
      :repo="selectedRepo"
      :local-repo="localRepo"
      :show-repo="!local && status?.state === 'ok'"
      :show-custom="showCustomRepo"
      :custom-error="repoInputError"
      @repo-change="handleRepoChange"
      @confirm-custom="confirmCustomRepo"
    />
    <template v-if="local">
      <p v-if="chat.runActive" class="px-3 py-1 text-xs text-muted-foreground">The session is running. Files can change while you work.</p>
      <template v-if="selector">
        <ChangesTab v-if="section === 'changes'" :key="`changes:${workspaceKey}`" v-bind="selector" :run-active="chat.runActive" @repo="followRepo" @count="n => counts = { ...counts, changes: n }" />
        <HistoryTab v-else-if="section === 'history'" :key="`history:${workspaceKey}`" v-bind="selector" :wide="isWide" :files-wide="isVeryWide" />
        <BranchesTab v-else :key="`branches:${workspaceKey}`" v-bind="selector" :wide="isWide" />
      </template>
      <p v-else class="p-5 text-sm text-muted-foreground">Select a project with a directory on the main host or a machine to use source control.</p>
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
        <button type="button" class="px-3 py-1.5 text-xs bg-card hover:bg-accent rounded border border-border" @click="refresh">Check again</button>
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
                  id="sc-search"
                  v-model="searchQuery"
                  type="text"
                  placeholder="Search (Enter, / to focus)"
                  @keydown.enter="handleSearchSubmit"
                  class="w-full bg-muted border border-border rounded pl-8 pr-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
                />
              </div>
              <button type="button" class="shrink-0 px-2 py-1 text-xs rounded border border-border bg-muted hover:bg-accent" title="Create on GitHub" @click="newOpen = true">New</button>
              <select
                v-model="stateFilter"
                class="bg-muted border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary"
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </select>
            </div>
            <!-- Filters -->
            <div class="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="List filters">
              <button type="button" class="px-2 py-1 rounded border border-border" :class="mineOnly ? 'bg-secondary text-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'" :aria-pressed="mineOnly" @click="mineOnly = !mineOnly">Mine</button>
              <input v-model="labelFilter" type="text" maxlength="50" placeholder="Label" aria-label="Filter by label" class="w-20 min-w-0 flex-1 bg-muted border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary" @keydown.enter="loadList()" @blur="loadList()" />
              <template v-if="kind === 'pr'">
                <select v-model="draftFilter" aria-label="Filter by draft" class="bg-muted border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary">
                  <option value="">Any draft</option><option value="false">Ready</option><option value="true">Draft</option>
                </select>
                <select v-model="reviewFilter" aria-label="Filter by review" class="bg-muted border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:border-primary">
                  <option value="">Any review</option><option value="approved">Approved</option><option value="changes_requested">Changes requested</option><option value="required">Review required</option>
                </select>
              </template>
              <button v-if="hasFilters" type="button" class="px-2 py-1 text-muted-foreground hover:text-foreground underline" @click="clearFilters(); loadList()">Clear</button>
            </div>
          </div>

          <NewItemDialog v-model:open="newOpen" :repo="selectedRepo" :kind="kind" :info="repoInfo" @created="n => { selectedItemNumber = n; void loadList(false, true); void loadDetail(n, true); }" />
          <!-- List Error -->
          <div v-if="listError" role="alert" class="p-3 bg-destructive/10 text-destructive text-xs border-b border-border flex items-center justify-between gap-2">
            <span class="min-w-0 break-words">{{ listError }}</span>
            <button type="button" class="shrink-0 px-2 py-1 bg-card text-foreground rounded border border-border hover:bg-accent" @click="refresh">Retry</button>
          </div>

          <!-- List -->
          <div class="flex-1 min-h-0 min-w-0">
            <ItemList
              :items="items"
              :selected-number="selectedItemNumber"
              :loading="loadingItems"
              :has-next="nextCursor !== null"
              :loading-more="loadingMore"
              :empty-hint="stateFilter === 'open' && !appliedSearch && !listError ? 'Show closed' : undefined"
              @empty-action="stateFilter = 'all'"
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
            :files-wide="isVeryWide"
          />
        </div>
      </div>
    </div>
  </div>
</template>
