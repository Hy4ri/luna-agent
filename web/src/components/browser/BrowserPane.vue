<script setup lang="ts">
// The Browser pane of the dock: tabs, address bar, drive controls and the live view.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertCircle, ArrowLeft, ArrowRight, Bot, Globe, Plus, RotateCw, X } from "@lucide/vue";
import BrowserView from "./BrowserView.vue";
import { browser, closeBrowserTab, openBrowserTab, selectBrowserTab, watchBrowser } from "@/stores/browser";
import { normalizeUrl } from "@/lib/browser-view";

const current = computed(() => browser.draft ? undefined : browser.tabs.find(t => t.tabId === browser.active));
const address = ref("");
const editing = ref(false);
const addressInput = ref<HTMLInputElement | null>(null);
watch(() => [current.value?.tabId, current.value?.url] as const, ([, url]) => { if (!editing.value) address.value = url ?? ""; }, { immediate: true });

const host = (url: string) => { try { return new URL(url).host || url; } catch { return url || "new tab"; } };
// Navigation goes through the visible tab's socket, which only forwards input while you drive.
const views = ref<Record<string, InstanceType<typeof BrowserView> | null>>({});

function submitAddress() {
  const url = normalizeUrl(address.value);
  if (!url) return;
  editing.value = false;
  if (!current.value) { void openBrowserTab(url); return; }
  void navInput({ kind: "nav", action: "goto", url });
}
function navInput(event: Record<string, unknown>) {
  const t = current.value;
  if (!t) return;
  views.value[t.tabId]?.sendNav(event);
}
// A new tab starts blank, like a browser's: nothing carries over from the tab on screen. The page opens when you enter an address.
async function newTab() {
  browser.draft = true;
  editing.value = false;
  address.value = "";
  await nextTick();
  addressInput.value?.focus();
}
function cancelDraft() {
  browser.draft = false;
  if (!editing.value) address.value = current.value?.url ?? "";
}
function addressKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing) return;
  if (browser.draft && browser.tabs.length) { cancelDraft(); return; }
  address.value = current.value?.url ?? "";
  addressInput.value?.blur();
}
function tabKey(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const last = browser.tabs.length - 1;
  const next = event.key === "ArrowRight" ? (index + 1) % (last + 1) : event.key === "ArrowLeft" ? (index + last) % (last + 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
  if (next < 0) return;
  event.preventDefault();
  selectBrowserTab(browser.tabs[next]!.tabId);
  (document.getElementById(`browser-tab-${browser.active}`) as HTMLElement | null)?.focus();
}
onMounted(() => watchBrowser(true));
onBeforeUnmount(() => watchBrowser(false));
</script>

<template>
  <div class="browser-pane">
    <header class="tab-strip">
      <div class="tabs" role="tablist" aria-label="Browser tabs">
        <div v-for="(t, i) in browser.tabs" :key="t.tabId" class="tab" :class="{ active: !browser.draft && t.tabId === browser.active }">
          <button :id="`browser-tab-${t.tabId}`" type="button" role="tab" class="tab-label" :aria-selected="!browser.draft && t.tabId === browser.active" :tabindex="t.tabId === browser.active ? 0 : -1" :title="t.url" @click="selectBrowserTab(t.tabId)" @keydown="tabKey($event, i)">
            <Bot v-if="t.owner === 'agent'" :size="12" class="tab-icon" aria-label="Luna's tab" /><Globe v-else :size="12" class="tab-icon" aria-hidden="true" /><span class="tab-text">{{ host(t.url) }}</span>
          </button>
          <button type="button" class="tab-close" :aria-label="`Close tab ${i + 1}`" title="Close tab" @click="closeBrowserTab(t.tabId)"><X :size="12" /></button>
        </div>
        <div v-if="browser.draft" class="tab active">
          <button type="button" role="tab" class="tab-label" aria-selected="true" tabindex="0" @click="addressInput?.focus()"><Globe :size="12" class="tab-icon" aria-hidden="true" /><span class="tab-text">New tab</span></button>
          <button v-if="browser.tabs.length" type="button" class="tab-close" aria-label="Close new tab" title="Close tab" @click="cancelDraft"><X :size="12" /></button>
        </div>
      </div>
      <button type="button" class="icon-button tab-new" aria-label="New tab" title="New tab" :disabled="!browser.session" @click="newTab"><Plus :size="14" /></button>
    </header>
    <form class="address-bar" @submit.prevent="submitAddress">
      <button type="button" class="icon-button" aria-label="Back" :title="current && !current.input ? 'View only — Luna is driving this tab' : 'Back'" :disabled="!current?.input" @click="navInput({ kind: 'nav', action: 'back' })"><ArrowLeft :size="14" /></button>
      <button type="button" class="icon-button" aria-label="Forward" :title="current && !current.input ? 'View only — Luna is driving this tab' : 'Forward'" :disabled="!current?.input" @click="navInput({ kind: 'nav', action: 'forward' })"><ArrowRight :size="14" /></button>
      <button type="button" class="icon-button" aria-label="Reload" :title="current && !current.input ? 'View only — Luna is driving this tab' : 'Reload'" :disabled="!current?.input" @click="navInput({ kind: 'nav', action: 'reload' })"><RotateCw :size="14" /></button>
      <input ref="addressInput" v-model="address" class="address-input" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" aria-label="Address" :placeholder="!browser.session ? 'Open a conversation to use Browser' : current ? '' : 'Enter an address to open a tab'" :disabled="!browser.session || (!!current && !current.input)" @focus="editing = true" @blur="editing = false" @keydown="addressKey" />
      <span v-if="current && !current.input" class="drive-state" title="You can watch this tab. Ask Luna to hand over control if you want to interact.">View only</span>
    </form>
    <p v-if="browser.error && browser.tabs.length" class="dock-message" role="alert">
      <AlertCircle :size="14" aria-hidden="true" />
      <span>{{ browser.error }}</span>
    </p>
    <div v-if="!browser.session" class="dock-empty">
      <Globe :size="20" class="empty-icon" aria-hidden="true" />
      <p class="empty-title">No active conversation</p>
      <p class="empty-sub">Open or start a conversation to use Browser.</p>
    </div>
    <div v-else-if="browser.error && !browser.tabs.length && !browser.draft" class="dock-empty" role="alert">
      <AlertCircle :size="20" class="empty-icon is-error" aria-hidden="true" />
      <p class="empty-title">Browser unavailable</p>
      <p class="empty-sub">{{ browser.error }}</p>
    </div>
    <div v-else-if="!browser.tabs.length || browser.draft" class="dock-empty">
      <Globe :size="20" class="empty-icon" aria-hidden="true" />
      <p class="empty-sub">{{ browser.loading && !browser.tabs.length ? "Loading..." : browser.draft || browser.tabs.length ? "Enter an address above to open it in this tab." : "No browser tabs in this session. Ask Luna to open a page, or enter an address above." }}</p>
    </div>
    <div v-if="browser.session && browser.tabs.length" class="dock-body" :hidden="browser.draft">
      <BrowserView v-for="t in browser.tabs" :key="t.tabId" :ref="el => (views[t.tabId] = el as InstanceType<typeof BrowserView> | null)" :session="browser.session" :tab-id="t.tabId" :active="!browser.draft && t.tabId === browser.active" />
    </div>
  </div>
</template>

<style scoped>
.browser-pane { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
/* Tab strip: the active tab joins the address bar below it, like a desktop browser. */
.tab-strip { display: flex; align-items: flex-end; gap: 4px; min-height: 36px; padding: 4px 8px 0; border-bottom: 1px solid var(--border); background: var(--sidebar); }
.tabs { display: flex; flex: 0 1 auto; align-items: flex-end; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.tab { position: relative; display: flex; flex: 0 1 auto; align-items: center; width: 180px; min-width: 96px; height: 30px; margin-bottom: -1px; border: 1px solid transparent; border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; color: var(--muted-foreground); font: 12px var(--mono); }
.tab + .tab::before { content: ""; position: absolute; left: -1px; top: 8px; bottom: 8px; border-left: 1px solid var(--border); }
.tab.active::before, .tab.active + .tab::before { display: none; }
.tab:hover:not(.active) { background: color-mix(in srgb, var(--card) 50%, transparent); color: var(--foreground); }
.tab.active { z-index: 1; height: 31px; border-color: var(--border); background: var(--card); color: var(--foreground); box-shadow: inset 0 2px 0 var(--primary); }
.tab-label { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 2px 0 10px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; }
.tab-label:focus-visible, .tab-close:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.tab-icon { flex: none; color: var(--muted-foreground); }
.tab-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { display: grid; flex: none; place-items: center; width: 24px; height: 24px; margin-right: 4px; background: none; border: 0; color: inherit; border-radius: var(--radius); cursor: pointer; opacity: 0; }
.tab:hover .tab-close, .tab.active .tab-close, .tab-close:focus-visible { opacity: 1; }
.tab-close:hover { background: var(--secondary); }
@media (hover: none) { .tab-close { opacity: 1; } }
.tab-new { flex: none; align-self: center; margin-bottom: 2px; }
.address-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--card); }
.address-input { flex: 1; min-width: 0; min-height: 28px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); font: 12px var(--mono); }
.address-input:focus-visible { outline: 2px solid var(--ring); outline-offset: -1px; }
.address-input:disabled { opacity: .7; }
.drive-state { display: inline-flex; align-items: center; flex: none; height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--secondary); color: var(--muted-foreground); font: 11px var(--mono); white-space: nowrap; }
.dock-body { display: flex; flex: 1; min-height: 0; min-width: 0; }
.dock-body[hidden] { display: none; }
.dock-message { display: flex; align-items: center; gap: 8px; margin: 0; padding: 6px 10px; background: var(--err-soft); color: var(--destructive); font: 12px var(--mono); border-bottom: 1px solid color-mix(in srgb, var(--destructive) 30%, var(--border)); }
.dock-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 20px 16px; text-align: center; color: var(--muted-foreground); font: 12px var(--mono); }
.dock-empty p { margin: 0; }
.empty-icon { opacity: 0.65; }
.empty-icon.is-error { color: var(--destructive); opacity: 0.9; }
.empty-title { color: var(--foreground); font-size: 13px; font-weight: 600; }
.empty-sub { max-width: 360px; line-height: 1.45; color: var(--muted-foreground); }
@media (max-width: 760px), (pointer: coarse) {
  .tab { min-height: 44px; }
  .tab-label { min-height: 44px; }
  .tab-close { width: 44px; height: 44px; }
  .tab-new { width: 44px; height: 44px; }
  .address-bar .icon-button { width: 44px; height: 44px; }
  .address-input { min-height: 44px; }
  .drive-state { height: 36px; }
}
</style>
