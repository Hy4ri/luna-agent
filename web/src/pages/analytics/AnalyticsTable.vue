<template>
  <div class="border border-border rounded-[var(--radius)] bg-card overflow-hidden">
    <div v-if="rows.length === 0 && !loading" class="p-6 text-center text-xs text-muted-foreground">
      No matching records for the current filters.
    </div>

    <template v-else>
      <!-- Desktop Table -->
      <div class="hidden min-[761px]:block overflow-x-auto">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="border-b border-border bg-secondary/40 text-left text-muted-foreground">
              <th
                v-for="col in columns"
                :key="col.key"
                scope="col"
                class="px-3 py-2.5 font-medium whitespace-nowrap select-none"
                :class="{ 'text-right': isNumericFormat(col.format) }"
              >
                <button
                  v-if="sortable"
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-[var(--radius)]"
                  :class="{ 'ml-auto': isNumericFormat(col.format) }"
                  @click="$emit('sort', nextSort(col.key))"
                >
                  <span>{{ col.label }}</span>
                  <ArrowUp v-if="sortKey === col.key && sortDir === 'asc'" :size="12" aria-hidden="true" />
                  <ArrowDown v-else-if="sortKey === col.key && sortDir === 'desc'" :size="12" aria-hidden="true" />
                  <ArrowUpDown v-else :size="12" class="opacity-40" aria-hidden="true" />
                </button>
                <span v-else>{{ col.label }}</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/60">
            <tr
              v-for="(row, idx) in rows"
              :key="rowKey(row, idx)"
              :tabindex="isSelectable(row) ? 0 : undefined"
              :role="isSelectable(row) ? 'button' : undefined"
              class="transition-colors"
              :class="isSelectable(row) ? 'hover:bg-secondary/50 cursor-pointer focus:outline-none focus-visible:bg-secondary/60' : ''"
              @click="isSelectable(row) && $emit('select', row)"
              @keydown.enter.prevent="isSelectable(row) && $emit('select', row)"
              @keydown.space.prevent="isSelectable(row) && $emit('select', row)"
            >
              <td
                v-for="col in columns"
                :key="col.key"
                class="px-3 py-2.5 align-top"
                :class="[
                  isNumericFormat(col.format) ? 'text-right tabular-nums whitespace-nowrap' : '',
                  col.key === columns[0]?.key ? 'font-medium text-foreground' : 'text-muted-foreground'
                ]"
              >
                {{ formatCell(row[col.key], col.format) }}
                <span v-if="col.key === columns[0]?.key && row.deletedAt != null" class="ml-2 inline-block border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">Deleted</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Mobile Cards (<= 760px) -->
      <div class="block min-[761px]:hidden divide-y divide-border/60">
        <div
          v-for="(row, idx) in rows"
          :key="rowKey(row, idx)"
          :tabindex="isSelectable(row) ? 0 : undefined"
          :role="isSelectable(row) ? 'button' : undefined"
          class="p-3 grid gap-1.5 text-xs"
          :class="isSelectable(row) ? 'hover:bg-secondary/40 cursor-pointer focus:outline-none focus-visible:bg-secondary/50' : ''"
          @click="isSelectable(row) && $emit('select', row)"
          @keydown.enter.prevent="isSelectable(row) && $emit('select', row)"
          @keydown.space.prevent="isSelectable(row) && $emit('select', row)"
        >
          <div v-for="col in columns" :key="col.key" class="flex items-baseline justify-between gap-3">
            <span class="text-muted-foreground shrink-0">{{ col.label }}</span>
            <span
              class="text-right break-all"
              :class="[
                isNumericFormat(col.format) ? 'tabular-nums' : '',
                col.key === columns[0]?.key ? 'font-medium text-foreground' : 'text-foreground/90'
              ]"
            >
              {{ formatCell(row[col.key], col.format) }}
              <span v-if="col.key === columns[0]?.key && row.deletedAt != null" class="ml-2 inline-block border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">Deleted</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-between gap-3 px-3 py-2.5 border-t border-border/60 bg-secondary/20 text-xs text-muted-foreground">
        <span class="tabular-nums">
          {{ total === 0 ? '0 results' : `${page * limit + 1}–${Math.min((page + 1) * limit, total)} of ${total}` }}
        </span>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1 px-2.5 py-1 border border-border rounded-[var(--radius)] bg-background text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary"
            :disabled="page <= 0 || loading"
            aria-label="Previous page"
            @click="$emit('page', page - 1)"
          >
            <ChevronLeft :size="14" aria-hidden="true" />
            Prev
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 px-2.5 py-1 border border-border rounded-[var(--radius)] bg-background text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-secondary"
            :disabled="(page + 1) * limit >= total || loading"
            aria-label="Next page"
            @click="$emit('page', page + 1)"
          >
            Next
            <ChevronRight :size="14" aria-hidden="true" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "@lucide/vue";
import type { AnalyticsRow, AnalyticsValue } from "../../../../src/analytics/types";
import { durationFormat, full, pct, usd, when } from "./formatters";

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
    loading?: boolean;
    sortable?: boolean;
  }>(),
  {
    sortable: true,
  }
);

defineEmits<{
  (e: "sort", nextSort: string): void;
  (e: "page", nextPage: number): void;
  (e: "select", row: AnalyticsRow): void;
}>();

const sortKey = computed(() => (props.sort ? props.sort.split(":")[0] : ""));
const sortDir = computed(() => (props.sort?.endsWith(":asc") ? "asc" : "desc"));

function nextSort(key: string): string {
  if (sortKey.value === key) {
    return `${key}:${sortDir.value === "desc" ? "asc" : "desc"}`;
  }
  return `${key}:desc`;
}

function isNumericFormat(format?: AnalyticsColumn["format"]): boolean {
  return format === "number" || format === "usd" || format === "ms" || format === "percent";
}

function isSelectable(row: AnalyticsRow): boolean {
  return row.id != null && row.kind != null && String(row.id) !== "" && String(row.kind) !== "";
}

function rowKey(row: AnalyticsRow, idx: number): string {
  if (row.kind != null && row.id != null) return `${row.kind}:${row.id}`;
  return String(idx);
}

function formatCell(val: AnalyticsValue | undefined, format?: AnalyticsColumn["format"]): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") {
    if (format === "usd") return usd(val);
    if (format === "ms") return durationFormat(val);
    if (format === "percent") return pct(val);
    if (format === "date") return when(new Date(val).toISOString());
    return full(val);
  }
  if (format === "date") return when(val);
  return String(val);
}
</script>
