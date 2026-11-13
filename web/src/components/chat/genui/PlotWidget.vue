<script setup lang="ts">
import { ref, computed } from "vue";
import type { PlotWidget } from "@/lib/widgets/schema";
import { compileExpr } from "@/lib/widgets/expr";

const props = defineProps<{
  widget: PlotWidget;
}>();

// Param state, initialised synchronously so the first render already has values.
const paramValues = ref<Record<string, number>>(
  Object.fromEntries(Object.entries(props.widget.params || {}).map(([k, p]) => [k, p.value])),
);

const compiled = computed(() => {
  const paramNames = Object.keys(props.widget.params || {});
  return compileExpr(props.widget.expr, paramNames);
});

// Sample 200 points across x
const SAMPLE_COUNT = 200;
const points = computed(() => {
  if (!compiled.value.ok) return [];
  const fn = compiled.value.fn;
  const [xMin, xMax] = props.widget.x;
  const pts: { x: number; y: number; valid: boolean }[] = [];
  
  const step = SAMPLE_COUNT > 1 ? (xMax - xMin) / (SAMPLE_COUNT - 1) : 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const x = xMin + i * step;
    let y = NaN;
    try {
      y = fn(x, paramValues.value);
    } catch {
      y = NaN;
    }
    const valid = Number.isFinite(y);
    pts.push({ x, y: valid ? y : 0, valid });
  }
  return pts;
});

// Y range is fixed for the widget: it covers the curve with every slider at min, middle and max (3^n combinations, at most 729).
// A moving slider then visibly moves the curve instead of rescaling the axis. The 0.5% tails
// are cut so a pole (for example 1/x) does not flatten everything else.
const yRange = computed<[number, number]>(() => {
  if (!compiled.value.ok) return [-1, 1];
  const fn = compiled.value.fn;
  const [xMin, xMax] = props.widget.x;
  const names = Object.keys(props.widget.params || {});
  const ys: number[] = [];
  const combos = 3 ** names.length;
  for (let k = 0; k < combos; k++) {
    const p: Record<string, number> = {};
    let rest = k;
    for (const n of names) {
      const d = props.widget.params[n];
      p[n] = [d.min, (d.min + d.max) / 2, d.max][rest % 3];
      rest = Math.floor(rest / 3);
    }
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      let y = NaN;
      try { y = fn(xMin + (i * (xMax - xMin)) / (SAMPLE_COUNT - 1), p); } catch { y = NaN; }
      if (Number.isFinite(y)) ys.push(y);
    }
  }
  if (!ys.length) return [-1, 1];
  ys.sort((a, b) => a - b);
  let lo = ys[Math.floor((ys.length - 1) * 0.005)];
  let hi = ys[Math.ceil((ys.length - 1) * 0.995)];
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
});

// Layout in viewBox units.
const svgWidth = 600;
const svgHeight = 260;
const margin = { top: 12, right: 16, bottom: 26, left: 48 };
const chartWidth = computed(() => svgWidth - margin.left - margin.right);
const chartHeight = computed(() => svgHeight - margin.top - margin.bottom);

function scaleX(x: number): number {
  const [xMin, xMax] = props.widget.x;
  return margin.left + ((x - xMin) / (xMax - xMin)) * chartWidth.value;
}
function scaleY(y: number): number {
  const [lo, hi] = yRange.value;
  return margin.top + chartHeight.value - ((y - lo) / (hi - lo)) * chartHeight.value;
}

// Tick values on a 1/2/5 step, about `count` of them.
function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
const xTicks = computed(() => niceTicks(props.widget.x[0], props.widget.x[1], 6).map(val => ({ val, x: scaleX(val) })));
const yTicks = computed(() => niceTicks(yRange.value[0], yRange.value[1], 5).map(val => ({ val, y: scaleY(val) })));

// One path per run of finite points, so gaps stay gaps. Values outside the range are clamped to the plot edge.
const pathSegments = computed(() => {
  const [lo, hi] = yRange.value;
  const segs: string[] = [];
  let cur = "";
  for (const p of points.value) {
    if (!p.valid) { if (cur) segs.push(cur); cur = ""; continue; }
    const y = Math.min(hi, Math.max(lo, p.y));
    cur += `${cur ? " L" : "M"} ${scaleX(p.x).toFixed(1)} ${scaleY(y).toFixed(1)}`;
  }
  if (cur) segs.push(cur);
  return segs;
});

// True when a slider position puts part of the curve outside the fixed axis range. The path is then cut at the edge.
const clipped = computed(() => {
  const [lo, hi] = yRange.value;
  return points.value.some(p => p.valid && (p.y < lo || p.y > hi));
});

const hoverX = ref<number | null>(null);
const hoverY = ref<number | null>(null);
const hoverValX = ref<number | null>(null);
const hoverValY = ref<number | null>(null);
const hoverValid = ref(false);
const uid = Math.random().toString(36).slice(2, 8);
const sliderId = (name: string) => `plot-${uid}-${name}`;

function handlePointerMove(e: PointerEvent) {
  const svgEl = e.currentTarget as SVGSVGElement;
  if (!svgEl) return;
  const rect = svgEl.getBoundingClientRect();
  const clientX = e.clientX - rect.left;
  // map clientX to svg viewBox coordinate
  const svgX = (clientX / rect.width) * svgWidth;
  const relX = svgX - margin.left;
  if (relX < 0 || relX > chartWidth.value) {
    hoverX.value = null;
    hoverY.value = null;
    return;
  }
  const [xMin, xMax] = props.widget.x;
  const valX = xMin + (relX / chartWidth.value) * (xMax - xMin);
  hoverValX.value = valX;

  // find closest point
  const pts = points.value;
  if (pts.length === 0) return;
  let closest = pts[0];
  let minDist = Math.abs(pts[0].x - valX);
  for (const p of pts) {
    const dist = Math.abs(p.x - valX);
    if (dist < minDist) {
      minDist = dist;
      closest = p;
    }
  }

  hoverValX.value = closest.x;
  hoverX.value = scaleX(closest.x);
  hoverY.value = scaleY(closest.y);
  hoverValY.value = closest.y;
  hoverValid.value = closest.valid;
}

function handlePointerLeave() {
  hoverX.value = null;
  hoverY.value = null;
  hoverValX.value = null;
  hoverValY.value = null;
}
</script>

<template>
  <div class="plot-widget">
    <div v-if="widget.title" class="plot-title">{{ widget.title }}</div>
    <div v-if="!compiled.ok" class="widget-error">
      expr error: {{ compiled.error }}
    </div>
    <template v-else>
      <p v-if="pathSegments.length === 0" class="plot-empty" role="status">No finite values in this domain.</p>
      <div v-else class="chart-container">
        <svg
          viewBox="0 0 600 260"
          class="plot-svg"
          role="img"
          :aria-label="widget.title ? widget.title + ' plot' : 'Function plot'"
          @pointermove="handlePointerMove"
          @pointerleave="handlePointerLeave"
        >
          <!-- Grid lines -->
          <g class="grid-lines">
            <line
              v-for="t in yTicks"
              :key="'y-' + t.val"
              :x1="margin.left"
              :y1="t.y"
              :x2="svgWidth - margin.right"
              :y2="t.y"
              stroke="var(--border)"
              stroke-dasharray="3 3"
              stroke-width="1"
            />
            <line
              v-for="t in xTicks"
              :key="'x-' + t.val"
              :x1="t.x"
              :y1="margin.top"
              :x2="t.x"
              :y2="svgHeight - margin.bottom"
              stroke="var(--border)"
              stroke-dasharray="3 3"
              stroke-width="1"
            />
          </g>

          <!-- Axes -->
          <g class="axes">
            <line
              :x1="margin.left"
              :y1="svgHeight - margin.bottom"
              :x2="svgWidth - margin.right"
              :y2="svgHeight - margin.bottom"
              stroke="var(--muted-foreground)"
              stroke-width="1.5"
            />
            <line
              :x1="margin.left"
              :y1="margin.top"
              :x2="margin.left"
              :y2="svgHeight - margin.bottom"
              stroke="var(--muted-foreground)"
              stroke-width="1.5"
            />
          </g>

          <!-- Ticks & Labels -->
          <g class="ticks" font-size="10" fill="var(--muted-foreground)" text-anchor="middle">
            <g v-for="t in xTicks" :key="'xt-' + t.val">
              <line :x1="t.x" :y1="svgHeight - margin.bottom" :x2="t.x" :y2="svgHeight - margin.bottom + 4" stroke="var(--muted-foreground)" />
              <text :x="t.x" :y="svgHeight - margin.bottom + 14">{{ t.val.toFixed(1) }}</text>
            </g>
            <g v-for="t in yTicks" :key="'yt-' + t.val" text-anchor="end">
              <line :x1="margin.left - 4" :y1="t.y" :x2="margin.left" :y2="t.y" stroke="var(--muted-foreground)" />
              <text :x="margin.left - 8" :y="t.y + 3">{{ t.val.toFixed(1) }}</text>
            </g>
          </g>

          <!-- Plot Curve Segments -->
          <g class="curve">
            <path
              v-for="(d, idx) in pathSegments"
              :key="idx"
              :d="d"
              fill="none"
              stroke="var(--chart-1)"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </g>

          <!-- Hover Crosshair & Readout -->
          <g v-if="hoverX !== null && hoverY !== null" class="hover-overlay">
            <line
              :x1="hoverX"
              :y1="margin.top"
              :x2="hoverX"
              :y2="svgHeight - margin.bottom"
              stroke="var(--muted-foreground)"
              stroke-dasharray="2 2"
              stroke-width="1"
            />
            <circle
              v-if="hoverValid"
              :cx="hoverX"
              :cy="hoverY"
              r="4"
              fill="var(--chart-1)"
              stroke="var(--background)"
              stroke-width="1.5"
            />
          </g>
        </svg>

        <!-- Hover Readout Box -->
        <div v-if="hoverValX !== null" class="hover-readout">
          x: {{ hoverValX.toFixed(3) }} | y: {{ hoverValid && hoverValY !== null ? hoverValY.toFixed(3) : 'gap' }}
        </div>
      </div>

      <div v-if="clipped" class="plot-clipped" role="status">Part of the curve is outside the axis range.</div>

      <!-- Param Sliders -->
      <div v-if="widget.params && Object.keys(widget.params).length > 0" class="params-grid">
        <div v-for="(p, name) in widget.params" :key="name" class="param-row">
          <label class="param-label" :for="sliderId(String(name))">
            <span class="param-name">{{ name }}</span>
            <span class="param-val">{{ paramValues[name] ?? p.value }}</span>
          </label>
          <input
            :id="sliderId(String(name))"
            type="range"
            class="param-slider"
            :min="p.min"
            :max="p.max"
            :step="p.step ?? 'any'"
            v-model.number="paramValues[name]"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plot-widget {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--card-foreground);
}
.plot-title { font-weight: 600; font-size: 14px; padding-right: 72px; }
.widget-error { font-size: 13px; color: var(--destructive); }
.chart-container {
  position: relative;
  width: 100%;
  overflow: hidden;
}
.plot-svg {
  width: 100%;
  height: auto;
  display: block;
  shape-rendering: geometricPrecision;
}
.plot-empty {
  margin: 0;
  padding: 24px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--muted-foreground);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
.plot-clipped {
  font-size: 12px;
  color: var(--warn);
}
.hover-readout {
  position: absolute;
  top: 8px;
  left: 8px;
  background: var(--popover);
  border: 1px solid var(--border);
  padding: 4px 8px;
  border-radius: var(--radius);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--foreground);
  pointer-events: none;
  box-shadow: var(--shadow);
}
.params-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  background: var(--secondary);
  padding: 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.param-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.param-label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  font-family: var(--mono);
}
.param-name {
  color: var(--muted-foreground);
  font-weight: 500;
}
.param-val {
  color: var(--foreground);
}
.param-slider {
  width: 100%;
  min-height: 32px;
  accent-color: var(--primary);
  cursor: pointer;
}
.param-slider:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
@media (max-width: 760px), (pointer: coarse) {
  .plot-title { padding-right: 108px; }
  .param-slider { min-height: 44px; }
}
</style>
