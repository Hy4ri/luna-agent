<script setup lang="ts">
// The Browser pane of the dock: tabs, address bar, drive controls and the live view.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, Bot, Plus, RotateCw, X } from "@lucide/vue";
import WorkDock from "@/components/dock/WorkDock.vue";
import DockControls from "@/components/dock/DockControls.vue";
import BrowserView from "./BrowserView.vue";
import { browser, closeBrowserTab, controlBrowserTab, openBrowserTab, watchBrowser } from "@/stores/browser";
import { dock } from "@/stores/dock";
import { normalizeUrl } from "@/lib/browser-view";

const current = computed(() => browser.tabs.find(t => t.tabId === browser.active));
const address = ref("");
const editing = ref(false);
watch(() => [current.value?.tabId, current.value?.url] as const, ([, url]) => { if (!editing.value) address.value = url ?? ""; }, { immediate: true });

const host = (url: string) => { try { return new URL(url).host || url; } catch { return url || "new tab"; } };
// Navigation goes through the visible tab's socket, which only forwards input while m57 drives.
const views = ref<Record<string, InstanceType<typeof BrowserView> | null>>({});

function submitAddress() {
  const url = normalizeUrl(address.value);
  editing.value = false;
  if (!url) return;
  if (!current.value) { void openBrowserTab(url); return; }
  void navInput({ kind: "nav", action: "goto", url });
}
function navInput(event: Record<string, unknown>) {
  const t = current.value;
  if (!t) return;
  if (t.controller !== "user") { void controlBrowserTab(t.tabId, "take").then(() => views.value[t.tabId]?.sendNav(event)); return; }
  views.value[t.tabId]?.sendNav(event);
}
function newTab() { const url = normalizeUrl(address.value); void openBrowserTab(/^https?:\/\//i.test(url) ? url : "https://duckduckgo.com/"); }
function tabKey(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const last = browser.tabs.length - 1;
  const next = event.key === "ArrowRight" ? (index + 1) % (last + 1) : event.key === "ArrowLeft" ? (index + last) % (last + 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
  if (next < 0) return;
  event.preventDefault();
  browser.active = browser.tabs[next]!.tabId;
  (document.getElementById(`browser-tab-${browser.active}`) as HTMLElement | null)?.focus();
}
onMounted(() => watchBrowser(true));
onBeforeUnmount(() => watchBrowser(false));
</script>

<template>
  <WorkDock label="Browser">
    <header class="dock-bar">
      <div class="dock-tabs" role="tablist" aria-label="Browser tabs">
        <div v-for="(t, i) in browser.tabs" :key="t.tabId" class="dock-tab" :class="{ active: t.tabId === browser.active }">
          <button :id="`browser-tab-${t.tabId}`" type="button" role="tab" :aria-selected="t.tabId === browser.active" :tabindex="t.tabId === browser.active ? 0 : -1" :title="t.url" @click="browser.active = t.tabId" @keydown="tabKey($event, i)">
            <Bot v-if="t.owner === 'agent'" :size="12" class="dock-luna" aria-label="Luna's tab" />{{ host(t.url) }}
          </button>
          <button type="button" class="dock-close" :aria-label="`Close tab ${i + 1}`" title="Close tab" @click="closeBrowserTab(t.tabId)"><X :size="12" /></button>
        </div>
      </div>
      <template v-if="current">
        <span v-if="current.controller === 'agent'" class="dock-state">Luna is driving</span>
        <span v-else class="dock-state">You are driving</span>
        <span v-if="!current.input" class="dock-state">View only</span>
        <button v-if="current.controller === 'agent' && current.input" type="button" class="dock-action" title="Click and type in this tab yourself. Luna waits until you give it back." @click="controlBrowserTab(current.tabId, 'take')">Take over</button>
        <button v-else-if="current.controller === 'user'" type="button" class="dock-action" title="Let Luna use this tab again." @click="controlBrowserTab(current.tabId, 'give')">Give to Luna</button>
      </template>
      <button type="button" class="icon-button" aria-label="New tab" title="New tab" @click="newTab"><Plus :size="14" /></button>
      <DockControls :panes="['terminal', 'browser']" @pane="dock.pane = $event" />
    </header>
    <form class="address-bar" @submit.prevent="submitAddress">
      <button type="button" class="icon-button" aria-label="Back" title="Back" :disabled="!current?.input" @click="navInput({ kind: 'nav', action: 'back' })"><ArrowLeft :size="14" /></button>
      <button type="button" class="icon-button" aria-label="Forward" title="Forward" :disabled="!current?.input" @click="navInput({ kind: 'nav', action: 'forward' })"><ArrowRight :size="14" /></button>
      <button type="button" class="icon-button" aria-label="Reload" title="Reload" :disabled="!current?.input" @click="navInput({ kind: 'nav', action: 'reload' })"><RotateCw :size="14" /></button>
      <input v-model="address" class="address-input" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" aria-label="Address" :placeholder="current ? '' : 'Enter an address to open a tab'" :disabled="!!current && !current.input" @focus="editing = true" @blur="editing = false" />
    </form>
    <p v-if="browser.error" class="dock-message" role="alert">{{ browser.error }}</p>
    <div v-if="!browser.tabs.length" class="dock-empty">
      <p>{{ browser.loading ? "Loading..." : "No browser tabs in this session. Ask Luna to open a page, or enter an address above." }}</p>
    </div>
    <div v-else class="dock-body">
      <BrowserView v-for="t in browser.tabs" :key="t.tabId" :ref="el => (views[t.tabId] = el as InstanceType<typeof BrowserView> | null)" :session="browser.session" :tab-id="t.tabId" :active="t.tabId === browser.active" />
    </div>
  </WorkDock>
</template>

<style scoped>
.dock-bar { display: flex; align-items: center; gap: 2px; padding: 0 4px; border-bottom: 1px solid var(--border); background: var(--card); }
.dock-tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; }
.dock-tab { display: flex; align-items: center; border-bottom: 2px solid transparent; font: 12px var(--mono); color: var(--muted-foreground); }
.dock-tab.active { border-bottom-color: var(--primary-text); color: var(--foreground); }
.dock-tab > button[role="tab"] { max-width: 180px; overflow: hidden; text-overflow: ellipsis; padding: 6px 4px 6px 10px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
.dock-luna { margin-right: 4px; vertical-align: -2px; }
.dock-state { padding: 0 6px; color: var(--muted-foreground); font: 12px var(--mono); white-space: nowrap; }
.dock-action { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: none; color: var(--foreground); font: 12px var(--mono); cursor: pointer; white-space: nowrap; }
.dock-action:hover { background: var(--secondary); }
.dock-close { display: grid; place-items: center; width: 20px; height: 20px; background: none; border: 0; color: inherit; border-radius: var(--radius); cursor: pointer; }
.dock-close:hover { background: var(--secondary); }
.address-bar { display: flex; align-items: center; gap: 2px; padding: 3px 4px; border-bottom: 1px solid var(--border); background: var(--card); }
.address-input { flex: 1; min-width: 0; padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); font: 12px var(--mono); }
.address-input:focus-visible { outline: 1px solid var(--ring); }
.address-input:disabled { opacity: .7; }
.dock-body { display: flex; flex: 1; min-height: 0; min-width: 0; }
.dock-message { margin: 0; padding: 4px 10px; color: var(--destructive); font: 12px var(--mono); border-bottom: 1px solid var(--border); }
.dock-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 0 16px; text-align: center; color: var(--muted-foreground); font: 13px var(--mono); }
.dock-empty p { margin: 0; }
</style>
