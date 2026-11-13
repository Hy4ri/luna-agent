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

function paneTabKey(event: KeyboardEvent, index: number) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const list = panes.value;
  const last = list.length - 1;
  if (last < 0) return;
  const next = event.key === "ArrowRight" ? (index + 1) % (last + 1)
    : event.key === "ArrowLeft" ? (index + last) % (last + 1)
    : event.key === "Home" ? 0
    : event.key === "End" ? last
    : -1;
  if (next < 0) return;
  event.preventDefault();
  const target = list[next]!;
  setPane(target.id);
  (document.getElementById(`dock-tab-${target.id}`) as HTMLElement | null)?.focus();
}

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
    <div
      class="dock-resize"
      role="separator"
      :aria-orientation="side ? 'vertical' : 'horizontal'"
      :aria-label="`Resize ${(label || 'dock').toLowerCase()}`"
      :aria-valuemin="side ? 320 : 120"
      :aria-valuemax="side ? Math.round(area * 0.7) : Math.round(800)"
      :aria-valuenow="side ? dock.width : terminal.height"
      tabindex="0"
      @pointerdown.prevent="startResize"
      @keydown="resizeKey"
    />
    <header class="global-dock-bar">
      <div class="global-dock-tabs" role="tablist" aria-label="Workspace panels">
        <button
          v-for="(p, i) in panes"
          :id="`dock-tab-${p.id}`"
          :key="p.id"
          type="button"
          role="tab"
          class="global-dock-tab"
          :class="{ active: dock.pane === p.id }"
          :aria-selected="dock.pane === p.id"
          :tabindex="dock.pane === p.id ? 0 : -1"
          @click="setPane(p.id)"
          @keydown="paneTabKey($event, i)"
        >
          <SquareTerminal v-if="p.id === 'terminal'" :size="14" aria-hidden="true" />
          <Globe v-else-if="p.id === 'browser'" :size="14" aria-hidden="true" />
          <Mail v-else :size="14" aria-hidden="true" />
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
.dock-resize::after { content: ""; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); border-radius: var(--radius); background: var(--border); opacity: 0.45; transition: opacity .15s, background .15s; }
.is-bottom > .dock-resize { inset: -3px 0 auto; height: 6px; cursor: ns-resize; }
.is-bottom > .dock-resize::after { width: 32px; height: 2px; }
.is-side > .dock-resize { inset: 0 auto 0 -3px; width: 6px; cursor: ew-resize; }
.is-side > .dock-resize::after { width: 2px; height: 32px; }
.dock-resize:hover::after { opacity: 1; background: var(--muted-foreground); }
.dock-resize:focus-visible { background: color-mix(in srgb, var(--ring) 25%, transparent); outline: 2px solid var(--ring); outline-offset: -1px; }
.global-dock-bar { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 6px; min-height: 36px; flex-shrink: 0; border-bottom: 1px solid var(--border); background: var(--sidebar); }
.global-dock-tabs { display: flex; align-items: stretch; gap: 2px; min-height: 36px; overflow-x: auto; }
.global-dock-tab { display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted-foreground); font: 12px var(--mono); cursor: pointer; white-space: nowrap; }
.global-dock-tab:hover { color: var(--foreground); }
.global-dock-tab:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.global-dock-tab.active { color: var(--foreground); font-weight: 600; border-bottom-color: var(--primary); background: var(--card); }
.global-dock-badge { padding: 0 5px; border-radius: var(--radius); background: var(--primary); color: var(--primary-foreground); font-size: 10px; line-height: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.global-dock-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
@media (max-width: 760px), (pointer: coarse) {
  .global-dock-bar { min-height: 44px; }
  .global-dock-tabs { min-height: 44px; }
  .global-dock-tab { min-height: 44px; padding: 0 14px; }
  .global-dock-actions .icon-button { width: 44px; height: 44px; }
}
</style>
