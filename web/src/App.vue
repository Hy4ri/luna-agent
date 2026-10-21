<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { Menu, Ellipsis, Moon, Plus, Columns2 } from '@lucide/vue';
import { TooltipProvider } from '@/components/ui/tooltip';
import Sidebar from '@/components/sidebar/Sidebar.vue';
import Transcript from '@/components/chat/Transcript.vue';
import Extras from '@/components/chat/Extras.vue';
import StatusBar from '@/components/chat/StatusBar.vue';
import Composer from '@/components/composer/Composer.vue';
import PanelHost from '@/components/panels/PanelHost.vue';
import CommandPalette from '@/components/CommandPalette.vue';
import CronPage from '@/pages/CronPage.vue';
import AnalyticsPage from '@/pages/AnalyticsPage.vue';
import SettingsPage from '@/pages/SettingsPage.vue';
import { ui, boot, login, setDrawer, closePanel, openPanel, toggleSplit, setPalette } from '@/stores/app';
import { chat, newSession, openSession, clearConversation, addErr } from '@/stores/chat';
import { history, cancelLimitWait, resumeLabel, sessionTitle, projectName } from '@/stores/sessions';
import { sessionPane } from '@/lib/pane';
import { sessionState, sessionStatusLabel } from '@/lib/session-status';
import { useMobile } from '@/lib/dom';
import { trackViewport } from '@/lib/viewport';

const mobile = useMobile();
const paneUrl = new URL(location.href);
paneUrl.searchParams.set('pane', 'session');
paneUrl.hash = '';
const paneSessions = computed(() => history.list.filter(s => !s.archived || String(s.id) === chat.session));
function selectPaneSession(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (id) void openSession(id);
  else clearConversation();
}
const activeSession = computed(() => history.list.find(row => String(row.id) === chat.session));
const password = ref('');
const blocked = computed(() => ui.login || !!ui.panel || (mobile.value && ui.drawer));
const split = computed(() => ui.split);

const activeProject = computed(() => {
  if (chat.session) {
    const active = history.list.find(row => String(row.id) === chat.session);
    return active ? active.project ?? null : chat.project;
  }
  if (!chat.session) {
    const saved = localStorage.getItem('luna.project');
    if (saved !== null && saved !== '' && !isNaN(Number(saved))) {
      const num = Number(saved);
      if (history.projects.some(p => p.id === num)) return num;
    }
  }
  return null;
});

const newSessionPending = ref(false);

async function handleNewSession() {
  if (newSessionPending.value) return;
  newSessionPending.value = true;
  try {
    await newSession(activeProject.value);
  } catch (e: any) {
    addErr(e?.message || 'Failed to create new session');
  } finally {
    newSessionPending.value = false;
  }
}

function keyboard(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !ui.login && !sessionPane) {
    e.preventDefault();
    setPalette(!ui.palette);
    return;
  }
  // The palette dialog owns Escape and focus while it is open.
  if (ui.palette) return;
  if (e.key === 'Escape') {
    if (ui.panel) { e.preventDefault(); closePanel(); }
    else if (ui.drawer) { e.preventDefault(); setDrawer(false); }
    return;
  }
  if (e.key !== 'Tab') return;
  const root = ui.login ? document.getElementById('login') : ui.panel ? document.querySelector('#panel [role="dialog"]') : mobile.value && ui.drawer ? document.getElementById('side') : null;
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex="0"]')].filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
  const first = items[0], last = items.at(-1);
  if (!first) return;
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}
watch(mobile, value => { if (!value && ui.drawer) setDrawer(false); });
watch(() => ui.login, value => { if (value) void nextTick(() => document.getElementById('token')?.focus()); });
let stopViewport: (() => void) | undefined;
onMounted(() => {
  stopViewport = trackViewport(document.getElementById('app')!);
  document.addEventListener('keydown', keyboard);
  void boot();
});
onUnmounted(() => { stopViewport?.(); document.removeEventListener('keydown', keyboard); });
</script>

<template>
  <TooltipProvider>
    <div class="flex h-full min-h-0 w-full overflow-hidden bg-background text-foreground">
      <Sidebar v-if="!sessionPane" :inert="ui.login || !!ui.panel" />
      <div v-if="mobile && ui.drawer" id="shade" class="fixed inset-0 z-30 bg-black/60" @click="setDrawer(false)" />
      <div id="chat-workspace" v-show="ui.view === 'chat'" :inert="blocked" class="chat-workspace" :class="{ split }">
        <main id="main" :inert="blocked" class="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header id="top" class="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <button v-if="mobile && !sessionPane" id="menu" class="icon-button" aria-label="Open navigation" aria-controls="side" :aria-expanded="ui.drawer" @click="setDrawer(true)"><Menu :size="18" /></button>
            <div class="heading min-w-0 flex-1">
              <select v-if="sessionPane" id="pane-session" aria-label="Second session" :value="chat.session || ''" class="w-full min-w-0 truncate rounded border border-input bg-background px-2 py-1 text-sm font-medium" @change="selectPaneSession">
                <option value="">New conversation</option>
                <option v-for="s in paneSessions" :key="s.id" :value="String(s.id)">{{ sessionTitle(s) }}{{ projectName(s.project) ? ' · ' + projectName(s.project) : '' }}</option>
              </select>
              <span v-else id="title" class="block truncate text-sm font-medium">{{ chat.title }}</span>
              <span v-if="activeSession && sessionState(activeSession) !== 'ready'" id="session-status" class="session-status session-state block truncate" :data-status="sessionState(activeSession)" :title="activeSession.statusReason || (sessionState(activeSession) === 'finished' ? 'Response finished. This does not verify task completion.' : sessionStatusLabel(activeSession))" role="status">{{ sessionStatusLabel(activeSession) }}<template v-if="activeSession.statusReason"> · {{ activeSession.statusReason }}</template></span>
              <span v-if="activeSession?.resumeAt" id="limit-wait" class="session-status flex items-center gap-2 text-muted-foreground" role="status"><span :title="new Date(activeSession.resumeAt).toLocaleString()">{{ resumeLabel(activeSession.resumeAt) }}</span><button id="cancel-limit-wait" class="underline hover:text-foreground" @click="cancelLimitWait(activeSession)">Cancel</button></span>
            </div>
            <StatusBar />
            <button v-if="!sessionPane" id="split-view" class="icon-button" :class="{ 'text-primary bg-accent': split }" :aria-label="split ? 'Close split view' : 'Open split view'" :title="split ? 'Close split view' : 'Open split view'" :aria-pressed="split" aria-controls="secondary-pane" @click="toggleSplit"><Columns2 :size="18" /></button>
            <button id="new-session" class="icon-button" aria-label="New session in current project" title="New session in current project" :disabled="newSessionPending || (!!chat.session && !chat.connected)" @click="handleNewSession"><Plus :size="18" /></button>
            <button id="more" class="icon-button" aria-label="Conversation settings" title="Conversation settings" @click="openPanel('session')"><Ellipsis :size="18" /></button>
          </header>
          <Transcript />
          <Extras />
          <div id="compose" class="mx-auto w-full max-w-4xl shrink-0 px-4 pb-3 pt-2 md:px-8">
            <Composer />
          </div>
        </main>
        <!-- Keep the document alive when hidden: closing the split must not lose
             unsent attachments, in-flight submissions, or the second pane's view. -->
        <iframe v-if="ui.splitMounted" v-show="split" id="secondary-pane" :src="paneUrl.href" title="Second session" class="session-pane" />
      </div>
      <div v-if="ui.view !== 'chat'" :inert="blocked" class="flex min-w-0 flex-1 overflow-hidden">
        <CronPage v-if="ui.view === 'cron'" :inert="blocked" />
        <AnalyticsPage v-if="ui.view === 'analytics'" :inert="blocked" />
        <SettingsPage v-if="ui.view === 'settings'" :inert="blocked" />
      </div>
      <PanelHost />
      <CommandPalette v-if="!sessionPane" :new-session="handleNewSession" :new-session-disabled="newSessionPending || (!!chat.session && !chat.connected)" />
      <div v-if="ui.login" id="login" role="dialog" aria-modal="true" aria-labelledby="loginTitle" class="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-5">
        <form id="loginForm" class="grid w-full max-w-sm gap-5 rounded-xl border border-border bg-card p-7" @submit.prevent="login(password)">
          <div class="flex items-center gap-3"><Moon :size="22" class="text-primary" /><h2 id="loginTitle" class="text-lg font-semibold">Connect to Luna</h2></div>
          <p class="text-sm text-muted-foreground">Enter your server token to open your workspace.</p>
          <label class="grid gap-2 text-xs">Server token<input id="token" v-model="password" type="password" autocomplete="current-password" placeholder="LUNA_TOKEN" required class="rounded-md border border-input bg-background px-3 py-2.5 text-sm" /></label>
          <button class="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground">Connect</button>
          <span id="loginErr" role="alert" class="text-sm text-destructive">{{ ui.loginError }}</span>
        </form>
      </div>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.chat-workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.session-pane {
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  height: 100%;
  border: 0;
  border-left: 1px solid var(--border);
}
@media (max-width: 1000px) {
  .chat-workspace.split { flex-direction: column; }
  .session-pane {
    width: 100%;
    height: 0;
    min-height: 0;
    border-left: 0;
    border-top: 1px solid var(--border);
  }
}
</style>
