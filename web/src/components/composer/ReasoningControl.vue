<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import { Zap } from "@lucide/vue";
import { LEVELS, availableLevels, availableSpeeds, effectiveSpeed, isSiblingModel, levelLabel, models, setSpeed, setThinking, speedLabel, type Speed } from "@/stores/models";
import { busy, chat } from "@/stores/chat";

const trigger = ref<HTMLButtonElement | null>(null);
const picker = ref<HTMLElement | null>(null);
const open = ref(false);
const scrubbing = ref(false);

// Only the selected model's levels are offered; colors and LED heights keep their place on the full scale.
const levels = availableLevels;
const siblingBusy = computed(() => isSiblingModel.value && busy.value);
const index = computed(() => Math.max(0, levels.value.indexOf(models.thinking)));
const preview = ref(index.value);
const active = computed(() => (open.value ? preview.value : index.value));

const colors = [
  "var(--muted-foreground)", // Off
  "var(--info)",             // Minimal
  "var(--success)",          // Low
  "var(--status-finished)",  // Medium
  "var(--warning)",          // High
  "var(--status-limit)",     // Xhigh
  "var(--primary-text)",     // Max
  "var(--primary-text)",     // Ultra
];

const shortLabels = ["OFF", "MIN", "LOW", "MED", "HIGH", "XHGH", "MAX", "ULTRA"];

const scale = (level: string | undefined) => Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]));
const activeLevel = computed(() => levels.value[active.value] ?? levels.value[0] ?? "off");
const activeScale = computed(() => scale(activeLevel.value));
const color = computed(() => colors[activeScale.value] ?? colors[0]);
const label = computed(() => levelLabel(activeLevel.value));

// OpenAI speed tiers: one lightning button cycles Standard, Fast, Ultrafast (where the model offers it).
const speedColors: Record<Speed, string> = { fast: "var(--warning)", ultrafast: "var(--primary-text)" };
const speedTitle = computed(() => `Speed: ${speedLabel(effectiveSpeed.value)}`);
function cycleSpeed() {
  const order: (Speed | null)[] = [null, ...availableSpeeds.value];
  void setSpeed(order[(order.indexOf(effectiveSpeed.value) + 1) % order.length] ?? null);
}

function position() {
  if (!trigger.value || !picker.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const viewport = window.visualViewport;
  const visible = viewport?.scale === 1 ? viewport : null;
  const vpLeft = visible?.offsetLeft ?? 0;
  const vpTop = visible?.offsetTop ?? 0;
  const vpWidth = visible?.width ?? innerWidth;
  const vpHeight = visible?.height ?? innerHeight;
  const width = Math.min(320, vpWidth - 16);
  const anchorTop = Math.max(vpTop + 8, Math.min(rect.top, vpTop + vpHeight - 8));
  const anchorBottom = Math.max(vpTop + 8, Math.min(rect.bottom, vpTop + vpHeight - 8));
  const above = Math.max(0, anchorTop - vpTop - 16);
  const below = Math.max(0, vpTop + vpHeight - anchorBottom - 16);
  const useAbove = above >= 140 || above >= below;
  Object.assign(picker.value.style, {
    width: `${width}px`,
    left: `${Math.max(vpLeft + 8, Math.min(rect.right - width, vpLeft + vpWidth - width - 8))}px`,
    bottom: useAbove ? `${innerHeight - anchorTop + 10}px` : "auto",
    top: useAbove ? "auto" : `${anchorBottom + 10}px`,
    right: "auto",
    maxHeight: `${Math.max(120, Math.min(320, useAbove ? above : below))}px`,
    overflowY: "auto",
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

async function selectLevel(i: number) {
  if (siblingBusy.value) return;
  const clamped = Math.max(0, Math.min(levels.value.length - 1, i));
  preview.value = clamped;
  const ok = await setThinking(levels.value[clamped]!);
  if (!ok) preview.value = index.value;
}

function handlePointerDown(i: number, event: PointerEvent) {
  if (siblingBusy.value) return;
  scrubbing.value = true;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
  void selectLevel(i);
}

function handlePointerEnter(i: number) {
  if (scrubbing.value && !siblingBusy.value) {
    void selectLevel(i);
  }
}

function stopScrub() {
  scrubbing.value = false;
}

let lastWheel = 0;
function handleWheel(event: WheelEvent) {
  if (event.deltaY === 0 || siblingBusy.value) return;
  event.preventDefault();
  const now = performance.now();
  if (now - lastWheel < 80) return;
  lastWheel = now;
  void selectLevel(preview.value + (event.deltaY < 0 ? 1 : -1));
}

function handleKeydown(event: KeyboardEvent) {
  if (siblingBusy.value) return;
  if (event.key >= "1" && event.key <= String(levels.value.length)) {
    event.preventDefault();
    void selectLevel(Number(event.key) - 1);
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "l" || event.key === "k") {
    event.preventDefault();
    void selectLevel(active.value + 1);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "h" || event.key === "j") {
    event.preventDefault();
    void selectLevel(active.value - 1);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    void selectLevel(0);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    void selectLevel(levels.value.length - 1);
  }
}

watch(index, value => {
  preview.value = value;
});
watch(() => chat.session, () => picker.value?.hidePopover());

onMounted(() => {
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  window.addEventListener("pointerup", stopScrub);
});
onUnmounted(() => {
  window.removeEventListener("resize", position);
  window.visualViewport?.removeEventListener("resize", position);
  window.visualViewport?.removeEventListener("scroll", position);
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
    :title="siblingBusy ? `Reasoning level: ${label} (finish run to change)` : `Reasoning level: ${label}`"
    :style="{ '--reasoning-color': color }"
    @wheel.prevent="handleWheel"
  >
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
        :disabled="siblingBusy"
        :aria-checked="i === active"
        :aria-label="levelLabel(level)"
        :title="siblingBusy ? 'Cannot switch model while busy' : levelLabel(level)"
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
    <p v-if="siblingBusy" class="reasoning-busy-note">Finish the active run to switch levels.</p>
    <p v-else class="reasoning-hint">Click, drag, or scroll to adjust</p>
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
  gap: 6px;
}

.eq-channel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-width: 44px;
  min-height: 44px;
  padding: 9px 6px 8px;
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

.eq-channel:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.eq-channel:disabled:hover {
  border-color: var(--border);
  background: var(--background);
}

.reasoning-busy-note,
.reasoning-hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--muted-foreground);
}

.reasoning-hint {
  text-align: center;
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
  height: 5px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--muted-foreground) 16%, var(--secondary));
  opacity: 1;
  transition: background-color 0.1s, opacity 0.1s;
}

.eq-led.dim {
  background: color-mix(in srgb, var(--muted-foreground) 38%, transparent);
  opacity: 1;
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
  font-size: 10px;
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

@media (max-width: 760px), (pointer: coarse) {
  #think {
    min-height: 44px;
    height: 44px;
    padding: 0 10px;
    gap: 5px;
  }

  #speed {
    min-height: 44px;
    height: 44px;
    min-width: 44px;
    padding: 0 10px;
  }
}
</style>
