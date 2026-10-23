<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import { LEVELS, levelLabel, models, setThinking } from "@/stores/models";
import { chat } from "@/stores/chat";

const trigger = ref<HTMLButtonElement | null>(null);
const picker = ref<HTMLElement | null>(null);
const open = ref(false);
const index = computed(() => Math.max(0, LEVELS.findIndex(level => level === models.thinking)));
const preview = ref(index.value);
const active = computed(() => open.value ? preview.value : index.value);
const colors = ["#9ba1a6", "#7dd3fc", "#5eead4", "#86d3a0", "#e6c27a", "#f4a571", "#c4a1f5"];
const color = computed(() => colors[active.value]);
const label = computed(() => levelLabel(LEVELS[active.value]!));
const point = (i: number, radius: number) => {
  const angle = (-190 + i * 200 / (LEVELS.length - 1)) * Math.PI / 180;
  return { x: 12 + Math.cos(angle) * radius, y: 15 + Math.sin(angle) * radius };
};
const ticks = LEVELS.map((level, i) => ({ level, outer: point(i, 9), inner: point(i, 6.8) }));
const needle = computed(() => point(active.value, 5));

function position() {
  if (!trigger.value || !picker.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = Math.min(280, innerWidth - 16);
  Object.assign(picker.value.style, {
    width: `${width}px`,
    left: `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`,
    bottom: `${innerHeight - rect.top + 8}px`,
    top: "auto", right: "auto",
  });
}
function beforeToggle(event: Event) {
  if ((event as ToggleEvent).newState === "open") {
    preview.value = index.value;
    position();
  }
}
function toggle(event: Event) {
  open.value = (event as ToggleEvent).newState === "open";
  if (!open.value) preview.value = index.value;
}
function change(event: Event) {
  preview.value = Number((event.target as HTMLInputElement).value);
  void setThinking(LEVELS[preview.value]!);
}
watch(index, value => { preview.value = value; });
watch(() => chat.session, () => picker.value?.hidePopover());
onMounted(() => window.addEventListener("resize", position));
onUnmounted(() => window.removeEventListener("resize", position));
</script>

<template>
  <button
    id="think"
    ref="trigger"
    type="button"
    class="icon-button"
    popovertarget="reasoning-picker"
    :aria-expanded="open"
    aria-controls="reasoning-picker"
    aria-haspopup="dialog"
    :aria-label="`Reasoning level: ${label}`"
    :title="`Reasoning level: ${label}`"
    :style="{ color }"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
      <path d="M 3.14 16.56 A 9 9 0 1 1 20.86 16.56" stroke-width="1" opacity=".2" />
      <line v-for="(tick, i) in ticks" :key="tick.level" :data-level="tick.level" :data-active="i <= active"
        :x1="tick.inner.x" :y1="tick.inner.y" :x2="tick.outer.x" :y2="tick.outer.y"
        :stroke="i <= active ? colors[i] : 'var(--muted-foreground)'" :opacity="i <= active ? 1 : .22" stroke-width="1.8" />
      <path :d="`M 12 15 L ${needle.x} ${needle.y}`" stroke-width="1.8" />
      <circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  </button>
  <div id="reasoning-picker" ref="picker" popover role="dialog" aria-label="Reasoning level"
    :style="{ '--reasoning-color': color }" @beforetoggle="beforeToggle" @toggle="toggle">
    <div class="reasoning-heading"><label for="reasoning-slider">Reasoning level</label><output for="reasoning-slider">{{ label }}</output></div>
    <input id="reasoning-slider" type="range" min="0" :max="LEVELS.length - 1" step="1" :value="preview"
      aria-label="Reasoning level" :aria-valuetext="label" autofocus
      @input="preview = Number(($event.target as HTMLInputElement).value)" @change="change" />
    <div class="reasoning-stops" aria-hidden="true"><span v-for="(level, i) in LEVELS" :key="level" :class="{ active: i === active }"></span></div>
    <div class="reasoning-endpoints" aria-hidden="true"><span>Off</span><span>Max</span></div>
  </div>
</template>

<style scoped>
#think { flex: none; width: 36px; height: 36px; border: 1px solid transparent; background: transparent; }
#think:hover, #think[aria-expanded="true"] { background: var(--accent); border-color: var(--border); }
#think svg { width: 25px; height: 25px; }
#reasoning-picker { position: fixed; margin: 0; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); color: var(--foreground); box-shadow: var(--shadow); }
.reasoning-heading, .reasoning-endpoints { display: flex; align-items: center; justify-content: space-between; }
.reasoning-heading { font-size: 13px; margin-bottom: 14px; gap: 16px; }
.reasoning-heading output { color: var(--reasoning-color); font-weight: 600; }
#reasoning-slider { display: block; width: 100%; min-height: 28px; margin: 0; padding: 0; accent-color: var(--reasoning-color); cursor: pointer; }
.reasoning-stops { display: flex; align-items: center; justify-content: space-between; padding: 0 7px; pointer-events: none; }
.reasoning-stops span { height: 3px; width: 1px; background: var(--muted-foreground); opacity: .5; }
.reasoning-stops span.active { height: 9px; width: 2px; border-radius: 1px; background: var(--reasoning-color); opacity: 1; }
.reasoning-endpoints { margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
</style>
