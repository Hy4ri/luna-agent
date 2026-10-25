<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { ui, backToChat, setDrawer } from "@/stores/app";
import { chat } from "@/stores/chat";
import { history } from "@/stores/sessions";
import { serverUrl, json } from "@/lib/api";
import { fetchGhStatus, fetchRepos, fetchItems, fetchItemDetail, fetchRepoInfo } from "./github/client";
import ChangesTab from "./source-control/ChangesTab.vue";
import ItemList from "./github/ItemList.vue";
import ItemDetail from "./github/ItemDetail.vue";
import type { GhStatus, ListItem, Detail, Kind, RepoInfo } from "../../../src/github";
import { GitPullRequest, Search, RefreshCw, ArrowLeft, Menu } from "@lucide/vue";

const section = ref<'changes' | 'pr' | 'issue'>('changes');
const sourceProjects = ref<{id:number;name:string;cwd:string;general?:boolean}[]>([]);
const sourceProject = ref<number | null>(chat.project);
const selector = computed(() => chat.session ? { session: String(chat.session) } : sourceProject.value !== null ? { project: sourceProject.value } : null);
async function loadSourceProjects() {
  try { sourceProjects.value = (await json<{projects: typeof sourceProjects.value}>('/v1/projects')).projects.filter(p => !p.general && p.cwd);
    if (!sourceProjects.value.some(p => p.id === sourceProject.value)) sourceProject.value = sourceProjects.value[0]?.id ?? null;
  } catch (e) { listError.value = (e as Error).message; }
}
function setSection(value: 'changes' | 'pr' | 'issue') { section.value = value; if (value !== 'changes') { if (kind.value === value) void loadList(); else kind.value = value; } }
function followRepo(repo: string | null) { if (repo) selectedRepo.value = repo; }
const status = ref<GhStatus | null>(null);
const repos = ref<{ repo: string; projects: { id: number; name: string }[] }[]>([]);
const selectedRepo = ref<string>("");
const customRepoInput = ref<string>("");
const showCustomRepo = ref<boolean>(false);
const repoInputError = ref<string>("");

const kind = ref<Kind>("pr");
const stateFilter = ref<"open" | "closed" | "all">("open");
const searchQuery = ref<string>("");
const appliedSearch = ref<string>("");

const items = ref<ListItem[]>([]);
const totalCount = ref<number>(0);
const nextCursor = ref<string | null>(null);
const loadingItems = ref<boolean>(false);
const loadingMore = ref<boolean>(false);
const listError = ref<string | null>(null);

const selectedItemNumber = ref<number | null>(null);
const detail = ref<Detail | null>(null);
const repoInfo = ref<RepoInfo | null>(null);
const loadingDetail = ref<boolean>(false);
const detailError = ref<string | null>(null);
const lastUpdated = ref<string>("");

const isWide = ref<boolean>(window.innerWidth >= 900);
const handleResize = () => {
  isWide.value = window.innerWidth >= 900;
};
window.addEventListener("resize", handleResize);

onUnmounted(() => {
  window.removeEventListener("resize", handleResize);
  loadGeneration++; detailGeneration++;
});

let loadGeneration = 0;
let detailGeneration = 0;

function storageKey() {
  return `luna.github.repo.${serverUrl.value || "default"}`;
}

const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function init() {
  try {
    status.value = await fetchGhStatus();
    if (status.value.state !== "ok") return;

    const res = await fetchRepos();
    repos.value = res.repos;
    if (!res.repos.length) showCustomRepo.value = true;

    const saved = localStorage.getItem(storageKey());
    if (saved && (repos.value.some((r) => r.repo === saved) || REPO_REGEX.test(saved))) {
      selectedRepo.value = saved;
    } else {
      const activeProjId = chat.project;
      const matched = activeProjId ? repos.value.find((r) => r.projects.some((p) => p.id === activeProjId)) : null;
      if (matched) {
        selectedRepo.value = matched.repo;
      } else if (repos.value.length > 0) {
        selectedRepo.value = repos.value[0]!.repo;
      }
    }


  } catch (e: any) {
    status.value = { state: "error", message: e?.message ?? "Failed to initialize GitHub view" };
  }
}

async function loadList(loadMore = false) {
  if (!selectedRepo.value || status.value?.state !== "ok") return;
  const gen = ++loadGeneration;
  const [owner, name] = selectedRepo.value.split("/");
  if (!owner || !name) return;

  listError.value = null;
  if (loadMore) {
    loadingMore.value = true;
  } else {
    loadingItems.value = true;
    items.value = [];
    nextCursor.value = null;
  }

  try {
    const page = await fetchItems(owner, name, kind.value, stateFilter.value, appliedSearch.value, loadMore ? nextCursor.value : null);
    if (gen !== loadGeneration) return;
    items.value = loadMore ? [...items.value, ...page.items] : page.items;
    totalCount.value = page.total;
    nextCursor.value = page.next;
    lastUpdated.value = new Date().toLocaleTimeString();
  } catch (e: any) {
    if (gen !== loadGeneration) return;
    listError.value = e?.message ?? "Failed to load list";
  } finally {
    if (gen === loadGeneration) {
      loadingItems.value = false;
      loadingMore.value = false;
    }
  }
}

async function loadDetail(number: number) {
  if (!selectedRepo.value) return;
  const gen = ++detailGeneration;
  const [owner, name] = selectedRepo.value.split("/");
  if (!owner || !name) return;

  loadingDetail.value = true;
  detailError.value = null;
  detail.value = null;

  try {
    const d = await fetchItemDetail(owner, name, number);
    if (gen !== detailGeneration) return;
    detail.value = d;
  } catch (e: any) {
    if (gen !== detailGeneration) return;
    detailError.value = e?.message ?? "Failed to load detail";
  } finally {
    if (gen === detailGeneration) {
      loadingDetail.value = false;
    }
  }
}

function handleSearchSubmit() {
  appliedSearch.value = searchQuery.value;
  void loadList();
}

function selectItem(item: ListItem) {
  selectedItemNumber.value = item.number;
  void loadDetail(item.number);
}

function backToList() {
  selectedItemNumber.value = null;
  detail.value = null;
}

function handleRepoChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  if (val === "__custom__") {
    showCustomRepo.value = true;
    repoInputError.value = "";
  } else {
    showCustomRepo.value = false;
    selectedRepo.value = val;
  }
}

function confirmCustomRepo() {
  const trimmed = customRepoInput.value.trim();
  if (!REPO_REGEX.test(trimmed)) {
    repoInputError.value = "Enter valid owner/repo";
    return;
  }
  repoInputError.value = "";
  showCustomRepo.value = false;
  selectedRepo.value = trimmed;
}

async function refreshAfterAction(updated?: Detail) {
  if (updated) detail.value = updated;
  else if (selectedItemNumber.value !== null) await loadDetail(selectedItemNumber.value);
  await loadList();
  // Search indexing can lag: apply the authoritative state to the loaded row.
  if (detail.value) {
    const current = detail.value;
    const row = items.value.find(item => item.number === current.number);
    if (row) row.state = current.state;
    if (stateFilter.value !== 'all') items.value = items.value.filter(item => stateFilter.value === 'open' ? item.state === 'OPEN' : item.state !== 'OPEN');
  }
}
watch(selectedRepo, (val) => {
  if (val && REPO_REGEX.test(val)) {
    try { localStorage.setItem(storageKey(), val); } catch {}
    selectedItemNumber.value = null;
    detail.value = null;
    loadGeneration++;
    detailGeneration++;
    repoInfo.value = null;
    const repo = val;
    const [owner, name] = repo.split("/");
    if (owner && name) void fetchRepoInfo(owner, name).then(value => { if (repo === selectedRepo.value) repoInfo.value = value; }).catch(e => { if (repo === selectedRepo.value) listError.value = e.message; });
    void loadList();
  }
});

watch([kind, stateFilter], () => {
  selectedItemNumber.value = null;
  detail.value = null;
  loadGeneration++;
  detailGeneration++;
  void loadList();
});

watch(serverUrl, () => { loadGeneration++; detailGeneration++; selectedRepo.value = ""; detail.value = null; items.value = []; repoInfo.value = null; void init(); });
onMounted(() => {
  void loadSourceProjects();
  void init();
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
          @click="loadList(); selectedItemNumber !== null && loadDetail(selectedItemNumber)"
          class="p-1.5 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loadingItems }" />
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
      <ChangesTab v-if="selector" v-bind="selector" @repo="followRepo" />
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
            @deleted="backToList(); loadList()"
            :loading="loadingDetail"
            :error="detailError"
          />
        </div>
      </div>
    </div>
  </div>
</template>
