<template>
  <div class="relative border border-border rounded-[var(--radius)] bg-card overflow-hidden" :aria-busy="loading ? 'true' : 'false'">
    <div v-if="rows.length === 0 && !loading" class="px-6 py-10 text-center text-sm text-muted-foreground">
      <p class="m-0 text-foreground">Nothing matches.</p>
      <p class="m-0 mt-1 text-xs">{{ emptyHint }}</p>
    </div>
    <div v-else-if="rows.length === 0 && loading" class="p-3 space-y-2" role="status" aria-label="Loading rows">
      <div v-for="i in 5" :key="i" class="h-7 bg-secondary/60 animate-pulse rounded-[var(--radius)]" />
    </div>

    <template v-else>
      <!-- Desktop table -->
      <div class="hidden min-[761px]:block overflow-x-auto transition-opacity" :class="{ 'opacity-60': loading }">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="border-b border-border bg-secondary/40 text-left text-muted-foreground">
              <th
                v-for="(col, i) in visibleColumns"
                :key="col.key"
                scope="col"
                class="p-0 font-medium whitespace-nowrap select-none"
                :class="[{ 'text-right': isNumeric(col) }, i === 0 ? 'sticky left-0 z-[1] bg-[var(--card)]' : '']"
                :aria-sort="sortable ? ariaSort(col.key) : undefined"
              >
                <button
                  v-if="sortable"
                  type="button"
                  class="w-full inline-flex items-center gap-1 px-3 py-2.5 hover:text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]"
                  :class="[isNumeric(col) ? 'justify-end' : '', sortKey === col.key ? 'text-foreground' : '']"
                  :title="headerTitle(col)"
                  @click="$emit('sort', nextSort(col.key))"
                >
                  <span :class="{ 'underline decoration-dotted decoration-muted-foreground/60 underline-offset-4': !!METRIC_HELP[col.key] }">{{ columnLabel(col) }}</span>
                  <ArrowUp v-if="sortKey === col.key && sortDir === 'asc'" :size="12" aria-hidden="true" />
                  <ArrowDown v-else-if="sortKey === col.key && sortDir === 'desc'" :size="12" aria-hidden="true" />
                  <ArrowUpDown v-else :size="12" class="opacity-40" aria-hidden="true" />
                </button>
                <span
                  v-else
                  class="block px-3 py-2.5"
                  :title="METRIC_HELP[col.key]"
                  :class="{ 'underline decoration-dotted decoration-muted-foreground/60 underline-offset-4': !!METRIC_HELP[col.key] }"
                >{{ columnLabel(col) }}</span>
              </th>
              <th v-if="anySelectable" scope="col" class="w-8"><span class="sr-only">Open details</span></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/60">
            <tr
              v-for="(row, idx) in rows"
              :key="rowKey(row, idx)"
              :tabindex="isSelectable(row) ? 0 : undefined"
              :aria-label="isSelectable(row) ? `Open details for ${rowName(row)}` : undefined"
              class="group transition-colors"
              :class="isSelectable(row) ? 'hover:bg-accent cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]' : ''"
              @click="isSelectable(row) && $emit('select', row)"
              @keydown.enter.prevent="isSelectable(row) && $emit('select', row)"
              @keydown.space.prevent="isSelectable(row) && $emit('select', row)"
            >
              <td
                v-for="(col, cIdx) in visibleColumns"
                :key="col.key"
                class="px-3 py-2 align-middle"
                :class="[
                  isNumeric(col) ? 'text-right tabular-nums whitespace-nowrap' : '',
                  cIdx === 0 ? 'font-medium text-foreground sticky left-0 z-[1] bg-[var(--card)] group-hover:bg-accent' : 'text-muted-foreground',
                ]"
                :title="cellTitle(row[col.key], col)"
              >
                <span
                  class="inline-flex items-center gap-2 max-w-full"
                  :class="isNumeric(col) ? '' : 'min-w-0'"
                >
                  <span :class="isNumeric(col) || isDate(col) ? 'whitespace-nowrap' : 'block truncate ' + textWidth(col)">{{ cell(row[col.key], col, row) }}</span>
                  <span
                    v-if="cIdx === 0 && row.deletedAt != null"
                    class="shrink-0 border border-destructive/50 text-destructive px-1.5 py-px text-[10px] font-normal"
                  >Deleted</span>
                </span>
              </td>
              <td v-if="anySelectable" class="pr-2 text-muted-foreground">
                <ChevronRight v-if="isSelectable(row)" :size="14" class="opacity-40 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Mobile cards -->
      <ul class="block min-[761px]:hidden divide-y divide-border/60 m-0 p-0 list-none" :class="{ 'opacity-60': loading }">
        <li
          v-for="(row, idx) in rows"
          :key="rowKey(row, idx)"
          :tabindex="isSelectable(row) ? 0 : undefined"
          :aria-label="isSelectable(row) ? `Open details for ${rowName(row)}` : undefined"
          class="p-3 text-xs"
          :class="isSelectable(row) ? 'active:bg-accent cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]' : ''"
          @click="isSelectable(row) && $emit('select', row)"
          @keydown.enter.prevent="isSelectable(row) && $emit('select', row)"
        >
          <div class="flex items-center gap-2 min-h-6">
            <span class="flex-1 min-w-0 truncate text-sm font-medium text-foreground">{{ cell(row[visibleColumns[0]?.key ?? ''], visibleColumns[0]) }}</span>
            <span v-if="row.deletedAt != null" class="shrink-0 border border-destructive/50 text-destructive px-1.5 py-px text-[10px]">Deleted</span>
            <ChevronRight v-if="isSelectable(row)" :size="16" class="shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>
          <dl class="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 m-0">
            <div v-for="col in visibleColumns.slice(1)" :key="col.key" class="min-w-0">
              <dt class="text-[11px] text-muted-foreground">{{ columnLabel(col) }}</dt>
              <dd class="m-0 truncate text-foreground tabular-nums" :title="cellTitle(row[col.key], col)">{{ cell(row[col.key], col, row) }}</dd>
            </div>
          </dl>
        </li>
      </ul>

      <!-- Pagination -->
      <div
        v-if="paginated"
        class="flex items-center justify-between gap-3 flex-wrap px-3 py-2 border-t border-border/60 bg-secondary/20 text-xs text-muted-foreground"
      >
        <span class="tabular-nums">
          {{ total === 0 ? "0 rows" : `${(page * limit + 1).toLocaleString()}–${Math.min((page + 1) * limit, total).toLocaleString()} of ${total.toLocaleString()}` }}
        </span>
        <div class="flex items-center gap-2">
          <label class="inline-flex items-center gap-1.5">
            <span>Rows</span>
            <select
              :value="limit"
              class="h-8 max-[760px]:min-h-11 px-1.5 bg-background border border-border rounded-[var(--radius)] text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              aria-label="Rows per page"
              @change="$emit('limit', Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="n in [20, 50, 100]" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
          <span class="tabular-nums px-1">Page {{ page + 1 }} of {{ pageCount }}</span>
          <button
            type="button"
            class="h-8 w-8 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center border border-border rounded-[var(--radius)] bg-background text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            :disabled="page <= 0 || loading"
            aria-label="Previous page"
            @click="$emit('page', page - 1)"
          >
            <ChevronLeft :size="14" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="h-8 w-8 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center border border-border rounded-[var(--radius)] bg-background text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            :disabled="page + 1 >= pageCount || loading"
            aria-label="Next page"
            @click="$emit('page', page + 1)"
          >
            <ChevronRight :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div v-else-if="total > rows.length" class="px-3 py-2 border-t border-border/60 text-xs text-muted-foreground">
        Showing the top {{ rows.length }} of {{ total.toLocaleString() }}.
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "@lucide/vue";
import type { AnalyticsRow, AnalyticsValue } from "../../../../src/analytics/types";
import { compact, durationFormat, pct } from "./formatters";
import { fieldKind, formatField, fullNumber, machineLabel, readableError, usdShort, VALUE_LABELS } from "./labels";
import { METRIC_HELP } from "./meta";

export interface AnalyticsColumn {
  key: string;
  label: string;
  format?: "number" | "usd" | "ms" | "percent" | "date";
}

const props = withDefaults(
  defineProps<{
    columns: AnalyticsColumn[];
    rows: AnalyticsRow[];
    total: number;
    page: number;
    limit: number;
    sort?: string;
    defaultSort?: string;
    loading?: boolean;
    sortable?: boolean;
    paginated?: boolean;
    emptyHint?: string;
  }>(),
  { sortable: true, paginated: true, emptyHint: "Try a wider time range or fewer filters." },
);

defineEmits<{
  (e: "sort", nextSort: string): void;
  (e: "page", nextPage: number): void;
  (e: "limit", limit: number): void;
  (e: "select", row: AnalyticsRow): void;
}>();

/** Sentence-case labels that say what a column holds; the server labels are a fallback. */
const COLUMN_LABELS: Record<string, string> = {
  lastActivity: "Last activity",
  firstSeen: "First used",
  lastSeen: "Last used",
  cacheHitRate: "Cache hit",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  inputTokens: "Uncached input",
  avgDurationMs: "Avg time",
  errorRate: "Error rate",
  directCalls: "Direct",
  codemodeCalls: "Codemode",
  sourceSessionId: "From #",
  sourceTitle: "From",
  targetSessionId: "To #",
  targetTitle: "To",
  targetStatus: "Receiver status",
  targetTotalTokens: "Receiver tokens",
  targetCost: "Receiver cost",
  eventKind: "Type",
  sessionId: "Session",
  thinkingChars: "Thinking chars",
  cacheReadTokens: "Cache read",
  cwd: "Folder",
  worker: "Machine",
  p50DurationMs: "Median",
  outputTokensPerSec: "Output tok/s",
  mismatchRate: "Mismatch",
  uploadBytes: "Upload size",
  avgThinkingChars: "Avg thinking chars",
};

const sortKey = computed(() => (props.sort ?? props.defaultSort ?? "").split(":")[0] ?? "");
const sortDir = computed(() => (props.sort ?? props.defaultSort ?? "").endsWith(":asc") ? "asc" : "desc");
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.limit)));

/** Columns with no value on any visible row only add noise; the sorted column always stays. */
const visibleColumns = computed(() =>
  props.columns.filter((col, i) =>
    i === 0 || col.key === sortKey.value || props.rows.some(r => r[col.key] !== null && r[col.key] !== undefined && r[col.key] !== ""),
  ),
);
const anySelectable = computed(() => props.rows.some(isSelectable));

function columnLabel(col?: AnalyticsColumn): string {
  if (!col) return "";
  return COLUMN_LABELS[col.key] ?? col.label.charAt(0) + col.label.slice(1).toLowerCase();
}

function headerTitle(col: AnalyticsColumn): string {
  const help = METRIC_HELP[col.key];
  const action = sortKey.value === col.key ? `Sorted ${sortDir.value === "desc" ? "high to low" : "low to high"}. Click to reverse.` : "Click to sort.";
  return help ? `${help} ${action}` : action;
}

function ariaSort(key: string): "ascending" | "descending" | "none" {
  if (sortKey.value !== key) return "none";
  return sortDir.value === "asc" ? "ascending" : "descending";
}

function nextSort(key: string): string {
  if (sortKey.value === key) return `${key}:${sortDir.value === "desc" ? "asc" : "desc"}`;
  return `${key}:desc`;
}

function isNumeric(col: AnalyticsColumn): boolean {
  return col.format === "number" || col.format === "usd" || col.format === "ms" || col.format === "percent";
}
function isDate(col: AnalyticsColumn): boolean {
  return col.format === "date" || fieldKind(col.key, null) === "date";
}
function textWidth(col: AnalyticsColumn): string {
  return col.key === "cwd" ? "max-w-[320px]" : "max-w-[260px]";
}

function isSelectable(row: AnalyticsRow): boolean {
  return row.id != null && row.kind != null && String(row.id) !== "" && String(row.kind) !== "";
}

function rowKey(row: AnalyticsRow, idx: number): string {
  return row.kind != null && row.id != null ? `${row.kind}:${row.id}:${idx}` : String(idx);
}

function rowName(row: AnalyticsRow): string {
  const first = props.columns[0];
  return first ? cell(row[first.key], first) : "row";
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" };
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

function toMs(val: AnalyticsValue | undefined): number | null {
  if (typeof val === "number") return val;
  if (typeof val === "string") { const t = Date.parse(val); return Number.isFinite(t) ? t : null; }
  return null;
}

function cell(val: AnalyticsValue | undefined, col?: AnalyticsColumn, row?: AnalyticsRow): string {
  if (!col) return "";
  if (val === null || val === undefined || val === "") {
    return col.key === "title" ? "Untitled session" : "—";
  }
  if (col.key === "worker") return machineLabel(val as string | number);
  // Event tables name a model response after its model; the Model column already shows it.
  if (col.key === "name" && val === row?.model && props.columns.some(c => c.key === "model")) return "—";
  if (isDate(col)) { const ms = toMs(val); return ms == null ? String(val) : shortDate(ms); }
  const kind = fieldKind(col.key, val);
  if (kind === "session") return `#${val}`;
  if (typeof val === "number") {
    if (col.format === "usd") return usdShort(val);
    if (col.format === "ms") return durationFormat(val);
    if (col.format === "percent") return pct(val);
    if (col.key === "id" || col.key.endsWith("Id")) return String(val);
    return kind === "number" || kind === "tokens" ? compact(val) : formatField(col.key, val);
  }
  if (typeof val === "string" && val in VALUE_LABELS) return VALUE_LABELS[val]!;
  if (col.key === "errorReason" && typeof val === "string") return readableError(val);
  return formatField(col.key, val);
}

function cellTitle(val: AnalyticsValue | undefined, col: AnalyticsColumn): string | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  if (isDate(col)) { const ms = toMs(val); return ms == null ? undefined : new Date(ms).toLocaleString(); }
  if (typeof val === "number") return col.format === "usd" ? `$${fullNumber(val)} (estimate)` : fullNumber(val);
  return String(val);
}
</script>
