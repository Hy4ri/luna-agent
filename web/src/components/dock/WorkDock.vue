<script setup lang="ts">
// The dock frame: position (bottom or right), size, and the resize handle. The panes supply their own bar and body.
import { computed } from "vue";
import { clampHeight, clampWidth, dock, effectivePosition, setWidth } from "@/stores/dock";
import { setHeight, terminal } from "@/stores/terminal";

defineProps<{ label: string }>();
const side = computed(() => effectivePosition(dock.position, dock.area) === "right");
// Width is limited by the chat area, not the window: the sidebar and rail sit beside it.
const area = computed(() => (Number.isFinite(dock.area) ? dock.area : window.innerWidth));
const size = computed(() => side.value ? { width: clampWidth(dock.width, area.value) + "px" } : { height: clampHeight(terminal.height) + "px" });

// The handle sits on the dock's inner edge: top for the bottom dock, left for the side dock. Dragging toward the chat grows the dock.
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
  <section class="work-dock" :class="side ? 'is-side' : 'is-bottom'" :aria-label="label" :style="size">
    <div class="dock-resize" role="separator" :aria-orientation="side ? 'vertical' : 'horizontal'" :aria-label="`Resize ${label.toLowerCase()}`" :aria-valuenow="side ? dock.width : terminal.height" tabindex="0" @pointerdown.prevent="startResize" @keydown="resizeKey" />
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
</style>
