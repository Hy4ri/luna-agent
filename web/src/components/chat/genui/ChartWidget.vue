<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChartWidget } from "@/lib/widgets/schema";

const props = defineProps<{ widget: ChartWidget }>();
type Series = ChartWidget["series"][number];

const W = 600;
const H = 300;
const pad = { top: 20, right: 20, bottom: 40, left: 56 };
const plotW = W - pad.left - pad.right;
const plotH = H - pad.top - pad.bottom;

const isPie = computed(() => props.widget.kind === "pie" || props.widget.kind === "donut");
const hidden = ref(new Set<number>());
const hovered = ref<number | null>(null);

function toggle(i: number) {
  const next = new Set(hidden.value);
  if (!next.delete(i)) next.add(i);
  hidden.value = next;
}

// Colors follow the original position, so hiding an entry never recolors the others.
const color = (i: number) => `var(--chart-${(i % 6) + 1})`;
const unit = computed(() => (props.widget.yUnit ? ` ${props.widget.yUnit}` : ""));
const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(v.toFixed(Math.abs(v) >= 100 ? 0 : 2)).toString());

// ---- cartesian ----
const visible = computed(() => props.widget.series.map((s, i) => ({ s, i })).filter(e => !hidden.value.has(e.i)));
const stacked = computed(() => props.widget.stacked === true);
const isBar = computed(() => props.widget.kind === "bar");
const n = computed(() => props.widget.x.length);

/** Bottom and top of each visible series at each x; for unstacked charts the bottom is zero. */
const layers = computed(() => {
  const base = new Array<number>(n.value).fill(0);
  return visible.value.map(({ s, i }) => {
    const lo = stacked.value ? [...base] : new Array<number>(n.value).fill(0);
    const hi = s.data.map((v, k) => (stacked.value ? (base[k] += v) : v));
    return { s, i, lo, hi };
  });
});

const yRange = computed(() => {
  const vals = layers.value.flatMap(l => [...l.hi, ...l.lo]);
  if (!vals.length) return { min: 0, max: 1 };
  let min = Math.min(...vals), max = Math.max(...vals);
  if (isBar.value || props.widget.kind === "area") { min = Math.min(min, 0); max = Math.max(max, 0); }
  else if (min >= 0) min = 0;
  if (min === max) max = min + 1;
  const p = (max - min) * 0.08;
  return { min: min < 0 ? min - p : min, max: max > 0 ? max + p : max };
});

function niceTicks(min: number, max: number, count = 5) {
  const raw = (max - min) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const y = (v: number) => pad.top + plotH - ((v - yRange.value.min) / (yRange.value.max - yRange.value.min)) * plotH;
const slot = computed(() => plotW / Math.max(1, n.value));
const x = (k: number) => (isBar.value ? pad.left + slot.value * (k + 0.5) : n.value <= 1 ? pad.left + plotW / 2 : pad.left + (k / (n.value - 1)) * plotW);
const yTicks = computed(() => niceTicks(yRange.value.min, yRange.value.max));
const labelEvery = computed(() => Math.max(1, Math.ceil(n.value / 8)));

const barW = computed(() => {
  const group = slot.value * 0.72;
  return stacked.value ? group : group / Math.max(1, visible.value.length);
});
function barX(k: number, j: number) {
  return stacked.value ? x(k) - barW.value / 2 : x(k) - (barW.value * visible.value.length) / 2 + j * barW.value;
}

const linePath = (pts: number[]) => pts.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
function areaPath(lo: number[], hi: number[]) {
  const top = hi.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const bottom = lo.map((v, k) => `L${x(k).toFixed(1)} ${y(v).toFixed(1)}`).reverse().join(" ");
  return `${top} ${bottom} Z`;
}

function onMove(e: PointerEvent) {
  const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
  const sx = ((e.clientX - rect.left) / rect.width) * W - pad.left;
  if (sx < 0 || sx > plotW) { hovered.value = null; return; }
  const k = isBar.value ? Math.floor(sx / slot.value) : Math.round((sx / plotW) * (n.value - 1));
  hovered.value = Math.max(0, Math.min(n.value - 1, k));
}

// ---- pie / donut ----
const pieData = computed(() => props.widget.series[0]?.data ?? []);
const pieTotal = computed(() => pieData.value.reduce((a, v, i) => (hidden.value.has(i) ? a : a + v), 0));
const slices = computed(() => {
  const cx = 150, cy = 150, r = 120, inner = props.widget.kind === "donut" ? 72 : 0;
  let angle = -Math.PI / 2;
  return pieData.value.map((v, i) => {
    if (hidden.value.has(i) || v <= 0 || pieTotal.value <= 0) return null;
    const sweep = (v / pieTotal.value) * Math.PI * 2;
    const a0 = angle, a1 = angle + Math.min(sweep, Math.PI * 2 - 1e-6);
    angle += sweep;
    const pt = (rad: number, a: number) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = inner
      ? `M${pt(r, a0)} A${r} ${r} 0 ${large} 1 ${pt(r, a1)} L${pt(inner, a1)} A${inner} ${inner} 0 ${large} 0 ${pt(inner, a0)} Z`
      : `M${cx} ${cy} L${pt(r, a0)} A${r} ${r} 0 ${large} 1 ${pt(r, a1)} Z`;
    return { i, d, v, pct: (v / pieTotal.value) * 100 };
  }).filter(s => s !== null);
});
const focusSlice = computed(() => (hovered.value === null ? null : slices.value.find(s => s.i === hovered.value) ?? null));
const cartesianEmpty = computed(() => n.value === 0 || props.widget.series.length === 0);
const cartesianHidden = computed(() => !cartesianEmpty.value && visible.value.length === 0);
const pieEmpty = computed(() => pieData.value.length === 0 || (hidden.value.size < pieData.value.length && pieTotal.value <= 0));
const pieHidden = computed(() => pieData.value.length > 0 && hidden.value.size >= pieData.value.length);

function onSvgKeydown(e: KeyboardEvent) {
  if (n.value <= 0) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    hovered.value = hovered.value === null ? 0 : Math.min(n.value - 1, hovered.value + 1);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    hovered.value = hovered.value === null ? n.value - 1 : Math.max(0, hovered.value - 1);
  } else if (e.key === "Escape") {
    hovered.value = null;
  }
}

const legend = computed(() => (isPie.value ? props.widget.x.map((name, i) => ({ name, i })) : props.widget.series.map((s: Series, i) => ({ name: s.name, i }))));
</script>

<template>
  <div class="chart">
    <div v-if="widget.title" class="chart-title">{{ widget.title }}</div>

    <div v-if="isPie" class="pie-wrap">
      <p v-if="pieEmpty" class="chart-empty" role="status">No positive values to display.</p>
      <p v-else-if="pieHidden" class="chart-empty" role="status">All slices hidden — select a legend item to show.</p>
      <svg v-else viewBox="0 0 300 300" class="pie-svg" role="img" :aria-label="widget.title || 'Pie chart'" @pointerleave="hovered = null">
        <path
          v-for="s in slices" :key="s.i" :d="s.d" :fill="color(s.i)" stroke="var(--card)" stroke-width="2"
          class="slice" :class="{ dim: hovered !== null && hovered !== s.i }"
          @pointerenter="hovered = s.i"
        />
        <text v-if="widget.kind === 'donut'" x="150" y="146" text-anchor="middle" class="pie-center">{{ fmt(focusSlice ? focusSlice.v : pieTotal) }}{{ unit }}</text>
        <text v-if="widget.kind === 'donut'" x="150" y="168" text-anchor="middle" class="pie-sub">{{ focusSlice ? widget.x[focusSlice.i] : 'total' }}</text>
      </svg>
      <ul class="pie-legend">
        <li v-for="item in legend" :key="item.i">
          <button type="button" :aria-pressed="!hidden.has(item.i)" @click="toggle(item.i)" @pointerenter="hovered = item.i" @pointerleave="hovered = null">
            <span class="dot" :style="{ background: hidden.has(item.i) ? 'var(--muted-foreground)' : color(item.i) }" />
            <span class="name">{{ item.name }}</span>
            <span class="val">{{ fmt(pieData[item.i] ?? 0) }}{{ unit }}<template v-if="!hidden.has(item.i) && pieTotal > 0"> · {{ (((pieData[item.i] ?? 0) / pieTotal) * 100).toFixed(1) }}%</template></span>
          </button>
        </li>
      </ul>
    </div>

    <template v-else>
      <p v-if="cartesianEmpty" class="chart-empty" role="status">No data to display.</p>
      <p v-else-if="cartesianHidden" class="chart-empty" role="status">All series hidden — select a legend item to show.</p>
      <svg v-else :viewBox="`0 0 ${W} ${H}`" class="chart-svg" role="img" tabindex="0" :aria-label="widget.title ? widget.title + ' (use arrow keys to inspect points)' : 'Chart (use arrow keys to inspect points)'" @pointermove="onMove" @pointerleave="hovered = null" @keydown="onSvgKeydown" @blur="hovered = null">
        <g>
          <template v-for="t in yTicks" :key="t">
            <line :x1="pad.left" :x2="W - pad.right" :y1="y(t)" :y2="y(t)" :stroke="t === 0 ? 'var(--muted-foreground)' : 'var(--border)'" :stroke-opacity="t === 0 ? 0.5 : 1" stroke-dasharray="3 3" />
            <text :x="pad.left - 8" :y="y(t) + 4" text-anchor="end" class="axis">{{ fmt(t) }}{{ unit }}</text>
          </template>
          <template v-for="(label, k) in widget.x" :key="k">
            <text v-if="k % labelEvery === 0 || k === n - 1" :x="x(k)" :y="H - pad.bottom + 20" text-anchor="middle" class="axis">{{ label }}</text>
          </template>
        </g>

        <rect v-if="hovered !== null && isBar" :x="pad.left + slot * hovered" :y="pad.top" :width="slot" :height="plotH" fill="var(--foreground)" opacity="0.05" />

        <g v-if="isBar">
          <template v-for="(l, j) in layers" :key="l.i">
            <rect
              v-for="(_, k) in l.hi" :key="k"
              :x="barX(k, j) + 0.5" :width="Math.max(1, barW - 1)"
              :y="Math.min(y(l.hi[k]!), y(l.lo[k]!))" :height="Math.max(1, Math.abs(y(l.hi[k]!) - y(l.lo[k]!)))"
              :fill="color(l.i)" rx="1"
            />
          </template>
        </g>
        <g v-else>
          <template v-for="l in layers" :key="l.i">
            <path v-if="widget.kind === 'area'" :d="areaPath(l.lo, l.hi)" :fill="color(l.i)" :fill-opacity="stacked ? 0.55 : 0.18" />
            <path :d="linePath(l.hi)" fill="none" :stroke="color(l.i)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
            <template v-if="n <= 40">
              <circle v-for="(v, k) in l.hi" :key="k" :cx="x(k)" :cy="y(v)" r="2.6" :fill="color(l.i)" />
            </template>
          </template>
          <g v-if="hovered !== null">
            <line :x1="x(hovered)" :x2="x(hovered)" :y1="pad.top" :y2="pad.top + plotH" stroke="var(--muted-foreground)" stroke-dasharray="2 2" />
            <circle v-for="l in layers" :key="l.i" :cx="x(hovered)" :cy="y(l.hi[hovered]!)" r="4.5" fill="var(--card)" :stroke="color(l.i)" stroke-width="2.2" />
          </g>
        </g>
      </svg>

      <div class="readout" :class="{ on: hovered !== null }" aria-live="polite">
        <template v-if="hovered !== null">
          <strong>{{ widget.x[hovered] }}</strong>
          <span v-for="l in layers" :key="l.i" class="item"><span class="dot" :style="{ background: color(l.i) }" />{{ l.s.name }} {{ fmt(l.s.data[hovered]!) }}{{ unit }}</span>
          <span v-if="stacked && layers.length > 1" class="item total">total {{ fmt(layers[layers.length - 1]!.hi[hovered]!) }}{{ unit }}</span>
        </template>
      </div>

      <div class="legend">
        <button v-for="item in legend" :key="item.i" type="button" :aria-pressed="!hidden.has(item.i)" @click="toggle(item.i)">
          <span class="dot" :style="{ background: hidden.has(item.i) ? 'var(--muted-foreground)' : color(item.i) }" />{{ item.name }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chart { display: flex; flex-direction: column; gap: 8px; padding: 14px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); color: var(--card-foreground); min-width: 0; }
.chart-title { font-weight: 600; font-size: 14px; padding-right: 72px; }
.chart-svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
.axis { font-size: 10.5px; fill: var(--muted-foreground); }
.readout { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; min-height: 22px; font-size: 12.5px; color: var(--muted-foreground); opacity: 0; transition: opacity .12s; }
.readout.on { opacity: 1; }
.readout strong { color: var(--foreground); font-weight: 600; }
.item { display: inline-flex; align-items: center; gap: 6px; }
.total { color: var(--foreground); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.legend { display: flex; flex-wrap: wrap; gap: 6px; }
.legend button, .pie-legend button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 10px; font-size: 12px;
  color: var(--card-foreground); background: var(--secondary); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer;
}
.legend button:hover, .pie-legend button:hover { border-color: var(--ring); }
.legend button:focus-visible, .pie-legend button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.chart-empty { margin: 8px 0; padding: 24px 12px; text-align: center; font-size: 13px; color: var(--muted-foreground); border: 1px dashed var(--border); border-radius: var(--radius); }
.chart-svg:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius); }
button[aria-pressed="false"] { color: var(--muted-foreground); text-decoration: line-through; }
@media (max-width: 760px), (pointer: coarse) {
  .chart-title { padding-right: 108px; }
  .legend button, .pie-legend button { min-height: 44px; padding: 8px 12px; }
}
.pie-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.pie-svg { width: min(260px, 100%); height: auto; flex: none; }
.slice { transition: opacity .15s; cursor: pointer; }
.slice.dim { opacity: .35; }
.pie-center { font-size: 26px; font-weight: 650; fill: var(--foreground); }
.pie-sub { font-size: 12px; fill: var(--muted-foreground); }
.pie-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; flex: 1 1 180px; min-width: 0; }
.pie-legend button { width: 100%; justify-content: flex-start; }
.pie-legend .name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pie-legend .val { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
</style>
