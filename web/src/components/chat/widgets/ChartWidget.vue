<script setup lang="ts">
import { ref, computed } from "vue";
import type { ChartWidget } from "@/lib/widgets/schema";

const props = defineProps<{ widget: ChartWidget }>();

const hiddenSeries = ref<Set<string>>(new Set());

function toggleSeries(name: string) {
  const next = new Set(hiddenSeries.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  hiddenSeries.value = next;
}

const activeSeries = computed(() =>
  props.widget.series.filter((s) => !hiddenSeries.value.has(s.name))
);

// SVG Layout dimensions
const width = 600;
const height = 300;
const padding = { top: 24, right: 24, bottom: 44, left: 56 };
const chartWidth = width - padding.left - padding.right;
const chartHeight = height - padding.top - padding.bottom;

// Compute min/max Y across visible series
const allValues = computed(() => {
  const vals: number[] = [];
  for (const s of activeSeries.value) {
    for (const v of s.data) {
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  return vals;
});

// Color follows the series position in the original list, so hiding a series never recolors the others.
function colorIndex(ser: ChartWidget["series"][number]): number {
  return (props.widget.series.indexOf(ser) % 6) + 1;
}

const yMinMax = computed(() => {
  const vals = allValues.value;
  if (!vals.length) return { min: 0, max: 10 };
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min = min - 1;
    max = max + 1;
  }
  if (props.widget.kind === "bar") {
    // Bars start at zero, so the range must contain zero. Pad only the sides that have data.
    const lo = Math.min(min, 0);
    const hi = Math.max(max, 0);
    const barPad = (hi - lo) * 0.1;
    return { min: lo < 0 ? lo - barPad : 0, max: hi > 0 ? hi + barPad : 0 };
  }
  const pad = (max - min) * 0.1 || 1;
  // If all values are >= 0, start y at 0
  const startMin = min >= 0 ? 0 : min - pad;
  return { min: startMin, max: max + pad };
});

const xPoints = computed(() => props.widget.x);

function scaleX(index: number): number {
  const len = xPoints.value.length;
  if (len <= 1) return padding.left + chartWidth / 2;
  return padding.left + (index / (len - 1)) * chartWidth;
}

function scaleY(val: number): number {
  const { min, max } = yMinMax.value;
  if (max === min) return padding.top + chartHeight / 2;
  const ratio = (val - min) / (max - min);
  return padding.top + chartHeight - ratio * chartHeight;
}

// Y axis ticks (5 ticks)
const yTicks = computed(() => {
  const { min, max } = yMinMax.value;
  const count = 5;
  const ticks: { val: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const val = min + (i / (count - 1)) * (max - min);
    ticks.push({ val, y: scaleY(val) });
  }
  return ticks;
});

// Bar chart geometry
const barGroupWidth = computed(() => chartWidth / Math.max(1, xPoints.value.length));
const barWidth = computed(() => {
  const nSeries = Math.max(1, activeSeries.value.length);
  const totalBarSpace = barGroupWidth.value * 0.75;
  return Math.max(2, totalBarSpace / nSeries);
});

// Hover state
const hoveredIndex = ref<number | null>(null);

function handleMouseMove(e: MouseEvent) {
  const svgEl = e.currentTarget as SVGSVGElement;
  const rect = svgEl.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  // Map mouseX from client pixels to SVG viewBox space
  const svgX = (mouseX / rect.width) * width;
  const relX = svgX - padding.left;
  if (relX < 0 || relX > chartWidth) {
    hoveredIndex.value = null;
    return;
  }
  const len = xPoints.value.length;
  if (len <= 1) {
    hoveredIndex.value = 0;
    return;
  }
  const step = chartWidth / (len - 1);
  const idx = Math.round(relX / step);
  hoveredIndex.value = Math.max(0, Math.min(len - 1, idx));
}

function handleMouseLeave() {
  hoveredIndex.value = null;
}

const unitSuffix = computed(() => (props.widget.yUnit ? ` ${props.widget.yUnit}` : ""));
</script>

<template>
  <div class="chart-widget">
    <div v-if="widget.title" class="chart-title">{{ widget.title }}</div>
    <div class="chart-container">
      <svg
        class="chart-svg"
        viewBox="0 0 600 300"
        @mousemove="handleMouseMove"
        @mouseleave="handleMouseLeave"
      >
        <!-- Background grid & axes -->
        <g class="grid-lines">
          <template v-for="(tick, i) in yTicks" :key="i">
            <line
              :x1="padding.left"
              :y1="tick.y"
              :x2="width - padding.right"
              :y2="tick.y"
              stroke="var(--border)"
              stroke-dasharray="3 3"
              stroke-width="1"
            />
            <text
              :x="padding.left - 8"
              :y="tick.y + 4"
              text-anchor="end"
              class="axis-label"
            >
              {{ tick.val.toFixed(tick.val >= 100 ? 0 : 1) }}{{ unitSuffix }}
            </text>
          </template>
        </g>

        <!-- X axis labels -->
        <g class="x-labels">
          <template v-for="(xLabel, i) in xPoints" :key="i">
            <text
              v-if="
                xPoints.length <= 8 ||
                i === 0 ||
                i === xPoints.length - 1 ||
                i % Math.ceil(xPoints.length / 6) === 0
              "
              :x="scaleX(i)"
              :y="height - padding.bottom + 20"
              text-anchor="middle"
              class="axis-label"
            >
              {{ xLabel }}
            </text>
          </template>
        </g>

        <!-- Bar chart rendering -->
        <g v-if="widget.kind === 'bar'" class="bars">
          <template v-for="(ser, sIdx) in activeSeries" :key="ser.name">
            <g :fill="`var(--chart-${colorIndex(ser)})`">
              <template v-for="(val, xIdx) in ser.data" :key="xIdx">
                <rect
                  v-if="Number.isFinite(val)"
                  :x="
                    scaleX(xIdx) -
                    (activeSeries.length * barWidth) / 2 +
                    sIdx * barWidth
                  "
                  :y="val >= 0 ? scaleY(val) : scaleY(0)"
                  :width="barWidth - 1"
                  :height="Math.max(1, Math.abs(scaleY(val) - scaleY(0)))"
                  rx="2"
                  class="chart-bar"
                />
              </template>
            </g>
          </template>
        </g>

        <!-- Line chart rendering -->
        <g v-else class="lines">
          <template v-for="ser in activeSeries" :key="ser.name">
            <!-- Line path -->
            <path
              :d="
                ser.data
                  .map((val, idx) => {
                    if (!Number.isFinite(val)) return '';
                    const cmd = idx === 0 || !Number.isFinite(ser.data[idx - 1]) ? 'M' : 'L';
                    return `${cmd} ${scaleX(idx)} ${scaleY(val)}`;
                  })
                  .filter(Boolean)
                  .join(' ')
              "
              fill="none"
              :stroke="`var(--chart-${colorIndex(ser)})`"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="chart-line"
            />
            <!-- Data points -->
            <template v-for="(val, xIdx) in ser.data" :key="xIdx">
              <circle
                v-if="Number.isFinite(val)"
                :cx="scaleX(xIdx)"
                :cy="scaleY(val)"
                r="3"
                :fill="`var(--chart-${colorIndex(ser)})`"
                class="chart-dot"
              />
            </template>
          </template>
        </g>

        <!-- Hover crosshair & points -->
        <g v-if="hoveredIndex !== null">
          <line
            :x1="scaleX(hoveredIndex)"
            :y1="padding.top"
            :x2="scaleX(hoveredIndex)"
            :y2="height - padding.bottom"
            stroke="var(--muted-foreground)"
            stroke-dasharray="2 2"
            stroke-width="1"
          />
          <template v-for="ser in activeSeries" :key="ser.name">
            <circle
              v-if="Number.isFinite(ser.data[hoveredIndex])"
              :cx="scaleX(hoveredIndex)"
              :cy="scaleY(ser.data[hoveredIndex]!)"
              r="4.5"
              :fill="`var(--card)`"
              :stroke="`var(--chart-${colorIndex(ser)})`"
              stroke-width="2.5"
            />
          </template>
        </g>
      </svg>
    </div>

    <!-- Hover tooltip readout -->
    <div class="chart-readout" :class="{ visible: hoveredIndex !== null }">
      <template v-if="hoveredIndex !== null">
        <span class="readout-x">{{ xPoints[hoveredIndex] }}</span>
        <div class="readout-items">
          <span
            v-for="ser in activeSeries"
            :key="ser.name"
            class="readout-item"
            :style="{ color: `var(--chart-${colorIndex(ser)})` }"
          >
            <strong>{{ ser.name }}:</strong>
            {{ Number.isFinite(ser.data[hoveredIndex]) ? ser.data[hoveredIndex] : "N/A" }}{{ unitSuffix }}
          </span>
        </div>
      </template>
    </div>

    <!-- Legend toggles -->
    <div class="chart-legend">
      <button
        v-for="(ser, sIdx) in widget.series"
        :key="ser.name"
        type="button"
        class="legend-btn"
        :aria-pressed="!hiddenSeries.has(ser.name)"
        @click="toggleSeries(ser.name)"
      >
        <span
          class="legend-dot"
          :style="{
            backgroundColor: hiddenSeries.has(ser.name)
              ? 'var(--muted-foreground)'
              : `var(--chart-${(sIdx % 6) + 1})`,
          }"
        />
        <span class="legend-text">{{ ser.name }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.chart-widget {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  padding: 12px;
  background-color: var(--card);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  font-family: inherit;
  box-sizing: border-box;
}

.chart-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--card-foreground);
  margin-bottom: 2px;
}

.chart-container {
  width: 100%;
  position: relative;
  background-color: rgba(0, 0, 0, 0.15);
  border-radius: var(--radius);
  overflow: hidden;
}

.chart-svg {
  width: 100%;
  height: auto;
  display: block;
  cursor: crosshair;
}

.axis-label {
  font-size: 10px;
  fill: var(--muted-foreground);
}

.chart-bar {
  transition: opacity 0.2s ease;
}
.chart-bar:hover {
  opacity: 0.85;
}

.chart-line {
  transition: d 0.2s ease;
}

.chart-readout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
  padding: 4px 8px;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
  background-color: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.chart-readout.visible {
  opacity: 1;
}

.readout-x {
  font-weight: 600;
  color: var(--foreground);
}

.readout-items {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.readout-item strong {
  margin-right: 4px;
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.legend-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--card-foreground);
  background-color: var(--secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.legend-btn:hover {
  background-color: var(--accent);
  border-color: var(--ring);
}

.legend-btn[aria-pressed="false"] {
  opacity: 0.5;
  text-decoration: line-through;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.legend-text {
  line-height: 1;
}
</style>
