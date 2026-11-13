<script setup lang="ts">
import { stewardOpen, startStewardBadge, stopStewardBadge } from "@/stores/steward";
import { ref, computed, defineAsyncComponent, onMounted, onUnmounted, nextTick, watch } from "vue";
import { serverUrl, token } from '@/lib/api';
import {
  Moon,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Clock,
  FolderKanban,
  Kanban,
  History as HistoryIcon,
  Search,
  Archive,
  Bell,
  ChevronRight,
  ChevronLeft,
  Pin,
  FolderInput,
  Ellipsis,
  Pencil,
  Sparkles,
  Copy,
  Check,
  Trash2,
  Settings as SettingsIcon,
  LoaderCircle,
  CircleCheck,
  CircleX,
  CircleHelp,
  CircleAlert,
  Hourglass,
  CircleStop,
  ScanEye,
  ChartNoAxesColumn,
  HeartHandshake,
  GitBranch,
  Star,
  Palette,
  ListChecks,
  Square,
  SquareCheck,
} from "@lucide/vue";
import { useMobile } from "@/lib/dom";
import { useVirtualList } from "@vueuse/core";
import { ui, toggleCollapsed, setSideWidth, openPanel, setDrawer, openAnalytics, openSteward, openSourceControl } from "@/stores/app";
import { chat, openSession, newSession } from "@/stores/chat";
import { loadWorkers, workers } from "@/stores/workers";
import { sortProjects, resolveQuickSessionTarget } from "@/lib/projects";
import ProjectIcon from "@/components/ProjectIcon.vue";
import type { ProjectAppearance } from "../../../../src/project-appearance";
import { history, toggleFavorite, loadSessions, loadMoreSessions, setDrill, sessionTitle, projectName, renameSession, generateTitle, titleModelAvailable, togglePinned, toggleArchived, activity, markActivitySeen, dismissActivity, markAllActivitySeen, deleteSession, bulkAction, type BulkAction } from "@/stores/sessions";
import { startSessionDrag, endSessionDrag } from "@/lib/pane";
import { sessionState, sessionStatusLabel } from "@/lib/session-status";
import type { SessionStatus } from "@/lib/types";
import { copyToClipboard } from "@/lib/message";
import { ago } from "@/lib/mention-sources";

function sessionStatusIcon(status: SessionStatus) {
  switch (status) {
    case "running":
    case "reviewing":
      return LoaderCircle;
    case "finished":
      return CircleCheck;
    case "review_finished":
      return ScanEye;
    case "needs_approval":
      return CircleAlert;
    case "needs_input":
      return CircleHelp;
    case "limit_reached":
      return Hourglass;
    case "failed":
      return CircleX;
    case "stopped":
      return CircleStop;
    default:
      return CircleCheck;
  }
}

const MoveSessionDialog = defineAsyncComponent(() => import("./MoveSessionDialog.vue"));
const PruneSessionsDialog = defineAsyncComponent(() => import("./PruneSessionsDialog.vue"));
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

const ProjectAppearanceDialog = defineAsyncComponent(() => import("@/components/ProjectAppearanceDialog.vue"));
const appearanceProject = ref<number | null>(null);
function openProjectSettings(id: number) {
  ui.projectsTarget = id;
  openPanel("projects");
}
const pruneOpen = ref(false), pruneResult = ref("");

// Multi-select mode: checkboxes on rows and a bulk action bar.
const selecting = ref(false), selected = ref(new Set<string>()), bulkBusy = ref(false);
const selectedSessions = computed(() => history.rows.filter(s => selected.value.has(String(s.id))));
const hasMoreRows = computed(() => !!history.nextCursor);
const selectAllLabel = computed(() => hasMoreRows.value ? "Select loaded conversations" : "Select all / none");

function toggleSelect(id: string | number) {
  const next = new Set(selected.value), k = String(id);
  if (!next.delete(k)) next.add(k);
  selected.value = next;
}
function exitSelect() { selecting.value = false; selected.value = new Set(); }
watch(() => chat.session, (id) => { if (id) markActivitySeen(id); });
watch([() => history.query, () => history.archived, () => history.drill, () => history.worker, serverUrl, token], exitSelect, { flush: 'sync' });
function selectAllLoaded() {
  const ids = history.rows.map(s => String(s.id));
  selected.value = ids.length > 0 && ids.every(i => selected.value.has(i)) ? new Set() : new Set(ids);
}
async function runBulk(action: BulkAction) {
  if (bulkBusy.value) return;
  bulkBusy.value = true;
  try {
    const targets = selectedSessions.value;
    const done = await bulkAction(targets, action);
    if (done) exitSelect();
  } finally { bulkBusy.value = false; }
}
const mobile = useMobile();
const collapsed = computed(() => ui.collapsed && !mobile.value);
defineProps<{ inert?: boolean }>();

const activityOpen = ref(false);
const searchInputRef = ref<HTMLInputElement | null>(null);
const searchToggleRef = ref<HTMLButtonElement | null>(null);
const renamingId = ref<string | number | null>(null);
const renameValue = ref("");

const activeMenuSession = ref<any | null>(null);
const moveTarget = ref<any | null>(null);
const activeMenuBtnEl = ref<HTMLElement | null>(null);
const menuPos = ref({ top: 0, left: 0 });
const titleAvailable = ref(false);
const titling = ref(false);
/** Feedback for the session id copy: empty, "ok", or "fail". */
const copyState = ref<"" | "ok" | "fail">("");
let copyTimer: ReturnType<typeof setTimeout> | null = null;

type Machine = { key: string; id: number | null; name: string; online: boolean };
type Folder = ProjectAppearance & {
  key: string;
  name: string;
  project: number | null;
  favorite?: boolean;
  count: number;
  lastActivity: number;
  activity: number;
  statuses: Record<string, number>;
  machines: Record<string, number>;
};

/** Machines appear only when workers exist. Each session belongs to one machine. */
const machines = computed<Machine[]>(() => workers.list.length
  ? [{ key: "main", id: null, name: "This host", online: true }, ...workers.list.map(w => ({ key: String(w.id), id: w.id, name: w.name, online: w.online }))]
  : []);
const machineOf = (s: any) => machines.value.find(m => m.id === (s.worker ?? null));

/** One folder per project, plus "Chats" for sessions without a named project. History opens one folder at a time. */
const folders = computed<Folder[]>(() => {
  const named = sortProjects(history.projects).filter(p => !p.general);
  const result: Folder[] = named.map(p => {
    const summary = history.groups[String(p.id)] || { count: 0, lastActivity: 0, activity: 0, statuses: {}, machines: {} };
    return {
      key: String(p.id),
      name: p.name,
      project: p.id,
      favorite: p.favorite,
      color: p.color,
      icon: p.icon,
      count: summary.count ?? 0,
      lastActivity: summary.lastActivity ?? 0,
      activity: summary.activity ?? 0,
      statuses: summary.statuses ?? {},
      machines: summary.machines ?? {},
    };
  });

  // Rank projects by their activity across both archive modes, keeping favourites above others.
  result.sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.activity - a.activity));

  const general = history.projects.find(p => p.general);
  const generalSummary = history.groups["none"] || { count: 0, lastActivity: 0, activity: 0, statuses: {}, machines: {} };
  result.splice(result.filter(f => f.favorite).length, 0, {
    key: "none",
    name: "Chats",
    project: null,
    icon: general?.icon,
    color: general?.color,
    count: generalSummary.count ?? 0,
    lastActivity: generalSummary.lastActivity ?? 0,
    activity: generalSummary.activity ?? 0,
    statuses: generalSummary.statuses ?? {},
    machines: generalSummary.machines ?? {},
  });
  return result;
});

/** With no named projects there is nothing to choose, so the only folder is always open. */
const single = computed(() => folders.value.length === 1);
const openFolder = computed(() => single.value ? folders.value[0]! : folders.value.find(f => f.key === history.drill) ?? null);

/** Device filter inside an open folder: "all" or a machine key. Synced with history.worker. */
const device = computed({
  get: () => {
    if (history.worker === "all") return "all";
    if (history.worker === "main") return "main";
    return String(history.worker);
  },
  set: (val: string) => {
    if (val === "all") history.worker = "all";
    else if (val === "main") history.worker = "main";
    else history.worker = Number(val);
  },
});
const deviceMachine = computed(() => machines.value.find(m => m.key === device.value));
const searching = computed(() => !!history.query.trim());

/** True windowing: only visible session rows (+overscan) are mounted.
 *  history.rows holds the currently loaded server page window. */
const { list: vSessions, containerProps: sessionsContainerProps, wrapperProps: sessionsWrapperProps } = useVirtualList(computed(() => history.rows), { itemHeight: 48, overscan: 10 });

function drill(key: string | null) {
  history.worker = "all";
  setDrill(key);
  if (key === null) nextTick(() => document.querySelector<HTMLButtonElement>("#sessions .folder-open")?.focus());
  else nextTick(() => document.querySelector<HTMLButtonElement>("#history-back")?.focus());
}

const folderTime = (f: Folder) => f.lastActivity;
const folderStatuses = (f: Folder) => {
  const list: { status: any; count: number; label: string }[] = [];
  for (const [st, cnt] of Object.entries(f.statuses)) {
    if (cnt > 0 && st !== "ready" && st !== "stopped") {
      list.push({ status: st, count: cnt, label: sessionStatusLabel({ status: st as any }) });
    }
  }
  return list;
};
const machineCount = (f: Folder, m: Machine) => f.machines[m.key] ?? 0;

/** Default machine for starting a quick session in a project folder: main host if linked, else its first online worker. */
const folderQuickSessionTarget = (f: Folder) => resolveQuickSessionTarget(f.project, f.name, history.projects, workers.list);

/** Text after the title of a session row: project while searching, machine when several are shown together. */
function sessionMeta(s: any) {
  const parts: string[] = [];
  if (searching.value) {
    const p = history.projects.find(proj => proj.id === s.project);
    parts.push(p?.name ?? "Chats");
  }
  if (machines.value.length && (searching.value || !deviceMachine.value)) parts.push(machineOf(s)?.name ?? "Unknown machine");
  return parts.join(" · ");
}

async function handleNewChat(projectId?: number | string | null, worker?: number | null) {
  try {
    const id = await newSession(projectId, worker);
    if (id) {
      setDrawer(false);
      nextTick(() => document.querySelector<HTMLInputElement>("#input")?.focus());
    }
  } catch (e: any) {
    history.status = e.message;
  }
}

function toggleSearch() {
  history.searchOpen = !history.searchOpen;
  if (history.searchOpen) {
    nextTick(() => searchInputRef.value?.focus());
  } else {
    history.query = "";
    nextTick(() => searchToggleRef.value?.focus());
  }
}

function handleSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    history.searchOpen = false;
    history.query = "";
    nextTick(() => searchToggleRef.value?.focus());
  }
}

function toggleHistoryView() {
  toggleArchivedView(!history.archived);
}

function toggleArchivedView(archived: boolean) {
  history.archived = archived;
}

// Resizer logic
function onResizePointerDown(e: PointerEvent) {
  if (collapsed.value || mobile.value) return;
  const startX = e.clientX;
  const startWidth = ui.sideWidth || 264;

  function onPointerMove(me: PointerEvent) {
    const delta = me.clientX - startX;
    const newW = Math.max(200, Math.min(480, startWidth + delta));
    document.documentElement.style.setProperty("--side-w", newW + "px");
    setSideWidth(newW);
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function onResizeKeydown(e: KeyboardEvent) {
  if (collapsed.value || mobile.value) return;
  const cur = ui.sideWidth || 264;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    const next = Math.max(200, cur - 16);
    document.documentElement.style.setProperty("--side-w", next + "px");
    setSideWidth(next);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    const next = Math.min(480, cur + 16);
    document.documentElement.style.setProperty("--side-w", next + "px");
    setSideWidth(next);
  }
}

function onResizeDblClick() {
  document.documentElement.style.removeProperty("--side-w");
  setSideWidth(null);
}

// Rename
function startRename(s: any) {
  renamingId.value = s.id;
  renameValue.value = sessionTitle(s);
  activeMenuSession.value = null;
  nextTick(() => { const input = document.querySelector<HTMLInputElement>("input.session-rename"); input?.focus(); input?.select(); });
}

async function saveRename(s: any) {
  const t = renameValue.value.trim();
  const cur = sessionTitle(s);
  if (t && t !== cur) {
    await renameSession(s, t);
  }
  renamingId.value = null;
}

// Session Menu
function openSessionMenu(s: any, event: MouseEvent) {
  event.stopPropagation();
  const btn = event.currentTarget as HTMLElement;
  if (activeMenuSession.value?.id === s.id) {
    activeMenuSession.value = null;
    activeMenuBtnEl.value = null;
    return;
  }
  activeMenuSession.value = s;
  activeMenuBtnEl.value = btn;
  titleAvailable.value = false;
  copyState.value = "";
  void titleModelAvailable().then(ok => { if (activeMenuSession.value?.id === s.id) titleAvailable.value = ok; });
  const rect = btn.getBoundingClientRect();
  menuPos.value = {
    top: Math.max(8, Math.min(rect.top, window.innerHeight - 300)),
    left: Math.max(8, Math.min(rect.right + 4, window.innerWidth - 180)),
  };
  void nextTick(() => {
    const menuEl = document.getElementById('session-menu');
    if (menuEl) {
      const m = menuEl.getBoundingClientRect();
      menuPos.value = {
        top: Math.max(8, Math.min(rect.top, window.innerHeight - m.height - 8)),
        left: Math.max(8, Math.min(rect.right + 4, window.innerWidth - m.width - 8)),
      };
    }
    menuEl?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  });
}

async function handleMenuAction(action: string, s: any) {
  if (action === "pin") {
    await togglePinned(s);
    closeMenu();
  } else if (action === "copy-id") {
    const ok = await copyToClipboard(String(s.id));
    copyState.value = ok ? "ok" : "fail";
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyState.value = ""; if (ok) closeMenu(); }, 1200);
  } else if (action === "rename") {
    closeMenu();
    startRename(s);
  } else if (action === "title") {
    titling.value = true;
    try { await generateTitle(s); } finally { titling.value = false; }
    closeMenu();
  } else if (action === "archive") {
    await toggleArchived(s);
    closeMenu();
  } else if (action === "delete") {
    if (await deleteSession(s)) {
      closeMenu();
    }
  }
}

function closeMenu() {
  activeMenuSession.value = null;
  activeMenuBtnEl.value?.focus();
  copyState.value = "";
  if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
}
function outsideMenu(e: PointerEvent) {
  if (activeMenuSession.value && !(e.target as Element).closest('#session-menu,.session-manage')) closeMenu();
}
function menuKey(e: KeyboardEvent) {
  if (!activeMenuSession.value || e.defaultPrevented || e.isComposing) return;
  if (document.querySelector('[data-dismissable-layer][data-state="open"], :popover-open')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); return; }
  // Resume normal tab order from the trigger instead of trapping focus in a menu.
  if (e.key === 'Tab') { closeMenu(); return; }
  if (!['Home', 'End', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const items = [...document.querySelectorAll<HTMLButtonElement>('#session-menu button:not(:disabled)')];
  if (!items.length) return;
  if (e.key === 'Home') { items[0]?.focus(); return; }
  if (e.key === 'End') { items.at(-1)?.focus(); return; }
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}
onUnmounted(() => {
  stopStewardBadge();
  if (copyTimer) clearTimeout(copyTimer);
  document.removeEventListener('pointerdown', outsideMenu);
  document.removeEventListener('keydown', menuKey, true);
});
onMounted(() => {
  startStewardBadge();
  loadWorkers().catch((e) => console.warn("Failed to load workers:", e));
  document.addEventListener('pointerdown', outsideMenu);
  document.addEventListener('keydown', menuKey, true);
});
</script>

<template>
  <aside
    id="side"
    aria-label="Sidebar"
    :inert="inert || (mobile && !ui.drawer)"
    :class="{ collapsed, open: ui.drawer }"
    :style="{ '--side-w': (ui.sideWidth || 264) + 'px' }"
  >
    <!-- Header -->
    <header class="side-head">
      <div class="brand">
        <Moon :size="20" class="text-primary-text" aria-hidden="true" />
        <h1 v-if="!collapsed">Luna</h1>
      </div>
      <button
        id="side-collapse"
        class="icon-button"
        :aria-expanded="!ui.collapsed ? 'true' : 'false'"
        :aria-label="ui.collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        :title="ui.collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="toggleCollapsed"
      >
        <component :is="ui.collapsed ? PanelLeftOpen : PanelLeftClose" :size="18" />
      </button>
      <button
        id="side-close"
        class="icon-button"
        aria-label="Close navigation"
        @click="setDrawer(false)"
      >
        <X :size="18" />
      </button>
    </header>

    <!-- Nav Top -->
    <nav id="nav" class="side-top">
      <button class="side-item" data-panel="cron" title="Cron" @click="openPanel('cron')">
        <Clock :size="16" />
        <span class="side-label">Cron</span>
        <span id="cron-unread" class="pill ml-auto text-xs font-medium tabular-nums text-primary-text" :hidden="!ui.cronUnread">{{ ui.cronUnread }}</span>
      </button>
      <button class="side-item" data-panel="projects" title="Projects" @click="openPanel('projects')">
        <FolderKanban :size="16" />
        <span class="side-label">Projects</span>
      </button>
      <button class="side-item" data-panel="board" title="Board" @click="openPanel('board')">
        <Kanban :size="16" />
        <span class="side-label">Board</span>
      </button>
      <button class="side-item" title="Analytics" :aria-current="ui.view === 'analytics' ? 'page' : undefined" @click="openAnalytics"><ChartNoAxesColumn :size="16" /><span class="side-label">Analytics</span></button>
      <button class="side-item" title="Steward" :aria-current="ui.view === 'steward' ? 'page' : undefined" @click="openSteward"><HeartHandshake :size="16" /><span class="side-label">Steward</span><span v-if="stewardOpen" class="ml-auto text-xs tabular-nums text-muted-foreground">{{ stewardOpen }}</span></button>
      <button class="side-item" title="Source Control" :aria-current="ui.view === 'source-control' ? 'page' : undefined" @click="openSourceControl"><GitBranch :size="16" /><span class="side-label">Source Control</span></button>
    </nav>

    <!-- History Section -->
    <section class="history">
      <button
        id="history-rail"
        class="side-item"
        aria-label="Show history"
        title="History"
        @click="toggleCollapsed"
      >
        <HistoryIcon :size="18" />
      </button>

      <div class="history-head" v-if="!collapsed">
        <HistoryIcon :size="16" />
        <h2 id="history-title">History</h2>
        <button
          id="search-toggle"
          ref="searchToggleRef"
          class="icon-button"
          :aria-expanded="history.searchOpen ? 'true' : 'false'"
          aria-controls="search-bar"
          aria-label="Search conversations"
          @click="toggleSearch"
        >
          <Search :size="16" />
        </button>
        <Popover v-model:open="activityOpen">
          <PopoverTrigger as-child>
            <button id="activity-bell" class="icon-button relative" :aria-label="activity.items.length ? `Activity, ${activity.items.length} new` : 'Activity'" title="Activity across all projects">
              <Bell :size="16" />
              <span v-if="activity.items.length" class="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary" aria-hidden="true"></span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" class="w-96 max-w-[calc(100vw-1rem)] p-1.5">
            <div class="flex items-center px-2 py-1 text-xs font-semibold text-muted-foreground">
              <span class="mr-auto">Activity</span>
              <button v-if="activity.items.length" class="hover:text-foreground" @click="markAllActivitySeen">Mark all read</button>
            </div>
            <p v-if="!activity.items.length" class="px-2 py-3 text-xs text-muted-foreground">Nothing new.</p>
            <div v-for="s in activity.items" :key="s.id" class="flex items-center gap-1 rounded-sm hover:bg-secondary">
              <button
                class="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left text-sm"
                @click="markActivitySeen(s.id); activityOpen = false; setDrawer(false); openSession(s.id)"
              >
                <span class="session-state size-2 shrink-0 rounded-full bg-current" :data-status="sessionState(s)" aria-hidden="true"></span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{{ sessionTitle(s) }}</span>
                  <span class="block truncate text-xs text-muted-foreground">{{ sessionStatusLabel(s) }}<template v-if="projectName(s.project)"> · {{ projectName(s.project) }}</template></span>
                </span>
              </button>
              <button class="icon-button mr-1 shrink-0" title="Mark as read" :aria-label="`Mark ${sessionTitle(s)} as read`" @click="dismissActivity(s.id)"><Check :size="16" /></button>
            </div>
          </PopoverContent>
        </Popover>
        <button
          id="history-view"
          class="icon-button"
          :aria-pressed="history.archived ? 'true' : 'false'"
          :aria-label="history.archived ? 'Show active conversations' : 'Show archived conversations'"
          @click="toggleHistoryView"
        >
          <Archive :size="16" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button class="icon-button" aria-label="History actions" title="History actions"><Ellipsis :size="16" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem @select="selecting ? exitSelect() : (selecting = true)"><ListChecks :size="14" />{{ selecting ? 'Cancel selection' : 'Select sessions' }}</DropdownMenuItem>
            <DropdownMenuItem @select="pruneResult = ''; pruneOpen = true"><Trash2 :size="14" />Prune sessions</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div id="search-bar" :hidden="!history.searchOpen" v-if="!collapsed">
        <input dir="auto"
          id="search"
          ref="searchInputRef"
          v-model="history.query"
          type="text"
          placeholder="Search conversations..."
          aria-label="Search conversations"
          @keydown="handleSearchKeydown"
        />
      </div>

      <p id="history-status" role="status" class="text-destructive text-xs px-3 py-1" v-if="history.status && !ui.collapsed">
        {{ history.status }}
      </p>

      <div v-if="selecting && !collapsed" id="bulk-bar" class="flex flex-wrap items-center gap-1 px-3 py-1 text-xs" role="toolbar" aria-label="Bulk actions">
        <span class="text-muted-foreground mr-auto tabular-nums" role="status">{{ selected.size }} selected</span>
        <button class="icon-button" :title="selectAllLabel" :aria-label="selectAllLabel" @click="selectAllLoaded"><SquareCheck :size="16" /></button>
        <button class="icon-button" :disabled="!selected.size || bulkBusy" title="Generate titles" aria-label="Generate titles for selected" @click="runBulk('title')"><Sparkles :size="16" /></button>
        <button class="icon-button" :disabled="!selected.size || bulkBusy" title="Pin" aria-label="Pin selected" @click="runBulk('pin')"><Pin :size="16" /></button>
        <button class="icon-button" :disabled="!selected.size || bulkBusy" :title="history.archived ? 'Restore' : 'Archive'" :aria-label="(history.archived ? 'Restore' : 'Archive') + ' selected'" @click="runBulk(history.archived ? 'restore' : 'archive')"><Archive :size="16" /></button>
        <button class="icon-button" :disabled="!selected.size || bulkBusy" title="Delete" aria-label="Delete selected" @click="runBulk('delete')"><Trash2 :size="16" /></button>
        <button class="px-2 h-8 text-xs font-medium text-foreground hover:bg-sidebar-accent rounded-[var(--radius)] inline-flex items-center gap-1" title="Done" aria-label="Exit selection" @click="exitSelect"><X :size="14" />Done</button>
      </div>

      <p id="prune-status" role="status" class="text-muted-foreground text-xs px-3 py-1" v-if="pruneResult && !collapsed">{{ pruneResult }}</p>

      <!-- Open folder: fixed back bar and device filter. Search lists every folder, so it hides this bar. -->
      <div class="folder-head" v-if="!collapsed && openFolder && !searching">
        <div class="folder-bar">
          <button v-if="!single" id="history-back" class="icon-button" aria-label="All projects" title="All projects" @click="drill(null)"><ChevronLeft :size="16" /></button>
          <ProjectIcon :icon="openFolder.icon" :color="openFolder.color" :size="20" class="folder-icon" />
          <span class="flex min-w-0 flex-1 items-center gap-1.5">
            <span dir="auto" class="folder-name" style="flex: 0 1 auto" :title="openFolder.name">{{ openFolder.name }}</span>
            <Star v-if="openFolder.favorite" :size="12" fill="currentColor" class="group-star" aria-label="Favourite" />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="group-new" :aria-label="'Manage ' + openFolder.name" aria-haspopup="menu"><Ellipsis :size="14" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="appearanceProject = openFolder.project ?? 0"><Palette :size="14" />Appearance</DropdownMenuItem>
              <DropdownMenuItem v-if="openFolder.project !== null" @select="openProjectSettings(openFolder.project!)"><SettingsIcon :size="14" />Project settings</DropdownMenuItem>
              <DropdownMenuItem v-if="openFolder.project !== null" @select="toggleFavorite(openFolder.project!)"><Star :size="14" />{{ openFolder.favorite ? 'Unfavourite' : 'Favourite' }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            class="group-new"
            :aria-label="'New session in ' + openFolder.name + (deviceMachine ? ' on ' + deviceMachine.name : '')"
            :title="deviceMachine && !deviceMachine.online ? deviceMachine.name + ' is offline' : 'New session in ' + openFolder.name + (deviceMachine ? ' on ' + deviceMachine.name : '')"
            :disabled="!!deviceMachine && !deviceMachine.online"
            @click="handleNewChat(openFolder.project, deviceMachine?.id)"
          >
            <Plus :size="14" />
          </button>
        </div>
        <div v-if="machines.length" class="device-chips" role="group" aria-label="Machine">
          <button class="device-chip" :aria-pressed="device === 'all' ? 'true' : 'false'" @click="device = 'all'">All<span class="device-count">{{ openFolder.count }}</span></button>
          <button
            v-for="m in machines"
            :key="m.key"
            class="device-chip"
            :class="{ offline: !m.online }"
            :aria-pressed="device === m.key ? 'true' : 'false'"
            :disabled="machineCount(openFolder, m) === 0 && device !== m.key"
            :title="m.name + (m.online ? '' : ' (offline)') + (machineCount(openFolder, m) === 0 ? ': no sessions here' : '')"
            @click="device = m.key"
          >
            <span dir="auto" class="device-name">{{ m.name }}</span><span class="device-count">{{ machineCount(openFolder, m) }}</span>
          </button>
        </div>
        <p v-if="deviceMachine && !deviceMachine.online" class="folder-note">{{ deviceMachine.name }} is offline. You can read these sessions, but you cannot start new ones.</p>
      </div>

      <div id="sessions" v-if="!collapsed" class="relative" :class="{ 'session-window': openFolder || searching }">
        <div class="eyebrow px-3 py-1 text-xs font-semibold text-muted-foreground" v-if="history.archived">Archived</div>

        <div v-if="history.error" class="p-3 text-xs text-destructive flex flex-col gap-1.5" role="alert">
          <span>{{ history.error }}</span>
          <button class="self-start underline text-foreground hover:opacity-80" @click="loadSessions">Retry</button>
        </div>
        <span v-if="history.loading" class="absolute right-2 top-1 z-10 text-muted-foreground pointer-events-none" role="status" aria-label="Loading conversations" title="Loading conversations">
          <LoaderCircle :size="14" class="motion-safe:animate-spin" aria-hidden="true" />
        </span>

        <!-- Level 1: project folders -->
        <template v-if="!openFolder && !searching">
          <div
            v-for="f in folders"
            :key="f.key"
            class="folder-row"
            :data-project="f.key"
          >
            <button
              type="button"
              class="folder-open"
              :data-project="f.key"
              :aria-label="f.name + ', ' + f.count + ' conversations'"
              @click="drill(f.key)"
            >
              <span class="folder-title-row">
                <ProjectIcon :icon="f.icon" :color="f.color" :size="20" :align-label="f.name" class="folder-icon" />
                <span dir="auto" class="folder-title">{{ f.name }}</span>
                <Star v-if="f.favorite" :size="12" fill="currentColor" class="group-star" aria-label="Favourite" />
                <span class="folder-meta">
                  <span v-if="folderTime(f)" class="folder-time">{{ ago(folderTime(f)) }}</span>
                  <span v-for="state in folderStatuses(f)" :key="state.status" class="folder-status session-state" :data-status="state.status" :title="`${state.count} ${state.label}`" :aria-label="`${state.count} ${state.label}`" role="img">
                    <LoaderCircle v-if="['running', 'reviewing'].includes(state.status)" :size="12" class="motion-safe:animate-spin" aria-hidden="true" />
                    <span v-else class="session-state-dot" aria-hidden="true" />
                    <span aria-hidden="true">{{ state.count }}</span>
                  </span>
                </span>
              </span>
            </button>
            <span class="folder-trailing">
              <ChevronRight :size="14" class="folder-chevron" aria-hidden="true" />
              <button
                type="button"
                class="folder-quick-new group-new"
                :aria-label="'New session in ' + f.name"
                :title="folderQuickSessionTarget(f).disabledReason ?? ('New session in ' + f.name)"
                :disabled="!!folderQuickSessionTarget(f).disabledReason"
                @click="handleNewChat(f.project, folderQuickSessionTarget(f).worker)"
              >
                <Plus :size="14" />
              </button>
            </span>
          </div>
        </template>

        <!-- Level 2: sessions of the open folder, or search results across all folders -->
        <template v-else>
          <p v-if="history.rows.length === 0 && !history.loading && !history.error" class="muted px-3 py-2 text-sm">
            {{ searching ? "No matching conversations." : history.archived ? "No archived conversations here." : "Your conversations will appear here." }}
          </p>

          <div v-if="history.rows.length > 0" class="session-viewport" v-bind="sessionsContainerProps">
          <div class="group-body" v-bind="sessionsWrapperProps">
            <div v-for="{ data: s } in vSessions" :key="s.id" class="session-row" :class="{ pinned: s.pinned }" :data-session="s.id">
              <!-- Inline rename input -->
              <input dir="auto"
                v-if="renamingId === s.id"
                v-model="renameValue"
                type="text"
                class="session-rename"
                aria-label="Conversation name"
                maxlength="200"
                @keydown.enter="saveRename(s)"
                @keydown.escape="renamingId = null"
                @blur="saveRename(s)"
              />
              <!-- Normal session button -->
              <button
                v-else
                class="session-open"
                draggable="true"
                @dragstart="startSessionDrag($event, s.id)"
                @dragend="endSessionDrag"
                :class="{ on: String(s.id) === String(chat.session) }"
                :aria-current="String(s.id) === String(chat.session) ? 'page' : undefined"
                :aria-pressed="selecting ? (selected.has(String(s.id)) ? 'true' : 'false') : undefined"
                :aria-label="sessionTitle(s)"
                :title="sessionTitle(s) + (s.statusReason ? ' — ' + s.statusReason : '')"
                @click="selecting ? toggleSelect(s.id) : (setDrawer(false), openSession(s.id))"
              >
                <span v-if="selecting" class="session-pin" aria-hidden="true"><SquareCheck v-if="selected.has(String(s.id))" :size="14" /><Square v-else :size="14" /></span>
                <span class="session-pin" aria-hidden="true" v-if="s.pinned">
                  <Pin :size="12" />
                </span>
                <span class="session-copy">
                  <span dir="auto" class="session-title">{{ sessionTitle(s) }}</span>
                  <span v-if="sessionState(s) !== 'ready' || sessionMeta(s)" class="session-sub">
                    <span v-if="sessionState(s) !== 'ready'" class="session-status session-state" :data-status="sessionState(s)" :title="s.statusReason || (sessionState(s) === 'finished' ? 'Response finished. This does not verify task completion.' : sessionStatusLabel(s))">{{ sessionStatusLabel(s) }}</span>
                    <span v-if="sessionMeta(s)" dir="auto" class="session-meta" :class="{ offline: machineOf(s) && !machineOf(s)!.online }">{{ sessionMeta(s) }}</span>
                  </span>
                </span>
              </button>

              <span v-if="sessionState(s) !== 'ready'" class="session-running session-state" :data-status="sessionState(s)" :data-running="['running', 'reviewing'].includes(sessionState(s)) ? 'true' : undefined" role="img" :aria-label="sessionStatusLabel(s)" :title="s.statusReason || sessionStatusLabel(s)">
                <component
                  :is="sessionStatusIcon(sessionState(s))"
                  :size="14"
                  :class="{ 'motion-safe:animate-spin': ['running', 'reviewing'].includes(sessionState(s)) }"
                  aria-hidden="true"
                />
              </span>

              <button
                v-if="!selecting"
                class="session-manage icon-button"
                :aria-label="'Manage ' + sessionTitle(s)"
                aria-haspopup="menu"
                :aria-expanded="activeMenuSession?.id === s.id ? 'true' : 'false'"
                @click="(e) => openSessionMenu(s, e)"
              >
                <Ellipsis :size="16" />
              </button>
            </div>
          </div>

          <!-- Pagination follows the virtual spacer so it scrolls with the list. -->
          <div v-if="history.nextCursor" class="px-3 py-2 flex flex-col items-center">
            <button
              type="button"
              class="w-full py-1.5 px-3 text-xs rounded border border-border bg-transparent hover:bg-sidebar-accent text-sidebar-foreground disabled:opacity-50 flex items-center justify-center gap-1.5"
              :disabled="history.loading || history.loadingMore"
              @click="loadMoreSessions"
            >
              <LoaderCircle v-if="history.loadingMore" :size="12" class="motion-safe:animate-spin" />
              <span>{{ history.loadingMore ? "Loading more…" : "Load more" }}</span>
            </button>
          </div>
          </div>

        </template>
      </div>
    </section>

    <!-- Footer -->
    <div class="side-foot">
      <button class="side-item" data-panel="settings" title="Settings" :aria-current="ui.view === 'settings' ? 'page' : undefined" @click="openPanel('settings')">
        <SettingsIcon :size="16" />
        <span class="side-label">Settings</span>
      </button>
    </div>

    <!-- Resizer -->
    <div
      id="side-resize"
      role="separator"
      tabindex="0"
      aria-valuemin="200"
      aria-valuemax="480"
      :aria-valuenow="ui.sideWidth || 264"
      @pointerdown="onResizePointerDown"
      @keydown="onResizeKeydown"
      @dblclick="onResizeDblClick"
    ></div>

    <!-- Session Row Menu Popup -->
    <Teleport to="body"><div
      v-if="activeMenuSession"
      id="session-menu"
      role="menu"
      :style="{ top: menuPos.top + 'px', left: menuPos.left + 'px', position: 'fixed', zIndex: 1000 }"
    >
      <button
        role="menuitem"
        @click="handleMenuAction('pin', activeMenuSession)"
      >
        <Pin :size="14" />
        <span>{{ activeMenuSession.pinned ? 'Unpin' : 'Pin' }}</span>
      </button>
      <button
        role="menuitem"
        @click="handleMenuAction('rename', activeMenuSession)"
      >
        <Pencil :size="14" />
        <span>Rename</span>
      </button>
      <button
        role="menuitem"
        aria-live="polite"
        title="Copy the session id for logs, search, and API calls"
        @click="handleMenuAction('copy-id', activeMenuSession)"
      >
        <Check v-if="copyState === 'ok'" :size="14" />
        <Copy v-else :size="14" />
        <span>{{ copyState === 'ok' ? 'Copied' : copyState === 'fail' ? 'Copy failed' : 'Copy ID' }}</span>
      </button>
      <button
        role="menuitem"
        :disabled="!titleAvailable || titling"
        :title="titleAvailable ? undefined : 'Set a session-title or side-question model in Settings'"
        @click="handleMenuAction('title', activeMenuSession)"
      >
        <Sparkles :size="14" />
        <span>{{ titling ? 'Generating title…' : 'Generate title' }}</span>
      </button>
      <button role="menuitem" aria-haspopup="dialog" @click="moveTarget = activeMenuSession; closeMenu()">
        <FolderInput :size="14" />
        <span>Move to project</span>
      </button>
      <button
        role="menuitem"
        :disabled="activeMenuSession.running"
        @click="handleMenuAction('archive', activeMenuSession)"
      >
        <Archive :size="14" />
        <span>{{ activeMenuSession.archived ? 'Restore' : 'Archive' }}</span>
      </button>
      <button
        role="menuitem"
        class="danger"
        :disabled="activeMenuSession.running"
        @click="handleMenuAction('delete', activeMenuSession)"
      >
        <Trash2 :size="14" />
        <span>Delete</span>
      </button>
    </div></Teleport>
    <MoveSessionDialog v-if="moveTarget" :session="moveTarget" @close="moveTarget = null" />
    <ProjectAppearanceDialog v-if="appearanceProject !== null" :project-id="appearanceProject" @close="appearanceProject = null" />
    <PruneSessionsDialog v-if="pruneOpen" :project="openFolder?.project ? { id: openFolder.project, name: openFolder.name } : null" @close="pruneOpen = false" @deleted="message => pruneResult = message" />
  </aside>
</template>

<style scoped>
#sessions.session-window { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.session-viewport { flex: 1; min-height: 0; overflow-y: auto; }
</style>
