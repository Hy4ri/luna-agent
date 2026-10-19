<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { useMobile } from "@/lib/dom";
import { ui, toggleCollapsed, setSideWidth, openPanel, setDrawer } from "@/stores/app";
import { chat, openSession, newSession, clearConversation } from "@/stores/chat";
import { history, loadSessions, loadProjects, toggleGroup, sessionTitle, renameSession, togglePinned, toggleArchived, deleteSession } from "@/stores/sessions";

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

const filteredSessions = computed(() => {
  const q = history.query.trim().toLowerCase();
  return history.list.filter(s => !!s.archived === history.archived && sessionTitle(s).toLowerCase().includes(q));
});

const groups = computed(() => {
  const filtered = filteredSessions.value;
  if (history.projects.length === 0) {
    return [{ key: "none", name: "Chats", project: null, sessions: [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned)) }];
  }
  const result: { key: string; name: string; project: number | null; sessions: any[] }[] = [];
  const noneSessions = filtered.filter(s => !s.project || !history.projects.some(p => p.id === s.project));
  if (noneSessions.length > 0 || !history.query) {
    result.push({ key: "none", name: "Chats", project: null, sessions: noneSessions.sort((a, b) => Number(b.pinned) - Number(a.pinned)) });
  }
  for (const p of history.projects) {
    const pSessions = filtered.filter(s => Number(s.project) === Number(p.id));
    if (pSessions.length > 0 || !history.query) {
      result.push({ key: String(p.id), name: p.name, project: p.id, sessions: pSessions.sort((a, b) => Number(b.pinned) - Number(a.pinned)) });
    }
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
    try {
      await renameSession(s, t);
    } catch {}
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
  const rect = btn.getBoundingClientRect();
  menuPos.value = {
    top: Math.min(rect.top, window.innerHeight - 200),
    left: Math.min(rect.right + 4, window.innerWidth - 180),
  };
  void nextTick(() => document.querySelector<HTMLButtonElement>('#session-menu button:not(:disabled)')?.focus());
}

async function handleMenuAction(action: string, s: any) {
  if (action === 'delete') {
    if (await deleteSession(s)) closeMenu();
    return;
  }
  closeMenu();
  if (action === "pin") {
    try {
      await togglePinned(s);
    } catch {}
  } else if (action === "rename") {
    startRename(s);
  } else if (action === "archive") {
    try {
      await toggleArchived(s);
    } catch {}
  } else if (action === "delete") {
    await deleteSession(s);
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
        <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" class="text-primary"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
      </button>
      <button
        id="side-close"
        class="icon-button"
        aria-label="Close navigation"
        @click="setDrawer(false)"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </header>

    <!-- Nav Top -->
    <nav id="nav" class="side-top">
      <button id="new" title="New chat" class="side-item" @click="handleNewChat()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        <span class="side-label">New chat</span>
      </button>
      <button class="side-item" data-panel="cron" title="Cron" :aria-current="ui.view === 'cron' ? 'page' : undefined" @click="openPanel('cron')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span class="side-label">Cron</span>
        <span id="cron-unread" class="pill" :hidden="!ui.cronUnread">{{ ui.cronUnread }}</span>
      </button>
      <button class="side-item" data-panel="projects" title="Projects" @click="openPanel('projects')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span class="side-label">Projects</span>
      </button>
      <button class="side-item" data-panel="board" title="Board" @click="openPanel('board')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
      </button>

      <div class="history-head" v-if="!collapsed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
        <h2 id="history-title">History</h2>
        <button
          id="search-toggle"
          class="icon-button"
          :aria-expanded="history.searchOpen ? 'true' : 'false'"
          aria-controls="search-bar"
          aria-label="Search conversations"
          @click="toggleSearch"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <button
          id="history-view"
          class="icon-button"
          :aria-pressed="history.archived ? 'true' : 'false'"
          :aria-label="history.archived ? 'Show active conversations' : 'Show archived conversations'"
          @click="toggleHistoryView"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect width="22" height="5" x="1" y="3"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
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
            <button
              class="group-toggle"
              :aria-expanded="!isGroupCollapsed(g.key) ? 'true' : 'false'"
              :aria-controls="'group-' + g.key"
              @click="toggleGroup(g.key)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="transition-transform" :class="{ 'rotate-90': !isGroupCollapsed(g.key) }"><polyline points="9 18 15 12 9 6"/></svg>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="group-name">{{ g.name }}</span>
              <span class="group-count ml-auto text-xs text-muted-foreground">{{ g.sessions.length }}</span>
            </button>

            <div :id="'group-' + g.key" class="group-body" :class="{ hidden: isGroupCollapsed(g.key) }">
              <button
                class="group-new"
                :aria-label="'New session in ' + g.name"
                @click="handleNewChat(g.project)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
                <span>New session</span>
              </button>

              <template v-for="s in g.sessions" :key="s.id">
                <div class="session-row" :class="{ pinned: s.pinned }" :data-session="s.id">
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
                    :class="{ on: String(s.id) === String(chat.session) }"
                    :aria-current="String(s.id) === String(chat.session) ? 'page' : undefined"
                    :title="sessionTitle(s)"
                    @click="setDrawer(false); openSession(s.id)"
                  >
                    <span class="session-pin" aria-hidden="true" v-if="s.pinned">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
                    </span>
                    <span>{{ sessionTitle(s) }}</span>
                  </button>

                  <span class="session-running muted" data-running="true" aria-label="Running" v-if="s.running">Running</span>

                  <button
                    class="session-manage icon-button"
                    :aria-label="'Manage ' + sessionTitle(s)"
                    aria-haspopup="menu"
                    :aria-expanded="activeMenuSession?.id === s.id ? 'true' : 'false'"
                    @click="(e) => openSessionMenu(s, e)"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
        <span>{{ activeMenuSession.pinned ? 'Unpin' : 'Pin' }}</span>
      </button>
      <button
        role="menuitem"
        @click="handleMenuAction('rename', activeMenuSession)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        <span>Rename</span>
      </button>
      <button
        role="menuitem"
        :disabled="activeMenuSession.running"
        @click="handleMenuAction('archive', activeMenuSession)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect width="22" height="5" x="1" y="3"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
        <span>{{ activeMenuSession.archived ? 'Restore' : 'Archive' }}</span>
      </button>
      <button
        role="menuitem"
        class="danger"
        :disabled="activeMenuSession.running"
        @click="handleMenuAction('delete', activeMenuSession)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        <span>Delete</span>
      </button>
    </div></Teleport>
  </aside>
</template>
