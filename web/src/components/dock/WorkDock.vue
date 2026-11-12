<script setup lang="ts">
// The dock frame: position (bottom or right), size, global pane tabs (Terminal, Browser, Mail), and resize handle.
import { computed } from "vue";
import { ChevronDown, Globe, Mail, PanelBottom, PanelRight, SquareTerminal } from "@lucide/vue";
import { clampHeight, clampWidth, dock, effectivePosition, setPane, setPosition, setWidth, type DockPane } from "@/stores/dock";
import { setHeight, terminal } from "@/stores/terminal";
import { browser } from "@/stores/browser";
import { mailUnreadTotal } from "@/stores/mail";

defineProps<{ label?: string }>();
const side = computed(() => effectivePosition(dock.position, dock.area) === "right");
const forced = computed(() => effectivePosition("right", dock.area) === "bottom");
const area = computed(() => (Number.isFinite(dock.area) ? dock.area : window.innerWidth));
const size = computed(() => side.value ? { width: clampWidth(dock.width, area.value) + "px" } : { height: clampHeight(terminal.height) + "px" });
const togglePos = () => setPosition(dock.position === "right" ? "bottom" : "right");

const panes = computed(() => {
  const list: Array<{ id: DockPane; label: string; badge?: number }> = [
    { id: "terminal", label: "Terminal" },
  ];
  if (browser.enabled) list.push({ id: "browser", label: "Browser" });
  list.push({ id: "mail", label: "Mail", badge: mailUnreadTotal.value || undefined });
  return list;
});

function startResize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement;
  const vertical = side.value;
  const start = vertical ? event.clientX : event.clientY;
  const startSize = vertical ? dock.width : terminal.height;
  handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    const delta = vertical ? start - e.clientX : start - e.clientY;
    if (vertical) setWidth(startSize + delta, area.value); else setHeight(startSize + delta);
  };
  const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}
function resizeKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const step = event.shiftKey ? 80 : 24;
  const grow = side.value ? "ArrowLeft" : "ArrowUp", shrink = side.value ? "ArrowRight" : "ArrowDown";
  const apply = (delta: number) => side.value ? setWidth(dock.width + delta, area.value) : setHeight(terminal.height + delta);
  if (event.key === grow) { event.preventDefault(); apply(step); }
  else if (event.key === shrink) { event.preventDefault(); apply(-step); }
}
</script>

<template>
  <section class="work-dock" :class="side ? 'is-side' : 'is-bottom'" :aria-label="label || 'Workspace dock'" :style="size">
    <div class="dock-resize" role="separator" :aria-orientation="side ? 'vertical' : 'horizontal'" :aria-label="`Resize ${(label || 'dock').toLowerCase()}`" :aria-valuenow="side ? dock.width : terminal.height" tabindex="0" @pointerdown.prevent="startResize" @keydown="resizeKey" />
    <header class="global-dock-bar">
      <div class="global-dock-tabs" role="tablist" aria-label="Workspace panels">
        <button
          v-for="p in panes"
          :key="p.id"
          type="button"
          role="tab"
          class="global-dock-tab"
          :class="{ active: dock.pane === p.id }"
          :aria-selected="dock.pane === p.id"
          @click="setPane(p.id)"
        >
          <SquareTerminal v-if="p.id === 'terminal'" :size="14" />
          <Globe v-else-if="p.id === 'browser'" :size="14" />
          <Mail v-else :size="14" />
          <span>{{ p.label }}</span>
          <span v-if="p.badge" class="global-dock-badge">{{ p.badge }}</span>
        </button>
      </div>
      <div class="global-dock-actions">
        <button type="button" class="icon-button" :aria-pressed="side" :disabled="forced" :aria-label="side ? 'Move dock to the bottom' : 'Move dock to the side'" :title="forced ? 'Too narrow for a side dock' : side ? 'Move dock to the bottom' : 'Move dock to the side'" @click="togglePos">
          <PanelBottom v-if="side" :size="14" /><PanelRight v-else :size="14" />
        </button>
        <button type="button" class="icon-button" aria-label="Hide dock" title="Hide dock" @click="terminal.open = false"><ChevronDown :size="14" /></button>
      </div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.work-dock { position: relative; display: flex; flex-direction: column; flex: none; min-height: 0; min-width: 0; background: var(--background); }
.work-dock.is-bottom { border-top: 1px solid var(--border); }
.work-dock.is-side { border-left: 1px solid var(--border); }
.dock-resize { position: absolute; z-index: 2; touch-action: none; }
.is-bottom > .dock-resize { inset: -3px 0 auto; height: 6px; cursor: ns-resize; }
.is-side > .dock-resize { inset: 0 auto 0 -3px; width: 6px; cursor: ew-resize; }
.dock-resize:hover, .dock-resize:focus-visible { background: var(--ring); opacity: .5; outline: none; }
.global-dock-bar { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 0 6px; height: 34px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--sidebar); }
.global-dock-tabs { display: flex; align-items: stretch; gap: 2px; height: 100%; overflow-x: auto; }
.global-dock-tab { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted-foreground); font: 12px var(--mono); cursor: pointer; white-space: nowrap; }
.global-dock-tab:hover { color: var(--foreground); }
.global-dock-tab.active { color: var(--foreground); border-bottom-color: var(--primary-text); background: var(--card); }
.global-dock-badge { padding: 0 5px; border-radius: 999px; background: var(--primary); color: var(--primary-foreground); font-size: 10px; line-height: 16px; font-weight: 600; }
.global-dock-actions { display: flex; align-items: center; gap: 2px; }
</style>
