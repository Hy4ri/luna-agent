<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertCircle, Bot, Plus, RotateCw, SquareTerminal, X } from "@lucide/vue";
import TermView from "./TermView.vue";
import { closeTerminal, loadTerminals, newTerminal, tabLabel, terminal } from "@/stores/terminal";
import { navigate } from "@/stores/app";

const views = ref<Record<string, InstanceType<typeof TermView> | null>>({});
const live = computed(() => terminal.tabs.filter(t => t.status === "running").length);
// Luna's own terminals stay viewable with only terminal.agent on.
const usable = computed(() => terminal.enabled || terminal.tabs.length > 0);
const missingEndpoint = computed(() => /not found|404/i.test(terminal.error));

function tabKey(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const last = terminal.tabs.length - 1;
  const next = event.key === "ArrowRight" ? (index + 1) % (last + 1) : event.key === "ArrowLeft" ? (index + last) % (last + 1)
    : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
  if (next < 0) return;
  event.preventDefault();
  terminal.active = terminal.tabs[next]!.id;
  (document.getElementById(`term-tab-${terminal.active}`) as HTMLElement | null)?.focus();
}
</script>

<template>
  <div class="term-pane">
    <header v-if="terminal.tabs.length > 0" class="dock-bar">
      <div class="dock-tabs" role="tablist" aria-label="Terminals">
        <div v-for="(t, i) in terminal.tabs" :key="t.id" class="dock-tab" :class="{ active: t.id === terminal.active, ended: t.status === 'ended' }">
          <button :id="`term-tab-${t.id}`" type="button" role="tab" :aria-selected="t.id === terminal.active" :tabindex="t.id === terminal.active ? 0 : -1" :title="t.cwd" @click="terminal.active = t.id" @keydown="tabKey($event, i)">
            <Bot v-if="t.owner === 'agent'" :size="12" class="dock-luna" aria-label="Luna's terminal" />{{ tabLabel(t) }} {{ i + 1 }}<span v-if="t.status === 'ended'" class="dock-ended"> (ended)</span>
          </button>
          <button type="button" class="dock-close" :aria-label="`Close terminal ${i + 1}`" title="Close terminal" @click="closeTerminal(t.id)"><X :size="12" /></button>
        </div>
      </div>
      <button type="button" class="icon-button dock-new" aria-label="New terminal" title="New terminal" :disabled="!terminal.enabled || !terminal.session" @click="newTerminal()"><Plus :size="14" /></button>
    </header>
    <div v-if="!terminal.session" class="dock-empty">
      <SquareTerminal :size="20" class="empty-icon" aria-hidden="true" />
      <p class="empty-title">No active conversation</p>
      <p class="empty-sub">Open or start a conversation to use Terminal.</p>
    </div>
    <div v-else-if="!usable" class="dock-empty">
      <SquareTerminal :size="20" class="empty-icon" aria-hidden="true" />
      <p class="empty-title">Terminals are off</p>
      <p class="empty-sub">Enable user terminals in Settings &gt; Tools to start a shell.</p>
      <button type="button" class="dock-action" @click="navigate('settings', 'tools')">Open Settings &gt; Tools</button>
    </div>
    <div v-else-if="terminal.error && !terminal.tabs.length" class="dock-empty" role="alert">
      <AlertCircle :size="20" class="empty-icon is-error" aria-hidden="true" />
      <p class="empty-title">{{ missingEndpoint ? "Terminal service unavailable" : "Couldn't load terminals" }}</p>
      <p class="empty-sub">{{ terminal.error }}</p>
      <button type="button" class="dock-action" @click="loadTerminals(terminal.session)">
        <RotateCw :size="12" aria-hidden="true" />
        <span>Retry</span>
      </button>
    </div>
    <div v-else-if="!terminal.tabs.length" class="dock-empty">
      <SquareTerminal :size="20" class="empty-icon" aria-hidden="true" />
      <p class="empty-title">{{ terminal.loading ? "Loading terminals..." : "No terminals in this session" }}</p>
      <button v-if="!terminal.loading" type="button" class="dock-action" @click="newTerminal()">
        <Plus :size="12" aria-hidden="true" />
        <span>New terminal</span>
      </button>
    </div>
    <template v-else>
      <p v-if="terminal.error" class="dock-message" role="alert">
        <AlertCircle :size="14" aria-hidden="true" />
        <span>{{ terminal.error }}</span>
      </p>
      <div class="dock-body">
        <TermView v-for="t in terminal.tabs" :key="t.id" :ref="el => (views[t.id] = el as InstanceType<typeof TermView> | null)" :session="terminal.session" :id="t.id" :active="t.id === terminal.active" />
      </div>
    </template>
    <span class="sr-only" aria-live="polite">{{ live }} running terminals</span>
  </div>
</template>

<style scoped>
.term-pane { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; }
.dock-bar { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--card); }
.dock-tabs { display: flex; flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.dock-tab { display: flex; align-items: center; border-bottom: 2px solid transparent; font: 12px var(--mono); color: var(--muted-foreground); }
.dock-tab.active { border-bottom-color: var(--primary); color: var(--foreground); background: var(--background); }
.dock-tab > button[role="tab"] { display: inline-flex; align-items: center; gap: 6px; min-height: 35px; padding: 0 6px 0 10px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
.dock-tab > button[role="tab"]:focus-visible, .dock-close:focus-visible, .dock-action:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.dock-ended { opacity: .7; }
.dock-luna { flex: none; }
.dock-new { flex: none; }
.dock-action { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--foreground); font: 12px var(--mono); cursor: pointer; white-space: nowrap; }
.dock-action:hover { background: var(--secondary); }
.dock-close { display: grid; place-items: center; width: 24px; height: 24px; margin-right: 2px; background: none; border: 0; color: inherit; border-radius: var(--radius); cursor: pointer; }
.dock-close:hover { background: var(--secondary); }
.dock-body { display: flex; flex: 1; min-height: 0; }
.dock-message { display: flex; align-items: center; gap: 8px; margin: 0; padding: 6px 10px; background: var(--err-soft); color: var(--destructive); font: 12px var(--mono); border-bottom: 1px solid color-mix(in srgb, var(--destructive) 30%, var(--border)); }
.dock-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 20px 16px; text-align: center; color: var(--muted-foreground); font: 12px var(--mono); }
.dock-empty p { margin: 0; }
.empty-icon { opacity: 0.65; }
.empty-icon.is-error { color: var(--destructive); opacity: 0.9; }
.empty-title { color: var(--foreground); font-size: 13px; font-weight: 600; }
.empty-sub { max-width: 340px; line-height: 1.45; color: var(--muted-foreground); }
@media (max-width: 760px), (pointer: coarse) {
  .dock-tab > button[role="tab"] { min-height: 44px; padding: 6px 6px 6px 12px; }
  .dock-close { width: 44px; height: 44px; }
  .dock-new { width: 44px; height: 44px; }
  .dock-action { min-height: 44px; padding: 6px 14px; }
}
</style>
