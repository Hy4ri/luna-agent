<script setup lang="ts">
import ConnectionRecovery from "@/components/ConnectionRecovery.vue";
import ConfigError from "@/components/ConfigError.vue";
import MachineStatus from "@/components/chat/MachineStatus.vue";
import { ref, computed, defineAsyncComponent, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { ArrowLeft, Menu, ScanEye, SquareTerminal, Ellipsis, Moon, Plus, Pin, PinOff, Heart, X, ArrowLeftRight, MoveHorizontal } from '@lucide/vue';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { TooltipProvider } from '@/components/ui/tooltip';
import GitStatus from '@/components/chat/GitStatus.vue';
import ProjectIcon from '@/components/ProjectIcon.vue';
import Sidebar from '@/components/sidebar/Sidebar.vue';
import Transcript from '@/components/chat/Transcript.vue';
import ReviewInspector from "@/components/chat/ReviewInspector.vue";
import Extras from '@/components/chat/Extras.vue';
import StatusBar from '@/components/chat/StatusBar.vue';
import Composer from '@/components/composer/Composer.vue';
import PanelHost from '@/components/panels/PanelHost.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ImageViewer from '@/components/ui/ImageViewer.vue';
import SnapTool from '@/components/SnapTool.vue';
import { browser, loadBrowser } from '@/stores/browser';
const AnalyticsPage = defineAsyncComponent(() => import('@/pages/AnalyticsPage.vue'));
const WifePage = defineAsyncComponent(() => import('@/pages/WifePage.vue'));
const SourceControlPage = defineAsyncComponent(() => import('@/pages/SourceControlPage.vue'));
const SettingsPage = defineAsyncComponent(() => import('@/pages/SettingsPage.vue'));
// The terminal emulator (ghostty-web, ~400 kB) loads only when a terminal opens.
const TerminalDock = defineAsyncComponent(() => import('@/components/terminal/TerminalDock.vue'));
const BrowserPane = defineAsyncComponent(() => import('@/components/browser/BrowserPane.vue'));
// The palette (and the full settings catalog it searches) loads on the first Ctrl+K, then stays mounted.
const CommandPalette = defineAsyncComponent(() => import('@/components/CommandPalette.vue'));
const paletteUsed = ref(false);
watch(() => ui.palette, open => { if (open) paletteUsed.value = true; }, { immediate: true });
import { recoveryOpen } from '@/lib/connections';
import { isDesktop, serverUrl } from '@/lib/api';
import { ui, boot, login, setDrawer, closePanel, openPanel, setPalette, navigate } from '@/stores/app';
import { askWife } from '@/stores/wife';
import { terminal, loadTerminals, toggleTerminal } from '@/stores/terminal';
import { dock, effectivePosition } from '@/stores/dock';
import { chat, newSession, openSession, clearConversation, addErr, reviewJobs, runningReviews, activityVisible, contextView, usageText } from '@/stores/chat';
import { history, cancelLimitWait, resumeLabel, sessionTitle, togglePinned } from '@/stores/sessions';
import { sessionPane, sessionDragType, draggedSession, endSessionDrag, setSessionRouter, closeSessionPane } from '@/lib/pane';
import { sessionState, sessionStatusLabel } from '@/lib/session-status';
import { useMobile } from '@/lib/dom';
import { trackViewport } from '@/lib/viewport';

const mobile = useMobile();
const mobileMenuOpen = ref(false);
watch([mobile, () => chat.session, () => ui.view], () => { mobileMenuOpen.value = false; });
function mobileAction(action: () => unknown) {
  mobileMenuOpen.value = false;
  action();
}
// Session rail (#88): dock goal, activity, and context to the right when this tile has room.
// Measure the tile, not the window: split view gives each tile its own width.
// Two thresholds prevent flicker near the boundary.
const RAIL_DOCK_AT = 1120, RAIL_UNDOCK_BELOW = 1080;
const mainRef = ref<HTMLElement | null>(null);
const railRoom = ref(false);
let railObserver: ResizeObserver | undefined;
const selectedReview = ref<string | null>(null);
const reviewJob = computed(() => reviewJobs.value.find(j => j.id === selectedReview.value) || null);
watch(() => chat.session, () => { selectedReview.value = null; });
// The dock follows the loaded session; the server keeps each session's shells alive.
watch(() => chat.session, id => { void loadTerminals(id || ''); void loadBrowser(id || ''); }, { immediate: true });
const railContent = computed(() => !!chat.session || reviewJobs.value.length > 0 || !!chat.extras?.goal || activityVisible.value || !!contextView.value || !!usageText.value);
// A side dock takes the rail's place, so the rail folds into the header while the dock is on the right.
const docked = computed(() => railRoom.value && railContent.value && !dockSide.value);
// The native chat remains mounted when its tile is removed. Surviving iframe
// tiles are never promoted/remounted, so their attachments and live views stay intact.
const tileIds = ref<string[]>(readTiles());
function readTiles(): string[] {
  if (sessionPane) return [];
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem('luna.tiles') || '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id) && id !== chat.session))].slice(0, 2) : [];
  } catch { return []; }
}
watch(tileIds, ids => { if (!sessionPane) sessionStorage.setItem('luna.tiles', JSON.stringify(ids)); }, { deep: true });
// The dock sits beside the chat only when the chat area is wide enough; dock.area is the width of the whole work area.
const workAreaRef = ref<HTMLElement | null>(null);
const dockSide = computed(() => !!terminal.open && !!chat.session && !sessionPane && effectivePosition(dock.position, dock.area) === 'right');
let areaObserver: ResizeObserver | undefined;
watch(workAreaRef, el => {
  areaObserver?.disconnect();
  if (!el) return;
  dock.area = el.clientWidth;
  areaObserver = new ResizeObserver(() => { dock.area = el.clientWidth; });
  areaObserver.observe(el);
}, { flush: 'post' });
onUnmounted(() => areaObserver?.disconnect());
const showPrimary = computed(() => sessionPane || !!chat.session || chat.draftOpen || tileIds.value.length === 0);
const tileCount = computed(() => (chat.session || chat.draftOpen ? 1 : 0) + tileIds.value.length);
const tiled = computed(() => !sessionPane && tileCount.value > 1);
// A lone surviving iframe tile becomes the normal single view.
watch([() => chat.session, () => chat.draftOpen, () => tileIds.value.length], () => {
  if (sessionPane || chat.session || chat.draftOpen || tileIds.value.length !== 1) return;
  const [id] = tileIds.value; tileIds.value = []; void openSession(id);
});
// Focused tile gets a thin border. Frames take focus away from this window, so check activeElement on blur.
const focusedTile = ref<string>('primary');
function syncFocus() {
  const el = document.activeElement;
  if (el instanceof HTMLIFrameElement && el.dataset.tileSession) focusedTile.value = el.dataset.tileSession;
}
function onWindowBlur() { setTimeout(syncFocus, 0); }
const focusClass = (id: string) => tiled.value && focusedTile.value === id ? 'tile-focused' : '';
// Tile order and size. Order uses CSS `order`, so reordering never remounts a frame.
const rank = ref<Record<string, number>>({});
const weight = ref<Record<string, number>>({});
const visible = computed(() => {
  const ids = [...(showPrimary.value ? ['primary'] : []), ...tileIds.value];
  return ids.map((id, i) => ({ id, i })).sort((a, b) => (rank.value[a.id] ?? 100 + a.i) - (rank.value[b.id] ?? 100 + b.i)).map(t => t.id);
});
function tileStyle(id: string) {
  const pos = Math.max(0, visible.value.indexOf(id));
  return sessionPane ? {} : { order: pos * 2, flexGrow: weight.value[id] ?? 1 };
}
function swapTiles(index: number) {
  const ids = [...visible.value];
  [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
  ids.forEach((id, i) => { rank.value[id] = i; });
}
// Hover for half a second before the split controls show.
const splitHover = ref<number | null>(null);
let splitTimer: ReturnType<typeof setTimeout> | undefined;
let resizing = false;
function splitEnter(index: number) {
  clearTimeout(splitTimer);
  splitTimer = setTimeout(() => { splitHover.value = index; }, 500);
}
function splitLeave() {
  clearTimeout(splitTimer);
  if (!resizing) splitHover.value = null;
}
function resetSplit(index: number) {
  weight.value[visible.value[index]] = 1; weight.value[visible.value[index + 1]] = 1;
}
function resizeKey(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault(); resetSplit(index); return;
  }
  const vertical = getComputedStyle((event.currentTarget as HTMLElement).closest('.chat-workspace')!).flexDirection === 'column';
  const backward = vertical ? 'ArrowUp' : 'ArrowLeft', forward = vertical ? 'ArrowDown' : 'ArrowRight';
  if (event.key !== backward && event.key !== forward) return;
  event.preventDefault();
  const [a, b] = [visible.value[index], visible.value[index + 1]];
  const pair = (weight.value[a] ?? 1) + (weight.value[b] ?? 1);
  const share = Math.max(.15, Math.min(.85, (weight.value[a] ?? 1) / pair + (event.key === forward ? .05 : -.05)));
  weight.value[a] = pair * share; weight.value[b] = pair * (1 - share);
}
function startResize(event: PointerEvent, index: number) {
  const handle = event.currentTarget as HTMLElement;
  const [a, b] = [visible.value[index], visible.value[index + 1]];
  const els = [a, b].map(id => id === 'primary' ? document.getElementById('main') : tileFrame(id));
  if (!els[0] || !els[1]) return;
  const vertical = getComputedStyle(handle.closest('.chat-workspace') as Element).flexDirection === 'column';
  const size = (el: Element) => vertical ? el.getBoundingClientRect().height : el.getBoundingClientRect().width;
  const sa = size(els[0]), total = sa + size(els[1]);
  const pair = (weight.value[a] ?? 1) + (weight.value[b] ?? 1);
  const start = vertical ? event.clientY : event.clientX;
  resizing = true;
  handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const share = Math.min(0.85, Math.max(0.15, (sa + (vertical ? e.clientY : e.clientX) - start) / total));
    weight.value[a] = pair * share; weight.value[b] = pair * (1 - share);
  };
  const end = () => {
    resizing = false; splitHover.value = null;
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
const dropMessage = computed(() => {
  if (chat.session === draggedSession.value || tileIds.value.includes(draggedSession.value || '')) return 'Session already tiled';
  return tileCount.value >= 3 ? 'Maximum 3 sessions' : 'Drop to tile session';
});
function paneUrl(id: string) {
  const url = new URL(location.href);
  url.search = ''; url.hash = '';
  url.searchParams.set('pane', 'session'); url.searchParams.set('session', id);
  return url.href;
}
function tileFrame(id: string) {
  return document.querySelector<HTMLIFrameElement>(`iframe[data-tile-session="${id}"]`);
}
function focusTile(id: string) {
  void nextTick(() => {
    if (chat.session === id) document.getElementById('input')?.focus();
    else tileFrame(id)?.contentDocument?.getElementById('input')?.focus();
  });
}
if (!sessionPane) setSessionRouter(id => {
  if (chat.session === id || tileIds.value.includes(id)) {
    focusedTile.value = chat.session === id ? 'primary' : id;
    focusTile(id); return true;
  }
  const previous = focusedTile.value;
  const index = tileIds.value.indexOf(previous);
  if (index < 0) return false;
  // Replace only the bordered tile; preserve its position and size.
  if (rank.value[previous] !== undefined) rank.value[id] = rank.value[previous];
  if (weight.value[previous] !== undefined) weight.value[id] = weight.value[previous];
  delete rank.value[previous];
  delete weight.value[previous];
  tileIds.value.splice(index, 1, id);
  focusedTile.value = id;
  focusTile(id); return true;
});
function removeTile(id: string) {
  tileIds.value = tileIds.value.filter(tile => tile !== id);
}
function openNavigation() {
  if (sessionPane) window.parent.postMessage({ type: 'luna:open-navigation' }, location.origin);
  else setDrawer(true);
}
// An edge-only gesture leaves normal transcript selection and horizontal content alone.
const SWIPE_EDGE = 32, SWIPE_DISTANCE = 64, SWIPE_SLOP = 12, SWIPE_TIMEOUT = 700;
let navigationSwipe: { id: number; x: number; y: number; started: number } | null = null;
function canSwipeNavigation() {
  return mobile.value && !ui.login && !ui.panel && !ui.palette && !ui.drawer
    && !document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]');
}
function cancelNavigationSwipe() { navigationSwipe = null; }
function startNavigationSwipe(event: TouchEvent) {
  cancelNavigationSwipe();
  if (!canSwipeNavigation() || event.touches.length !== 1) return;
  const touch = event.touches[0];
  if (touch.clientX < 0 || touch.clientX > SWIPE_EDGE) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('button, a, input, textarea, select, [contenteditable], [role="slider"], [role="dialog"], [role="alertdialog"]')) return;
  // Do not take a gesture from an independently scrollable horizontal surface.
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return;
  }
  navigationSwipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, started: performance.now() };
}
function moveNavigationSwipe(event: TouchEvent) {
  const swipe = navigationSwipe;
  if (!swipe) return;
  const touch = [...event.touches].find(t => t.identifier === swipe.id);
  if (!canSwipeNavigation() || event.touches.length !== 1 || !touch
    || performance.now() - swipe.started > SWIPE_TIMEOUT
    || touch.clientX < swipe.x - SWIPE_SLOP
    || Math.abs(touch.clientY - swipe.y) > SWIPE_SLOP) cancelNavigationSwipe();
}
function endNavigationSwipe(event: TouchEvent) {
  const swipe = navigationSwipe;
  cancelNavigationSwipe();
  if (!swipe || !canSwipeNavigation() || event.touches.length) return;
  const touch = [...event.changedTouches].find(t => t.identifier === swipe.id);
  if (touch && performance.now() - swipe.started <= SWIPE_TIMEOUT
    && touch.clientX - swipe.x >= SWIPE_DISTANCE
    && Math.abs(touch.clientY - swipe.y) <= SWIPE_SLOP) openNavigation();
}
function closeTile() {
  if (sessionPane) closeSessionPane();
  else clearConversation();
}
function dragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes(sessionDragType)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = dropMessage.value === 'Drop to tile session' ? 'copy' : 'none';
}
function dropSession(event: DragEvent) {
  const id = event.dataTransfer?.getData(sessionDragType);
  endSessionDrag();
  if (!id || !history.list.some(s => String(s.id) === id)) return;
  event.preventDefault();
  if (chat.session === id || tileIds.value.includes(id)) { focusTile(id); return; }
  if (tileCount.value >= 3) return;
  if (!chat.session) void openSession(id);
  else tileIds.value.push(id);
  setDrawer(false);
}
function paneMessage(event: MessageEvent) {
  if (sessionPane || event.origin !== location.origin) return;
  const id = tileIds.value.find(id => tileFrame(id)?.contentWindow === event.source);
  if (!id) return;
  if (event.data?.type === 'luna:close-tile') removeTile(id);
  if (event.data?.type === 'luna:open-navigation') { focusedTile.value = id; setDrawer(true); }
  if (event.data?.type === 'luna:open-session' && typeof event.data.session === 'string' && /^\d+$/.test(event.data.session)) {
    focusedTile.value = id;
    void openSession(event.data.session);
  }
}
const activeSession = computed(() => history.list.find(row => String(row.id) === chat.session));
const pinPending = ref(false);
async function pinSession() {
  const session = activeSession.value;
  if (!session || pinPending.value) return;
  pinPending.value = true;
  const epoch = chat.epoch;
  try {
    const ok = await togglePinned(session);
    if (!ok && epoch === chat.epoch) addErr(history.status || 'Failed to update session pin');
  } finally { pinPending.value = false; }
}
const askPending = ref(false);
async function askWifeAboutSession() {
  const session = activeSession.value;
  if (!session || askPending.value) return;
  askPending.value = true;
  try {
    const r = await askWife(session.id);
    if (r.error) addErr(r.error);
    else if (!r.matched) addErr('Wife has no suggestions about this session.', 'muted');
    else navigate('wife');
  } finally { askPending.value = false; }
}
const password = ref('');
const serverInput = ref(serverUrl.value || 'localhost:8787');
const connectionDialogOpen = computed(() => !sessionPane && recoveryOpen.value);
const blocked = computed(() => connectionDialogOpen.value || ui.login || !!ui.panel || (mobile.value && ui.drawer));

const activeProject = computed(() => {
  if (chat.session) {
    const active = history.list.find(row => String(row.id) === chat.session);
    return active ? active.project ?? null : chat.project;
  }
  if (!chat.session) {
    if (chat.project !== null) return chat.project;
    const saved = localStorage.getItem('luna.project');
    if (saved !== null && saved !== '' && !isNaN(Number(saved))) {
      const num = Number(saved);
      if (history.projects.some(p => p.id === num)) return num;
    }
  }
  return null;
});

/** Project shown in the chat header: the open session's project (or draft), else the general "Chats" project for sessions without one. */
const headerProject = computed(() => {
  const id = activeProject.value;
  return (id !== null ? history.projects.find(p => p.id === id) : undefined) ?? history.projects.find(p => p.general);
});

const newSessionPending = ref(false);

async function handleNewSession() {
  if (newSessionPending.value) return;
  newSessionPending.value = true;
  try {
    const worker = chat.session ? chat.machine?.id ?? null : chat.draftOpen ? chat.draftWorker : undefined;
    await newSession(activeProject.value, worker);
    await nextTick();
    document.getElementById('input')?.focus();
  } catch (e: any) {
    addErr(e?.message || 'Failed to create new session');
  } finally {
    newSessionPending.value = false;
  }
}

function keyboard(e: KeyboardEvent) {
  // Local controls and managed dialogs own their keys before the shell does.
  if (e.defaultPrevented || e.isComposing || connectionDialogOpen.value) return;
  const managedOverlay = document.querySelector('[data-dismissable-layer][data-state="open"]');
  const nativePopover = [...document.querySelectorAll<HTMLElement>(':popover-open')].at(-1);
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !ui.login && !sessionPane && (!managedOverlay || ui.palette) && !nativePopover) {
    e.preventDefault();
    setPalette(!ui.palette);
    return;
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote' && !ui.login && !sessionPane && chat.session && ui.view === 'chat' && !managedOverlay && !nativePopover) {
    e.preventDefault();
    void toggleTerminal();
    return;
  }
  // Reka handles Escape on window, after this document listener.
  if (ui.palette || managedOverlay) return;
  if (nativePopover) {
    if (e.key === 'Escape') {
      e.preventDefault();
      nativePopover.hidePopover();
      document.querySelector<HTMLElement>(`[popovertarget="${CSS.escape(nativePopover.id)}"]`)?.focus();
    }
    return;
  }
  if (e.key === 'Escape') {
    if ((e.target as HTMLElement | null)?.closest('select')) return;
    if (ui.panel) { e.preventDefault(); closePanel(); }
    else if (ui.drawer) { e.preventDefault(); setDrawer(false); }
    else if (ui.view !== 'chat') { e.preventDefault(); navigate('chat'); }
    return;
  }
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
  const unfocused = document.activeElement === document.body || document.activeElement === document.documentElement;
  if (!e.shiftKey && unfocused && ui.view === 'chat' && !blocked.value && !ui.drawer) {
    const input = document.getElementById('input');
    if (input && !input.closest('[inert]') && input.getClientRects().length) {
      e.preventDefault(); input.focus(); return;
    }
  }
  const root = ui.login ? document.getElementById('login') : ui.panel ? document.querySelector('#panel [role="dialog"]') : mobile.value && ui.drawer ? document.getElementById('side') : ui.view !== 'chat' ? document.querySelector('.settings-window') : null;
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex]')].filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const first = items[0], last = items.at(-1);
  if (!first) return;
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}
watch(() => ui.view, view => {
  if (view !== 'chat') void nextTick(() => document.querySelector<HTMLElement>('.settings-window')?.focus());
});
watch(mobile, value => { if (!value && ui.drawer) setDrawer(false); });
watch(() => ui.login, value => { if (value) void nextTick(() => { if (!recoveryOpen.value) document.getElementById('token')?.focus(); }); });
let stopViewport: (() => void) | undefined;
onMounted(() => {
  if (mainRef.value && typeof ResizeObserver !== 'undefined') {
    railObserver = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width >= RAIL_DOCK_AT) railRoom.value = true;
      else if (width < RAIL_UNDOCK_BELOW) railRoom.value = false;
    });
    railObserver.observe(mainRef.value);
  }
  stopViewport = trackViewport(document.getElementById('app')!);
  document.addEventListener('keydown', keyboard);
  window.addEventListener('message', paneMessage);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('dragend', endSessionDrag);
  void boot();
});
onUnmounted(() => {
  railObserver?.disconnect();
  stopViewport?.(); document.removeEventListener('keydown', keyboard);
  window.removeEventListener('message', paneMessage);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('dragend', endSessionDrag);
  if (!sessionPane) setSessionRouter();
});
</script>

<template>
  <TooltipProvider>
    <div class="flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground"
      @touchstart.passive="startNavigationSwipe" @touchmove.passive="moveNavigationSwipe"
      @touchend.passive="endNavigationSwipe" @touchcancel.passive="cancelNavigationSwipe">
      <Sidebar v-if="!sessionPane" :inert="connectionDialogOpen || ui.login || !!ui.panel || (ui.view !== 'chat' && !(mobile && ui.drawer))" />
      <div v-if="mobile && ui.drawer" id="shade" class="fixed inset-0 z-30 bg-black/60" @click="setDrawer(false)" />
      <div id="chat-workspace" :inert="blocked || ui.view !== 'chat'" class="chat-workspace" :class="{ tiled }" @dragover="dragOver" @drop="dropSession">
        <main id="main" ref="mainRef" v-show="showPrimary" data-session-tile :inert="blocked" :class="focusClass('primary')" :style="tileStyle('primary')" @focusin="focusedTile = 'primary'" @pointerdown="focusedTile = 'primary'" class="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header id="top" class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <button v-if="mobile" id="menu" class="icon-button" aria-label="Open navigation" :aria-controls="sessionPane ? undefined : 'side'" :aria-expanded="sessionPane ? undefined : ui.drawer" @click="openNavigation"><Menu :size="18" /></button>
            <button v-if="chat.parentSessionId" id="back-to-main-agent" type="button" class="icon-button shrink-0" aria-label="Back to main agent" :title="`Back to main agent · Session ${chat.parentSessionId}`" @click="openSession(chat.parentSessionId)"><ArrowLeft :size="18" /></button>
            <div class="heading min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <span v-if="headerProject" class="shrink-0" :title="headerProject.name"><ProjectIcon :icon="headerProject.icon" :color="headerProject.color" :size="20" :align-label="chat.title" /></span>
                <span dir="auto" id="title" class="block min-w-0 truncate text-sm font-medium">{{ chat.title }}</span>
              </div>
              <span v-if="activeSession && sessionState(activeSession) !== 'ready'" id="session-status" class="session-status session-state block truncate" :data-status="sessionState(activeSession)" :title="activeSession.statusReason || (sessionState(activeSession) === 'finished' ? 'Response finished. This does not verify task completion.' : sessionStatusLabel(activeSession))" role="status">{{ sessionStatusLabel(activeSession) }}<template v-if="activeSession.statusReason"> · {{ activeSession.statusReason }}</template></span>
              <span v-if="activeSession?.resumeAt" id="limit-wait" class="session-status flex items-center gap-2 text-muted-foreground" role="status"><span :title="new Date(activeSession.resumeAt).toLocaleString()">{{ resumeLabel(activeSession.resumeAt, undefined, activeSession.recovery?.exact ?? true) }}</span><button id="cancel-limit-wait" class="underline hover:text-foreground" @click="cancelLimitWait(activeSession)">Cancel</button></span>
              <span v-else-if="activeSession?.recovery?.pausedReason" id="limit-paused" class="session-status block truncate text-muted-foreground" :title="activeSession.recovery.pausedReason" role="status">Recovery stopped · {{ activeSession.recovery.pausedReason }}</span>
            </div>
            <button v-if="!docked && reviewJobs.length" type="button" class="icon-button shrink-0" :aria-label="`Inspect review agents${runningReviews ? ' · ' + runningReviews + ' running' : ''}`" title="Review agents" @click="selectedReview = reviewJobs[0]!.id"><ScanEye :size="18" :class="{ 'text-primary-text': runningReviews > 0 }" /></button>
            <MachineStatus v-if="!mobile" />
            <StatusBar v-if="!mobile && !docked" />
            <button v-if="!mobile && activeSession" id="pin-session" class="icon-button shrink-0" :class="{ 'text-primary-text': activeSession.pinned }" :aria-label="activeSession.pinned ? 'Unpin session' : 'Pin session'" :title="activeSession.pinned ? 'Unpin session' : 'Pin session'" :aria-pressed="!!activeSession.pinned" :disabled="pinPending" @click="pinSession"><PinOff v-if="activeSession.pinned" :size="18" /><Pin v-else :size="18" /></button>
            <button v-if="!mobile && activeSession" id="ask-wife" class="icon-button shrink-0" aria-label="Ask Wife about this session" title="Ask Wife about this session" :disabled="askPending" @click="askWifeAboutSession"><Heart :size="18" /></button>
            <button v-if="!sessionPane && !tiled" id="new-session" class="icon-button" aria-label="New session in current project" title="New session in current project" :disabled="newSessionPending || (!!chat.session && !chat.connected)" @click="handleNewSession"><Plus :size="18" /></button>
            <button v-if="!sessionPane && chat.session" id="toggle-terminal" class="icon-button" :class="{ 'text-primary-text': terminal.open }" :aria-pressed="terminal.open" aria-label="Terminal" title="Terminal (Ctrl+`)" @click="toggleTerminal"><SquareTerminal :size="18" /></button>
            <button v-if="!mobile && !sessionPane && !tiled" id="more" class="icon-button" aria-label="Conversation settings" title="Conversation settings" @click="openPanel('session')"><Ellipsis :size="18" /></button>
            <button v-if="!mobile && (chat.session || (chat.draftOpen && tileIds.length))" id="close-tile" class="icon-button tile-close" :aria-label="'Remove ' + chat.title + ' from tiles'" title="Remove tile" @click="closeTile"><X :size="14" /></button>
            <Popover v-if="mobile" v-model:open="mobileMenuOpen">
              <PopoverTrigger as-child>
                <button id="mobile-more" class="icon-button shrink-0" aria-label="Conversation menu" title="Conversation menu"><Ellipsis :size="18" /></button>
              </PopoverTrigger>
              <PopoverContent align="end" aria-label="Conversation menu" class="mobile-conversation-menu grid w-64 gap-2 p-2">
                <MachineStatus />
                <StatusBar v-if="!docked" />
                <button v-if="activeSession" class="mobile-menu-action" :disabled="askPending" @click="mobileAction(askWifeAboutSession)"><Heart :size="18" />Ask Wife about this session</button>
                <button v-if="activeSession" class="mobile-menu-action" :aria-pressed="!!activeSession.pinned" :disabled="pinPending" @click="mobileAction(pinSession)"><PinOff v-if="activeSession.pinned" :size="18" /><Pin v-else :size="18" />{{ activeSession.pinned ? 'Unpin session' : 'Pin session' }}</button>
                <button v-if="!sessionPane && !tiled" class="mobile-menu-action" @click="mobileAction(() => openPanel('session'))"><Ellipsis :size="18" />Conversation settings</button>
                <button v-if="chat.session || (chat.draftOpen && tileIds.length)" class="mobile-menu-action" @click="mobileAction(closeTile)"><X :size="18" />Remove tile</button>
              </PopoverContent>
            </Popover>
          </header>
          <ConfigError />
          <ReviewInspector :job="reviewJob" @select="selectedReview = $event" @close="selectedReview = null" />
          <div class="work-area" ref="workAreaRef" :class="dockSide ? 'dock-side' : 'dock-bottom'">
          <div class="chat-body">
            <div class="chat-column">
              <Transcript>
                <GitStatus v-if="!docked && chat.session" />
              </Transcript>
              <Extras v-if="!docked" />
              <div id="compose" class="mx-auto w-full max-w-4xl shrink-0 px-4 pb-3 pt-2 md:px-8">
                <Composer />
              </div>
            </div>
            <aside v-if="docked" id="session-rail" aria-label="Session details">
              <StatusBar docked />
              <GitStatus v-if="chat.session" docked />
              <Extras docked />
            </aside>
          </div>
          <BrowserPane v-if="terminal.open && chat.session && !sessionPane && browser.enabled && dock.pane === 'browser'" />
          <TerminalDock v-else-if="terminal.open && chat.session && !sessionPane" />
          </div>
        </main>
        <template v-if="!ui.login">
          <iframe v-for="id in tileIds" :key="id" :src="paneUrl(id)" :data-tile-session="id" data-session-tile :title="sessionTitle(history.list.find(s => String(s.id) === id) || { id })" class="session-pane" :class="focusClass(id)" :style="tileStyle(id)" />
          <div v-for="n in Math.max(0, visible.length - 1)" :key="'split-' + n" class="tile-split" :style="{ order: n * 2 - 1 }" @pointerenter="splitEnter(n - 1)" @pointerleave="splitLeave">
            <div class="tile-split-hit" />
            <div class="tile-split-actions" :class="{ 'split-actions-visible': splitHover === n - 1 }">
              <button class="icon-button" aria-label="Swap tiles" title="Swap tiles" @click="swapTiles(n - 1)"><ArrowLeftRight :size="14" /></button>
              <button class="icon-button tile-resize" aria-label="Resize tiles: use arrow keys; Enter or Space resets" title="Drag or use arrow keys to resize; double-click or Enter to reset" @keydown="resizeKey($event, n - 1)" @pointerdown.prevent="startResize($event, n - 1)" @dblclick="resetSplit(n - 1)"><MoveHorizontal :size="14" /></button>
            </div>
          </div>
        </template>
        <!-- HTML drag events do not bubble out of frames. This temporary surface
             receives the drop even when the pointer is over a live tile. -->
        <div v-if="!sessionPane && draggedSession" class="tile-drop-target" role="status">
          <span>{{ dropMessage }}</span>
        </div>
      </div>
      <div v-if="ui.view === 'analytics'" class="settings-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/60" @click.self="navigate('chat')">
        <div class="settings-window" role="dialog" aria-modal="true" aria-label="Analytics" tabindex="-1"><AnalyticsPage :inert="blocked" /></div>
      </div>
      <div v-if="ui.view === 'wife'" class="settings-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/60" @click.self="navigate('chat')">
        <div class="settings-window" role="dialog" aria-modal="true" aria-label="Wife" tabindex="-1"><WifePage :inert="blocked" /></div>
      </div>
      <div v-if="ui.view === 'source-control'" class="settings-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/60" @click.self="navigate('chat')">
        <div class="settings-window" role="dialog" aria-modal="true" aria-label="Source Control" tabindex="-1"><SourceControlPage :inert="blocked" /></div>
      </div>
      <div v-if="ui.view === 'settings'" class="settings-backdrop fixed inset-0 z-40 flex items-center justify-center bg-black/60" @click.self="navigate('chat')">
        <div class="settings-window" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1"><SettingsPage :inert="blocked" /></div>
      </div>
      <PanelHost />
      <ImageViewer />
      <SnapTool v-if="!sessionPane && !ui.login" />
      <CommandPalette v-if="!sessionPane && paletteUsed" :new-session="handleNewSession" :new-session-disabled="newSessionPending || (!!chat.session && !chat.connected)" />
      <ConnectionRecovery v-if="!sessionPane" />
      <div v-if="ui.login" id="login" role="dialog" aria-modal="true" aria-labelledby="loginTitle" class="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-5">
        <form id="loginForm" class="grid w-full max-w-sm gap-5 rounded-xl border border-border bg-card p-7" @submit.prevent="login(password, isDesktop ? serverInput : undefined)">
          <div class="flex items-center gap-3"><Moon :size="22" class="text-primary-text" /><h2 id="loginTitle" class="text-lg font-semibold">Connect to Luna</h2></div>
          <p class="text-sm text-muted-foreground">{{ isDesktop ? 'Enter the address of your Luna daemon (localhost or another machine) and its token.' : 'Enter your server token to open your workspace.' }}</p>
          <label v-if="isDesktop" class="grid gap-2 text-xs">Server URL<input id="server" v-model="serverInput" type="text" placeholder="localhost:8787 or 192.168.1.57:8787" required class="rounded-md border border-input bg-background px-3 py-2.5 text-sm" /></label>
          <label class="grid gap-2 text-xs">Server token<input id="token" v-model="password" type="password" autocomplete="current-password" placeholder="LUNA_TOKEN" :required="!isDesktop" class="rounded-md border border-input bg-background px-3 py-2.5 text-sm" /></label>
          <button class="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground">Connect</button>
          <span id="loginErr" role="alert" class="text-sm text-destructive">{{ ui.loginError }}</span>
        </form>
      </div>
    </div>
    <ConfirmDialog />
  </TooltipProvider>
</template>

<style scoped>
.settings-backdrop { padding: 24px; }
.settings-window { width: 100%; max-width: min(1475px, 100%); height: 94%; display: flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: 0 24px 90px #0009; background: var(--background); }
@media (max-width: 760px) { .settings-backdrop { padding: 8px; } .settings-window { height: 100%; } }
.mobile-menu-action {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px;
  border-radius: var(--radius);
  text-align: left;
  font-size: 13px;
}
.mobile-menu-action:hover, .mobile-menu-action:focus-visible { background: var(--accent); }
.mobile-menu-action:disabled { opacity: .5; }
:global(.mobile-conversation-menu #machine-status) { min-height: 44px; max-width: 100%; padding: 8px; }
:global(.mobile-conversation-menu #statusbar > summary) { min-height: 44px; padding: 8px; }
:global(.mobile-conversation-menu .usage-summary-label), :global(.mobile-conversation-menu .usage-cost) { display: inline; }
:global(.mobile-conversation-menu .usage-details) { position: static; width: 100%; box-shadow: none; margin-top: 8px; }

.chat-workspace {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.work-area { display: flex; flex: 1; min-height: 0; min-width: 0; flex-direction: column; }
.work-area.dock-side { flex-direction: row; }
.chat-body { display: flex; flex: 1; min-height: 0; min-width: 0; }
.chat-column { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
#session-rail {
  flex: 0 0 300px; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; gap: 12px;
  padding: 16px; border-left: 1px solid var(--border);
}
.session-pane {
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  height: 100%;
  border: 0;
}
.tile-split { position: relative; flex: 0 0 1px; background: var(--border); z-index: 10; }
.tile-split-hit { position: absolute; inset: 0 -5px; }
.tile-split-actions {
  opacity: 0; pointer-events: none;
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; gap: 4px; padding: 3px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--background);
}
.tile-split-actions.split-actions-visible, .tile-split-actions:focus-within { opacity: 1; pointer-events: auto; }
.tile-split-actions .icon-button { width: 28px; height: 28px; }
.tile-resize { cursor: col-resize; touch-action: none; }
#main.tile-focused, .session-pane.tile-focused { border: 1px solid var(--primary); }
.tile-close { width: 28px; height: 28px; }
.tile-drop-target {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  border: 1px solid var(--primary);
  background: color-mix(in srgb, var(--background) 80%, transparent);
}
.tile-drop-target span { padding: 8px 12px; background: var(--background); font-size: 13px; }
@media (max-width: 1000px) {
  .chat-workspace.tiled { flex-direction: column; }
  .session-pane {
    width: 100%;
    height: 0;
    min-height: 0;
  }
  .tile-split-hit { inset: -5px 0; }
  .tile-split-actions { flex-direction: row; }
  .tile-resize { cursor: row-resize; }
  .tile-resize svg { transform: rotate(90deg); }
}
</style>
