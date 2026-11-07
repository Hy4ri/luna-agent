<script setup lang="ts">
import { computed, ref } from "vue";
import { Bot, ChevronDown, Plus, X } from "@lucide/vue";
import TermView from "./TermView.vue";
import { clampHeight, closeTerminal, controlTerminal, newTerminal, setHeight, tabLabel, terminal } from "@/stores/terminal";
import { navigate } from "@/stores/app";

const views = ref<Record<string, InstanceType<typeof TermView> | null>>({});
const live = computed(() => terminal.tabs.filter(t => t.status === "running").length);
const current = computed(() => terminal.tabs.find(t => t.id === terminal.active));
// Luna's own terminals stay viewable with only terminal.agent on.
const usable = computed(() => terminal.enabled || terminal.tabs.length > 0);

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

// The handle sits on the dock's top edge: dragging up makes the dock taller.
function startResize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement;
  const startY = event.clientY, startHeight = terminal.height;
  handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => setHeight(startHeight + (startY - e.clientY));
  const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}
function resizeKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const step = event.shiftKey ? 80 : 24;
  if (event.key === "ArrowUp") { event.preventDefault(); setHeight(terminal.height + step); }
  else if (event.key === "ArrowDown") { event.preventDefault(); setHeight(terminal.height - step); }
}
</script>

<template>
  <section class="terminal-dock" aria-label="Terminal" :style="{ height: clampHeight(terminal.height) + 'px' }">
    <div class="dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" :aria-valuenow="terminal.height" tabindex="0" @pointerdown.prevent="startResize" @keydown="resizeKey" />
    <header class="dock-bar">
      <div class="dock-tabs" role="tablist" aria-label="Terminals">
        <div v-for="(t, i) in terminal.tabs" :key="t.id" class="dock-tab" :class="{ active: t.id === terminal.active, ended: t.status === 'ended' }">
          <button :id="`term-tab-${t.id}`" type="button" role="tab" :aria-selected="t.id === terminal.active" :tabindex="t.id === terminal.active ? 0 : -1" :title="t.cwd" @click="terminal.active = t.id" @keydown="tabKey($event, i)">
            <Bot v-if="t.owner === 'agent'" :size="12" class="dock-luna" aria-label="Luna's terminal" />{{ tabLabel(t) }} {{ i + 1 }}<span v-if="t.status === 'ended'" class="dock-ended"> (ended)</span>
          </button>
          <button type="button" class="dock-close" :aria-label="`Close terminal ${i + 1}`" title="Close terminal" @click="closeTerminal(t.id)"><X :size="12" /></button>
        </div>
      </div>
      <template v-if="current && current.status === 'running'">
        <span v-if="current.controller === 'agent'" class="dock-state">Luna is typing</span>
        <span v-else-if="current.shared && current.owner !== 'agent'" class="dock-state">Luna can see this</span>
        <button v-if="current.controller === 'agent'" type="button" class="dock-action" title="Type in this terminal yourself. Luna waits until you give it back." @click="controlTerminal(current.id, 'take')">Take over</button>
        <template v-else-if="terminal.agentEnabled">
          <button v-if="current.shared" type="button" class="dock-action" title="Let Luna type in this terminal. You watch, and can take it back." @click="controlTerminal(current.id, 'give')">Give to Luna</button>
          <button v-if="current.owner !== 'agent'" type="button" class="dock-action" :title="current.shared ? 'Luna can no longer see this terminal.' : 'Luna can see this terminal. You keep typing.'" @click="controlTerminal(current.id, current.shared ? 'unshare' : 'share')">{{ current.shared ? "Stop sharing" : "Share with Luna" }}</button>
        </template>
      </template>
      <button type="button" class="icon-button" aria-label="New terminal" title="New terminal" :disabled="!terminal.enabled" @click="newTerminal()"><Plus :size="14" /></button>
      <button type="button" class="icon-button" aria-label="Hide terminal" title="Hide terminal (the shells keep running)" @click="terminal.open = false"><ChevronDown :size="14" /></button>
    </header>
    <p v-if="terminal.error" class="dock-message" role="alert">{{ terminal.error }}</p>
    <div v-if="!usable" class="dock-empty">
      <p>Terminals are off.</p>
      <button type="button" class="dock-link" @click="navigate('settings', 'tools')">Open Settings > Tools > Terminal</button>
    </div>
    <div v-else-if="!terminal.tabs.length" class="dock-empty">
      <p>{{ terminal.loading ? "Loading..." : "No terminals in this session." }}</p>
      <button v-if="!terminal.loading" type="button" class="dock-link" @click="newTerminal()">New terminal</button>
    </div>
    <div v-else class="dock-body">
      <TermView v-for="t in terminal.tabs" :key="t.id" :ref="el => (views[t.id] = el as InstanceType<typeof TermView> | null)" :session="terminal.session" :id="t.id" :active="t.id === terminal.active" />
    </div>
    <span class="sr-only" aria-live="polite">{{ live }} running terminals</span>
  </section>
</template>

<style scoped>
.terminal-dock { position: relative; display: flex; flex-direction: column; flex: none; min-height: 0; border-top: 1px solid var(--border); background: var(--background); }
.dock-resize { position: absolute; inset: -3px 0 auto; height: 6px; cursor: ns-resize; z-index: 2; touch-action: none; }
.dock-resize:hover, .dock-resize:focus-visible { background: var(--ring); opacity: .5; outline: none; }
.dock-bar { display: flex; align-items: center; gap: 2px; padding: 0 4px; border-bottom: 1px solid var(--border); background: var(--card); }
.dock-tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; }
.dock-tab { display: flex; align-items: center; border-bottom: 2px solid transparent; font: 12px var(--mono); color: var(--muted-foreground); }
.dock-tab.active { border-bottom-color: var(--primary-text); color: var(--foreground); }
.dock-tab > button[role="tab"] { padding: 6px 4px 6px 10px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
.dock-ended { opacity: .7; }
.dock-luna { margin-right: 4px; vertical-align: -2px; }
.dock-state { padding: 0 6px; color: var(--muted-foreground); font: 12px var(--mono); white-space: nowrap; }
.dock-action { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: none; color: var(--foreground); font: 12px var(--mono); cursor: pointer; white-space: nowrap; }
.dock-action:hover { background: var(--secondary); }
.dock-close { display: grid; place-items: center; width: 20px; height: 20px; background: none; border: 0; color: inherit; border-radius: var(--radius); cursor: pointer; }
.dock-close:hover { background: var(--secondary); }
.dock-body { display: flex; flex: 1; min-height: 0; }
.dock-message { margin: 0; padding: 4px 10px; color: var(--destructive); font: 12px var(--mono); border-bottom: 1px solid var(--border); }
.dock-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--muted-foreground); font: 13px var(--mono); }
.dock-empty p { margin: 0; }
.dock-link { background: none; border: 0; color: var(--primary-text); font: inherit; text-decoration: underline; cursor: pointer; }
</style>
