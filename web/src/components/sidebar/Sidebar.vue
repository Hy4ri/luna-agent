<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import {
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Plus,
  Clock,
  FolderKanban,
  Kanban,
  History as HistoryIcon,
  Search,
  Archive,
  ChevronRight,
  Pin,
  Ellipsis,
  Pencil,
  Sparkles,
  Trash2,
  Settings as SettingsIcon,
  LoaderCircle,
  Command as CommandIcon,
} from "@lucide/vue";
import { useMobile } from "@/lib/dom";
import { ui, toggleCollapsed, setSideWidth, openPanel, setDrawer, setPalette } from "@/stores/app";
import { chat, openSession, newSession, clearConversation } from "@/stores/chat";
import { history, loadSessions, loadProjects, toggleGroup, sessionTitle, renameSession, generateTitle, titleModelAvailable, togglePinned, toggleArchived, deleteSession } from "@/stores/sessions";
import { startSessionDrag, endSessionDrag } from "@/lib/pane";
import { sessionState, sessionStatusLabel } from "@/lib/session-status";

const mobile = useMobile();
const collapsed = computed(() => ui.collapsed && !mobile.value);
defineProps<{ inert?: boolean }>();

const searchInputRef = ref<HTMLInputElement | null>(null);
const renameInputRef = ref<HTMLInputElement | null>(null);
const renamingId = ref<string | number | null>(null);
const renameValue = ref("");

const activeMenuSession = ref<any | null>(null);
const activeMenuBtnEl = ref<HTMLElement | null>(null);
const menuPos = ref({ top: 0, left: 0 });
const titleAvailable = ref(false);
const titling = ref(false);

const filteredSessions = computed(() => {
  const q = history.query.trim().toLowerCase();
  return history.list.filter(s => !!s.archived === history.archived && sessionTitle(s).toLowerCase().includes(q));
});

function sortSessions(sessions: any[]) {
  return [...sessions].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) {
      return Number(b.pinned) - Number(a.pinned);
    }
    const timeB = b.lastActivity ?? b.createdAt ?? 0;
    const timeA = a.lastActivity ?? a.createdAt ?? 0;
    if (timeB !== timeA) {
      return timeB - timeA;
    }
    return Number(b.id) - Number(a.id);
  });
}

const groups = computed(() => {
  const filtered = filteredSessions.value;
  if (history.projects.length === 0) {
    return [{ key: "none", name: "Chats", project: null, sessions: sortSessions(filtered) }];
  }
  const result: { key: string; name: string; project: number | null; sessions: any[] }[] = [];

  for (const p of history.projects.filter(p => !p.general)) {
    const pSessions = filtered.filter(s => Number(s.project) === Number(p.id));
    if (pSessions.length > 0 || !history.query) {
      result.push({ key: String(p.id), name: p.name, project: p.id, sessions: sortSessions(pSessions) });
    }
  }

  const noneSessions = filtered.filter(s => !s.project || !history.projects.some(p => !p.general && p.id === s.project));
  if (noneSessions.length > 0 || !history.query) {
    result.push({ key: "none", name: "Chats", project: null, sessions: sortSessions(noneSessions) });
  }

  return result;
});

function isGroupCollapsed(key: string): boolean {
  return !!history.collapsedGroups[key];
}

async function handleNewChat(projectId?: number | string | null) {
  try {
    const id = await newSession(projectId);
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
  }
}

function handleSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    history.searchOpen = false;
    history.query = "";
  }
}

function toggleHistoryView() {
  toggleArchivedView(!history.archived);
}

function toggleArchivedView(archived: boolean) {
  history.archived = archived;
  loadSessions().catch(e => { history.status = (e as Error).message; });
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
  void titleModelAvailable().then(ok => { if (activeMenuSession.value?.id === s.id) titleAvailable.value = ok; });
  const rect = btn.getBoundingClientRect();
  menuPos.value = {
    top: Math.min(rect.top, window.innerHeight - 240),
    left: Math.min(rect.right + 4, window.innerWidth - 180),
  };
  void nextTick(() => document.querySelector<HTMLButtonElement>('#session-menu button:not(:disabled)')?.focus());
}

async function handleMenuAction(action: string, s: any) {
  if (action === "pin") {
    await togglePinned(s);
    closeMenu();
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
}
function outsideMenu(e: PointerEvent) {
  if (activeMenuSession.value && !(e.target as Element).closest('#session-menu,.session-manage')) closeMenu();
}
function menuKey(e: KeyboardEvent) {
  if (!activeMenuSession.value) return;
  if (e.key === 'Escape') { e.stopImmediatePropagation(); closeMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...document.querySelectorAll<HTMLButtonElement>('#session-menu button:not(:disabled)')];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}
onUnmounted(() => { document.removeEventListener('pointerdown', outsideMenu); document.removeEventListener('keydown', menuKey, true); });
onMounted(() => {
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
        <Moon :size="20" class="text-primary" aria-hidden="true" />
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
      <button id="new" title="New chat" class="side-item" @click="handleNewChat()">
        <Plus :size="18" />
        <span class="side-label">New chat</span>
      </button>
      <button id="open-palette" class="side-item" title="Commands (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K" @click="setDrawer(false); setPalette(true)">
        <CommandIcon :size="18" />
        <span class="side-label">Commands</span>
        <kbd class="side-kbd">Ctrl K</kbd>
      </button>
      <button class="side-item" data-panel="cron" title="Cron" :aria-current="ui.view === 'cron' ? 'page' : undefined" @click="openPanel('cron')">
        <Clock :size="18" />
        <span class="side-label">Cron</span>
        <span id="cron-unread" class="pill" :hidden="!ui.cronUnread">{{ ui.cronUnread }}</span>
      </button>
      <button class="side-item" data-panel="projects" title="Projects" @click="openPanel('projects')">
        <FolderKanban :size="18" />
        <span class="side-label">Projects</span>
      </button>
      <button class="side-item" data-panel="board" title="Board" @click="openPanel('board')">
        <Kanban :size="18" />
        <span class="side-label">Board</span>
      </button>
    </nav>

    <!-- History Section -->
    <section class="history">
      <button
        id="history-rail"
        class="side-item"
        aria-label="Show history"
        @click="toggleCollapsed"
      >
        <HistoryIcon :size="18" />
      </button>

      <div class="history-head" v-if="!collapsed">
        <HistoryIcon :size="16" />
        <h2 id="history-title">History</h2>
        <button
          id="search-toggle"
          class="icon-button"
          :aria-expanded="history.searchOpen ? 'true' : 'false'"
          aria-controls="search-bar"
          aria-label="Search conversations"
          @click="toggleSearch"
        >
          <Search :size="16" />
        </button>
        <button
          id="history-view"
          class="icon-button"
          :aria-pressed="history.archived ? 'true' : 'false'"
          :aria-label="history.archived ? 'Show active conversations' : 'Show archived conversations'"
          @click="toggleHistoryView"
        >
          <Archive :size="16" />
        </button>
      </div>

      <div id="search-bar" :hidden="!history.searchOpen" v-if="!collapsed">
        <input
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

      <div id="sessions" v-if="!collapsed">
        <div class="eyebrow px-3 py-1 text-xs font-semibold text-muted-foreground" v-if="history.archived">Archived</div>

        <template v-if="groups.length === 0 || groups.every(g => g.sessions.length === 0)">
          <p class="muted px-3 py-2 text-sm">
            {{ history.query ? "No matching conversations." : history.archived ? "No archived conversations." : "Your conversations will appear here." }}
          </p>
        </template>

        <template v-for="g in groups" :key="g.key">
          <div class="session-group" :data-project="g.key">
            <div class="group-header">
              <button
                class="group-toggle"
                :aria-expanded="!isGroupCollapsed(g.key) ? 'true' : 'false'"
                :aria-controls="'group-' + g.key"
                @click="toggleGroup(g.key)"
              >
                <ChevronRight :size="14" class="transition-transform" :class="{ 'rotate-90': !isGroupCollapsed(g.key) }" />
                <FolderKanban :size="14" />
                <span class="group-name">{{ g.name }}</span>
              </button>
              <button
                class="group-new"
                :aria-label="'New session in ' + g.name"
                :title="'New session in ' + g.name"
                @click="handleNewChat(g.project)"
              >
                <Plus :size="14" />
              </button>
            </div>

            <div :id="'group-' + g.key" class="group-body">
              <template v-for="s in g.sessions" :key="s.id">
                <div v-show="!isGroupCollapsed(g.key) || s.pinned || !['ready', 'stopped'].includes(sessionState(s))" class="session-row" :class="{ pinned: s.pinned }" :data-session="s.id">
                  <!-- Inline rename input -->
                  <input
                    v-if="renamingId === s.id"
                    ref="renameInputRef"
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
                    :aria-label="sessionTitle(s)"
                    :title="sessionTitle(s) + (s.statusReason ? ' — ' + s.statusReason : '')"
                    @click="setDrawer(false); openSession(s.id)"
                  >
                    <span class="session-pin" aria-hidden="true" v-if="s.pinned">
                      <Pin :size="12" />
                    </span>
                    <span class="session-copy">
                      <span class="session-title">{{ sessionTitle(s) }}</span>
                      <span v-if="sessionState(s) !== 'ready'" class="session-status session-state" :data-status="sessionState(s)" :title="s.statusReason || (sessionState(s) === 'finished' ? 'Response finished. This does not verify task completion.' : sessionStatusLabel(s))">{{ sessionStatusLabel(s) }}</span>
                    </span>
                  </button>

                  <span v-if="sessionState(s) !== 'ready'" class="session-running session-state" :data-status="sessionState(s)" :data-running="sessionState(s) === 'running' ? 'true' : undefined" role="img" :aria-label="sessionStatusLabel(s)" :title="s.statusReason || sessionStatusLabel(s)">
                    <LoaderCircle v-if="sessionState(s) === 'running'" :size="14" class="motion-safe:animate-spin" />
                    <span v-else class="session-state-dot" aria-hidden="true"></span>
                  </span>

                  <button
                    class="session-manage icon-button"
                    :aria-label="'Manage ' + sessionTitle(s)"
                    aria-haspopup="menu"
                    :aria-expanded="activeMenuSession?.id === s.id ? 'true' : 'false'"
                    @click="(e) => openSessionMenu(s, e)"
                  >
                    <Ellipsis :size="16" />
                  </button>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- Footer -->
    <div class="side-foot">
      <button class="side-item" data-panel="settings" title="Settings" :aria-current="ui.view === 'settings' ? 'page' : undefined" @click="openPanel('settings')">
        <SettingsIcon :size="18" />
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
        :disabled="!titleAvailable || titling"
        :title="titleAvailable ? undefined : 'Set a session-title or side-question model in Settings'"
        @click="handleMenuAction('title', activeMenuSession)"
      >
        <Sparkles :size="14" />
        <span>{{ titling ? 'Generating title…' : 'Generate title' }}</span>
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
  </aside>
</template>
