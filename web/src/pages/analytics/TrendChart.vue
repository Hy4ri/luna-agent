<script setup lang="ts">
import { computed, ref } from "vue"
import { compact, durationFormat, usd } from "./formatters"

export interface TrendPoint {
  x: string
  y: number
}

const props = withDefaults(
  defineProps<{
    name: string
    points: TrendPoint[]
    unit: "usd" | "count" | "tokens" | "ms"
    aggregate?: "sum" | "mean"
    from?: number
    to?: number
  }>(),
  {
    aggregate: "sum",
  },
)

const emit = defineEmits<{
  (e: "zoom", range: { from: number; to: number }): void
}>()

type BucketUnit = "hour" | "day" | "week"

interface Bucket {
  start: number
  end: number
  value: number | null
  label: string
  shortLabel: string
}

function parseUtcHour(x: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(x.trim())
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
}

function localDayStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function localWeekStart(ts: number): number {
  const d = new Date(ts)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day // Monday start
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff).getTime()
}

function nextBucketStart(start: number, unit: BucketUnit): number {
  const d = new Date(start)
  if (unit === "hour") return start + 3_600_000
  if (unit === "day") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime()
}

function formatShort(ts: number, unit: BucketUnit): string {
  const d = new Date(ts)
  if (unit === "hour") {
    return `${String(d.getHours()).padStart(2, "0")}:00`
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function formatFull(ts: number, unit: BucketUnit): string {
  const d = new Date(ts)
  if (unit === "hour") {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${String(d.getHours()).padStart(2, "0")}:00`
  }
  if (unit === "week") {
    return `Week of ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

function formatValue(v: number | null): string {
  if (v == null) return "No data"
  if (props.unit === "usd") return usd(v)
  if (props.unit === "ms") return durationFormat(v)
  return compact(v)
}

function niceMax(raw: number): number {
  if (raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const frac = raw / base
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return nice * base
}

const parsedPoints = computed(() => {
  const out: { ts: number; y: number }[] = []
  for (const p of props.points) {
    const ts = parseUtcHour(p.x)
    if (ts != null && Number.isFinite(p.y)) out.push({ ts, y: p.y })
  }
  return out
})

const bucketed = computed<{ unit: BucketUnit; buckets: Bucket[] }>(() => {
  const pts = parsedPoints.value
  if (pts.length === 0) return { unit: "day", buckets: [] }

  let minTs = Infinity
  let maxTs = -Infinity
  for (const p of pts) {
    if (p.ts < minTs) minTs = p.ts
    if (p.ts > maxTs) maxTs = p.ts
  }

  const winStart = props.from != null && props.to != null && props.to > props.from ? props.from : minTs
  const winEnd = props.from != null && props.to != null && props.to > props.from ? props.to : maxTs + 3_600_000
  const span = winEnd - winStart

  let unit: BucketUnit = span <= 72 * 3_600_000 ? "hour" : "day"
  if (unit === "day" && span / 86_400_000 > 120) {
    unit = "week"
  }

  const align = (ts: number) => {
    if (unit === "hour") return Math.floor(ts / 3_600_000) * 3_600_000
    if (unit === "day") return localDayStart(ts)
    return localWeekStart(ts)
  }

  const grouped = new Map<number, { sum: number; count: number }>()
  for (const p of pts) {
    const key = align(p.ts)
    const cur = grouped.get(key)
    if (cur) {
      cur.sum += p.y
      cur.count += 1
    } else {
      grouped.set(key, { sum: p.y, count: 1 })
    }
  }

  const buckets: Bucket[] = []
  let cur = align(winStart)
  const endBound = align(winEnd - 1)
  let guard = 0
  while (cur <= endBound && guard < 200) {
    const next = nextBucketStart(cur, unit)
    const entry = grouped.get(cur)
    let value: number | null
    if (props.aggregate === "mean") {
      value = entry && entry.count > 0 ? entry.sum / entry.count : null
    } else {
      value = entry ? entry.sum : 0
    }
    buckets.push({
      start: cur,
      end: next,
      value,
      label: formatFull(cur, unit),
      shortLabel: formatShort(cur, unit),
    })
    cur = next
    guard++
  }

  return { unit, buckets }
})

const yMax = computed(() => {
  let max = 0
  for (const b of bucketed.value.buckets) {
    if (b.value != null && b.value > max) max = b.value
  }
  return niceMax(max)
})

const summary = computed(() => {
  const { buckets } = bucketed.value
  let total = 0
  let count = 0
  let peak: Bucket | null = null
  for (const b of buckets) {
    if (b.value != null) {
      total += b.value
      count += 1
      if (!peak || b.value > (peak.value ?? -Infinity)) peak = b
    }
  }
  const headline = props.aggregate === "mean" ? (count > 0 ? total / count : 0) : total
  return {
    headlineText: formatValue(headline),
    peakText: peak ? `${formatValue(peak.value)} on ${peak.shortLabel}` : "—",
  }
})

const xTicks = computed(() => {
  const buckets = bucketed.value.buckets
  const n = buckets.length
  if (n === 0) return []
  if (n <= 5) return buckets.map((b, i) => ({ index: i, label: b.shortLabel }))
  const count = 4
  const ticks: { index: number; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (n - 1)) / (count - 1))
    ticks.push({ index: idx, label: buckets[idx].shortLabel })
  }
  return ticks
})

const activeIndex = ref<number | null>(null)
// Roving tab stop: the chart is one Tab stop; arrow keys move between bars.
const rovingIndex = ref(-1)
const tabStop = computed(() => {
  const n = bucketed.value.buckets.length
  if (n === 0) return -1
  return rovingIndex.value >= 0 && rovingIndex.value < n ? rovingIndex.value : n - 1
})
const buttonRefs = ref<(HTMLButtonElement | null)[]>([])

const activeBucket = computed(() =>
  activeIndex.value != null ? bucketed.value.buckets[activeIndex.value] ?? null : null,
)

function onBarClick(b: Bucket) {
  if (bucketed.value.buckets.length <= 1) return
  emit("zoom", { from: b.start, to: b.end })
}

function onBarKeydown(e: KeyboardEvent, idx: number) {
  const len = bucketed.value.buckets.length
  const target = e.key === "ArrowRight" ? Math.min(len - 1, idx + 1)
    : e.key === "ArrowLeft" ? Math.max(0, idx - 1)
    : e.key === "Home" ? 0
    : e.key === "End" ? len - 1
    : null
  if (target == null) return
  e.preventDefault()
  rovingIndex.value = target
  buttonRefs.value[target]?.focus()
}

const unitCaption = computed(() => {
  const u = bucketed.value.unit
  const per = u === "hour" ? "Per hour" : u === "week" ? "Per week" : "Per day"
  return `${per} · local time · click a bar to zoom in`
})
</script>

<template>
  <section
    class="border border-border rounded-[var(--radius)] bg-card p-4"
    role="figure"
    :aria-label="`${name} trend chart: ${summary.headlineText}, peak ${summary.peakText}`"
  >
    <p class="sr-only">
      {{ name }}: {{ aggregate === "mean" ? "average" : "total" }} {{ summary.headlineText }}, peak
      {{ summary.peakText }}.
    </p>

    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="text-sm font-medium text-foreground">{{ name }}</h3>
      <div class="text-xs text-muted-foreground tabular-nums">
        <span class="mr-1">{{ aggregate === "mean" ? "avg" : "sum" }}</span>
        <span class="font-medium text-foreground">{{ summary.headlineText }}</span>
        <span class="mx-1.5">·</span>
        <span>peak {{ summary.peakText }}</span>
      </div>
    </div>
    <p class="mt-0.5 text-[11px] text-muted-foreground">{{ unitCaption }}</p>

    <div
      v-if="bucketed.buckets.length === 0"
      class="mt-3 flex h-[160px] items-center justify-center text-xs text-muted-foreground"
    >
      No activity in this range.
    </div>

    <div v-else class="mt-3 flex gap-2">
      <!-- Y-axis labels -->
      <div
        class="flex h-[160px] w-12 shrink-0 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums select-none"
      >
        <span>{{ formatValue(yMax) }}</span>
        <span>{{ formatValue(yMax / 2) }}</span>
        <span>{{ formatValue(0) }}</span>
      </div>

      <!-- Plot area -->
      <div class="relative flex-1 min-w-0">
        <div class="relative h-[160px] w-full">
          <svg
            class="h-full w-full block"
            viewBox="0 0 1000 160"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <!-- Gridlines -->
            <line x1="0" y1="1" x2="1000" y2="1" stroke="var(--border)" stroke-width="1" />
            <line x1="0" y1="80" x2="1000" y2="80" stroke="var(--border)" stroke-width="1" />
            <line x1="0" y1="159" x2="1000" y2="159" stroke="var(--border)" stroke-width="1" />

            <!-- Bars -->
            <template v-for="(b, idx) in bucketed.buckets" :key="b.start">
              <rect
                v-if="b.value != null && b.value > 0"
                :x="(idx / bucketed.buckets.length) * 1000 + (1000 / bucketed.buckets.length) * 0.12"
                :y="160 - Math.max(2, (b.value / yMax) * 158)"
                :width="Math.max(1, (1000 / bucketed.buckets.length) * 0.76)"
                :height="Math.max(2, (b.value / yMax) * 158)"
                fill="var(--primary-text)"
                :fill-opacity="activeIndex === idx ? 1 : 0.75"
              />
            </template>
          </svg>

          <!-- Interactive overlay for hover & keyboard navigation -->
          <div class="absolute inset-0 flex">
            <button
              v-for="(b, idx) in bucketed.buckets"
              :key="b.start"
              :ref="(el) => { buttonRefs[idx] = el as HTMLButtonElement | null }"
              type="button"
              :tabindex="idx === tabStop ? 0 : -1"
              class="h-full flex-1 bg-transparent cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-[-2px]"
              :aria-label="`${b.label}: ${formatValue(b.value)}`"
              @mouseenter="activeIndex = idx"
              @mouseleave="activeIndex = null"
              @focus="activeIndex = idx; rovingIndex = idx"
              @blur="activeIndex = null"
              @click="onBarClick(b)"
              @keydown="onBarKeydown($event, idx)"
            />
          </div>

          <!-- Tooltip -->
          <div
            v-if="activeBucket && activeIndex != null"
            class="pointer-events-none absolute top-1 z-10 rounded-[var(--radius)] border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm tabular-nums whitespace-nowrap"
            :style="{
              left: `${((activeIndex + 0.5) / bucketed.buckets.length) * 100}%`,
              transform:
                activeIndex > bucketed.buckets.length * 0.7
                  ? 'translateX(-100%)'
                  : activeIndex < bucketed.buckets.length * 0.3
                    ? 'translateX(0%)'
                    : 'translateX(-50%)',
            }"
          >
            <div class="font-medium">{{ activeBucket.label }}</div>
            <div class="text-muted-foreground">{{ formatValue(activeBucket.value) }}</div>
          </div>
        </div>

        <!-- X-axis labels -->
        <div class="mt-1.5 flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span v-for="t in xTicks" :key="t.index">{{ t.label }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
