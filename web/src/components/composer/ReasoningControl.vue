<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import { Zap } from "@lucide/vue";
import { LEVELS, availableLevels, availableSpeeds, effectiveSpeed, levelLabel, models, setSpeed, setThinking, speedLabel, type Speed } from "@/stores/models";
import { chat } from "@/stores/chat";

const trigger = ref<HTMLButtonElement | null>(null);
const picker = ref<HTMLElement | null>(null);
const open = ref(false);
const scrubbing = ref(false);

// Only the selected model's levels are offered; colors and LED heights keep their place on the full scale.
const levels = availableLevels;
const index = computed(() => Math.max(0, levels.value.indexOf(models.thinking)));
const preview = ref(index.value);
const active = computed(() => (open.value ? preview.value : index.value));

const colors = [
  "#9ba1a6", // Off
  "#7dd3fc", // Minimal
  "#5eead4", // Low
  "#86d3a0", // Medium
  "#e6c27a", // High
  "#f4a571", // Xhigh
  "#e86060", // Max
  "#990000", // Ultra
];

const shortLabels = ["OFF", "MIN", "LOW", "MED", "HIGH", "XHGH", "MAX", "ULTRA"];

const scale = (level: string | undefined) => Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]));
const activeLevel = computed(() => levels.value[active.value] ?? levels.value[0] ?? "off");
const activeScale = computed(() => scale(activeLevel.value));
const color = computed(() => colors[activeScale.value] ?? colors[0]);
const label = computed(() => levelLabel(activeLevel.value));

// Vertical stack of 8 LED segments for the small composer trigger (top = Max, bottom = Off)
const triggerSlices = LEVELS.map((level, i) => ({
  level,
  index: i,
  color: colors[i]!,
  y: 1 + (LEVELS.length - 1 - i) * 2.2,
})).reverse();

// OpenAI speed tiers: one lightning button cycles Standard, Fast, Ultrafast (where the model offers it).
const speedColors: Record<Speed, string> = { fast: "#e6c27a", ultrafast: "#e86060" };
const speedTitle = computed(() => `Speed: ${speedLabel(effectiveSpeed.value)}`);
function cycleSpeed() {
  const order: (Speed | null)[] = [null, ...availableSpeeds.value];
  void setSpeed(order[(order.indexOf(effectiveSpeed.value) + 1) % order.length] ?? null);
}

function position() {
  if (!trigger.value || !picker.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = Math.min(288, innerWidth - 16);
  Object.assign(picker.value.style, {
    width: `${width}px`,
    left: `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`,
    bottom: `${innerHeight - rect.top + 8}px`,
    top: "auto",
    right: "auto",
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
  if (!open.value) {
    scrubbing.value = false;
    preview.value = index.value;
  }
}

function selectLevel(i: number) {
  const clamped = Math.max(0, Math.min(levels.value.length - 1, i));
  preview.value = clamped;
  void setThinking(levels.value[clamped]!);
}

function handlePointerDown(i: number, event: PointerEvent) {
  scrubbing.value = true;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  selectLevel(i);
}

function handlePointerEnter(i: number) {
  if (scrubbing.value) {
    selectLevel(i);
  }
}

function stopScrub() {
  scrubbing.value = false;
}

let lastWheel = 0;
function handleWheel(event: WheelEvent) {
  if (event.deltaY === 0) return;
  event.preventDefault();
  const now = performance.now();
  if (now - lastWheel < 80) return;
  lastWheel = now;
  selectLevel(preview.value + (event.deltaY < 0 ? 1 : -1));
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key >= "1" && event.key <= String(levels.value.length)) {
    event.preventDefault();
    selectLevel(Number(event.key) - 1);
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "l" || event.key === "k") {
    event.preventDefault();
    selectLevel(active.value + 1);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "h" || event.key === "j") {
    event.preventDefault();
    selectLevel(active.value - 1);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    selectLevel(0);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    selectLevel(levels.value.length - 1);
  }
}

watch(index, value => {
  preview.value = value;
});
watch(() => chat.session, () => picker.value?.hidePopover());

onMounted(() => {
  window.addEventListener("resize", position);
  window.addEventListener("pointerup", stopScrub);
});
onUnmounted(() => {
  window.removeEventListener("resize", position);
  window.removeEventListener("pointerup", stopScrub);
});
</script>

<template>
  <button
    id="think"
    ref="trigger"
    type="button"
    popovertarget="reasoning-picker"
    :aria-expanded="open"
    aria-controls="reasoning-picker"
    aria-haspopup="dialog"
    :aria-label="`Reasoning level: ${label}`"
    :title="`Reasoning level: ${label}`"
    :style="{ '--reasoning-color': color }"
    @wheel.prevent="handleWheel"
  >
    <svg class="think-eq-icon" viewBox="0 0 12 18" fill="none" aria-hidden="true">
      <rect
        v-for="item in triggerSlices"
        :key="item.level"
        :data-level="item.level"
        :data-active="item.index <= activeScale"
        x="1"
        :y="item.y"
        width="10"
        height="1.6"
        rx="0.4"
        :fill="item.index <= activeScale ? item.color : 'var(--muted-foreground)'"
        :opacity="item.index <= activeScale ? 1 : 0.24"
      />
    </svg>
    <span class="think-level-text">{{ label }}</span>
  </button>

  <button
    v-if="availableSpeeds.length"
    id="speed"
    type="button"
    :aria-pressed="!!effectiveSpeed"
    :aria-label="speedTitle"
    :title="speedTitle"
    :data-speed="effectiveSpeed ?? 'standard'"
    :style="effectiveSpeed ? { '--speed-color': speedColors[effectiveSpeed] } : undefined"
    @click="cycleSpeed"
  >
    <Zap :size="14" aria-hidden="true" :fill="effectiveSpeed ? 'currentColor' : 'none'" />
  </button>

  <div
    id="reasoning-picker"
    ref="picker"
    popover
    role="dialog"
    aria-label="Reasoning level"
    tabindex="-1"
    :style="{ '--reasoning-color': color }"
    @beforetoggle="beforeToggle"
    @toggle="toggle"
    @keydown="handleKeydown"
  >
    <div class="reasoning-heading">
      <span class="reasoning-title">Reasoning level</span>
      <output class="reasoning-output">{{ label }}</output>
    </div>

    <div class="eq-fader-rack" role="radiogroup" aria-label="Reasoning level" :style="{ '--channels': levels.length }">
      <button
        v-for="(level, i) in levels"
        :key="level"
        type="button"
        role="radio"
        class="eq-channel"
        :class="{ active: i === active, engaged: i <= active }"
        :aria-checked="i === active"
        :aria-label="levelLabel(level)"
        :title="levelLabel(level)"
        :style="{ '--ch-color': colors[scale(level)] }"
        :autofocus="i === active"
        @pointerdown="handlePointerDown(i, $event)"
        @pointerenter="handlePointerEnter(i)"
        @click="selectLevel(i)"
      >
        <span class="eq-leds" aria-hidden="true">
          <span
            v-for="seg in 7"
            :key="seg"
            class="eq-led"
            :class="{
              lit: 8 - seg <= scale(level) + 1 && i <= active,
              dim: 8 - seg <= scale(level) + 1 && i > active,
              peak: 8 - seg === scale(level) + 1,
            }"
          ></span>
        </span>
        <span class="eq-cap">{{ shortLabels[scale(level)] }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
#think {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
}

#think:hover,
#think[aria-expanded="true"] {
  background: var(--secondary);
  border-color: var(--border);
  color: var(--foreground);
}

#think:focus-visible {
  outline: 2px solid var(--reasoning-color);
  outline-offset: 2px;
}

.think-eq-icon {
  width: 12px;
  height: 18px;
  flex: none;
  display: block;
}

.think-level-text {
  color: var(--reasoning-color);
  font-weight: 600;
  white-space: nowrap;
}

#reasoning-picker {
  position: fixed;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--foreground);
  box-shadow: var(--shadow);
  user-select: none;
}

#reasoning-picker:focus-visible {
  outline: none;
}

.reasoning-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  margin-bottom: 12px;
}

.reasoning-title {
  color: var(--muted-foreground);
}

.reasoning-output {
  color: var(--reasoning-color);
  font-weight: 600;
}

.eq-fader-rack {
  display: grid;
  grid-template-columns: repeat(var(--channels, 7), minmax(0, 1fr));
  gap: 5px;
}

.eq-channel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 7px 3px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--background);
  color: var(--muted-foreground);
  cursor: pointer;
  touch-action: none;
  transition: border-color 0.12s, background-color 0.12s;
}

.eq-channel:hover {
  border-color: var(--muted-foreground);
  background: var(--secondary);
}

.eq-channel.active {
  border-color: var(--ch-color);
  background: color-mix(in srgb, var(--ch-color) 12%, var(--background));
}

.eq-channel:focus-visible {
  outline: 2px solid var(--ch-color);
  outline-offset: 1px;
}

.eq-leds {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0 3px;
}

.eq-led {
  display: block;
  width: 100%;
  height: 6px;
  border-radius: 1px;
  background: var(--secondary);
  opacity: 0.45;
  transition: background-color 0.1s, opacity 0.1s;
}

.eq-led.dim {
  background: var(--muted-foreground);
  opacity: 0.25;
}

.eq-led.lit {
  background: var(--ch-color);
  opacity: 0.85;
}

.eq-channel.active .eq-led.lit {
  opacity: 1;
}

.eq-channel.active .eq-led.peak {
  box-shadow: 0 0 6px color-mix(in srgb, var(--ch-color) 65%, transparent);
}

.eq-cap {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1;
  color: var(--muted-foreground);
}

.eq-channel.engaged .eq-cap {
  color: var(--foreground);
}

.eq-channel.active .eq-cap {
  color: var(--ch-color);
  font-weight: 700;
}

#speed {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 32px;
  min-width: 28px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}

#speed:hover {
  background: var(--secondary);
  border-color: var(--border);
  color: var(--foreground);
}

#speed[aria-pressed="true"] {
  color: var(--speed-color);
}

#speed:focus-visible {
  outline: 2px solid var(--speed-color, var(--muted-foreground));
  outline-offset: 2px;
}

@media (max-width: 760px) {
  #think {
    padding: 0 6px;
    gap: 5px;
  }
}
</style>
