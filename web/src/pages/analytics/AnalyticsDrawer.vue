<template>
  <Dialog :open="open" @update:open="(val) => !val && $emit('close')">
    <DialogContent class="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader class="shrink-0">
        <div class="flex flex-wrap items-start justify-between gap-3 pr-6">
          <div class="space-y-1 min-w-0">
            <DialogTitle class="text-base font-semibold tracking-tight">
              {{ detail?.title || (loading ? "Loading details…" : "Details") }}
            </DialogTitle>
            <DialogDescription class="text-xs text-muted-foreground">
              Details for the selected row · values follow the current filters
            </DialogDescription>
          </div>
          <Button
            v-if="sessionMetadataId !== null"
            variant="outline"
            size="sm"
            class="shrink-0 gap-1.5 rounded-[var(--radius)] min-h-6 max-[760px]:min-h-11 focus-visible:outline-2 focus-visible:outline-ring"
            @click="$emit('open-session', sessionMetadataId)"
          >
            <ExternalLink class="size-3.5" aria-hidden="true" />
            <span>Open conversation</span>
          </Button>
        </div>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-y-auto pr-1 space-y-5 text-xs">
        <div v-if="loading" class="space-y-3 py-2" role="status" aria-busy="true" aria-label="Loading details">
          <div class="h-16 rounded-[var(--radius)] bg-secondary animate-pulse" />
          <div class="h-28 rounded-[var(--radius)] bg-secondary animate-pulse" />
          <div class="h-24 rounded-[var(--radius)] bg-secondary animate-pulse" />
        </div>

        <div
          v-else-if="error"
          class="p-4 border border-destructive/40 rounded-[var(--radius)] bg-destructive/10 text-destructive space-y-2"
        >
          <p class="m-0 font-medium">{{ error }}</p>
          <button
            type="button"
            class="px-3 py-1.5 min-h-6 max-[760px]:min-h-11 text-xs font-medium border border-border rounded-[var(--radius)] bg-background text-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
            @click="$emit('retry')"
          >
            Retry
          </button>
        </div>

        <div v-else-if="!detail" class="py-8 text-center text-muted-foreground">
          Nothing recorded for this item.
        </div>

        <template v-else>
          <div
            v-if="detail.notes.length > 0"
            class="flex items-start gap-2.5 p-3 border border-border rounded-[var(--radius)] bg-secondary/40 text-muted-foreground"
          >
            <Info class="size-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden="true" />
            <div class="space-y-1 min-w-0">
              <p v-for="(note, i) in detail.notes" :key="i" class="m-0 leading-relaxed">{{ note }}</p>
            </div>
          </div>

          <section v-for="(sec, sIdx) in detail.sections" :key="sIdx" class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground m-0">
                  {{ sec.title }}
                </h3>
                <span
                  v-if="sec.rows.length > 1"
                  class="px-1.5 py-0.5 text-[11px] font-medium rounded-[var(--radius)] bg-secondary text-muted-foreground tabular-nums"
                >
                  {{ sec.rows.length }} rows
                </span>
              </div>
              <button
                v-if="sec.rows.length === 1 && emptyCount(sec.rows[0]) > 0"
                type="button"
                class="min-h-6 max-[760px]:min-h-11 text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline rounded-[var(--radius)] px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-ring"
                @click="toggleEmpty(sIdx)"
              >
                {{ showEmpty[sIdx] ? `Hide empty fields (${emptyCount(sec.rows[0])})` : `Show empty fields (${emptyCount(sec.rows[0])})` }}
              </button>
            </div>

            <div v-if="sec.rows.length === 0" class="text-muted-foreground py-2">
              No rows.
            </div>

            <div
              v-else-if="sec.rows.length === 1"
              class="border border-border rounded-[var(--radius)] bg-card p-3"
            >
              <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 m-0">
                <div
                  v-for="[k, v] in visibleEntries(sec.rows[0], sIdx)"
                  :key="k"
                  class="min-w-0 space-y-0.5"
                >
                  <dt class="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {{ fieldLabel(k) }}
                  </dt>
                  <dd
                    class="text-sm text-foreground m-0 break-words tabular-nums"
                    :title="rawTitle(k, v)"
                  >
                    <button
                      v-if="isSessionLink(sec.title, k, v)"
                      type="button"
                      class="min-h-6 max-[760px]:min-h-11 text-[var(--primary-text)] hover:underline font-medium rounded-[var(--radius)] focus-visible:outline-2 focus-visible:outline-ring"
                      :aria-label="`Open session #${v}`"
                      @click="$emit('open-session', Number(v))"
                    >
                      {{ formatField(k, v) }}
                    </button>
                    <span v-else>{{ formatField(k, v) }}</span>
                  </dd>
                </div>
              </dl>
            </div>

            <div
              v-else
              class="border border-border rounded-[var(--radius)] bg-card overflow-hidden"
            >
              <div class="overflow-x-auto max-h-96">
                <table class="w-full border-collapse text-xs">
                  <thead class="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <th
                        v-for="col in tableColumns(sec.rows)"
                        :key="col"
                        scope="col"
                        class="px-3 py-2 font-medium text-[11px] uppercase tracking-wide text-muted-foreground whitespace-nowrap"
                        :class="isNumericColumn(sec.rows, col) ? 'text-right' : 'text-left'"
                      >
                        {{ fieldLabel(col) }}
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-border/60">
                    <tr
                      v-for="(row, rIdx) in visibleRows(sec.rows, sIdx)"
                      :key="rIdx"
                      class="hover:bg-secondary/40"
                    >
                      <td
                        v-for="col in tableColumns(sec.rows)"
                        :key="col"
                        class="px-3 py-2 text-foreground whitespace-nowrap"
                        :class="isNumericKind(fieldKind(col, row[col])) ? 'text-right tabular-nums' : 'text-left'"
                        :title="rawTitle(col, row[col])"
                      >
                        <button
                          v-if="isSessionLink(sec.title, col, row[col])"
                          type="button"
                          class="min-h-6 max-[760px]:min-h-11 text-[var(--primary-text)] hover:underline font-medium rounded-[var(--radius)] focus-visible:outline-2 focus-visible:outline-ring"
                          :aria-label="`Open session #${row[col]}`"
                          @click="$emit('open-session', Number(row[col]))"
                        >
                          {{ formatField(col, row[col]) }}
                        </button>
                        <span v-else>{{ formatField(col, row[col]) }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div
                v-if="sec.rows.length > 25"
                class="px-3 py-2 border-t border-border bg-secondary/20 flex items-center justify-between"
              >
                <span class="text-[11px] text-muted-foreground tabular-nums">
                  Showing {{ showAll[sIdx] ? sec.rows.length : 25 }} of {{ sec.rows.length }} rows
                </span>
                <button
                  type="button"
                  class="min-h-6 max-[760px]:min-h-11 text-[11px] font-medium text-[var(--primary-text)] hover:underline rounded-[var(--radius)] px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-ring"
                  @click="toggleAll(sIdx)"
                >
                  {{ showAll[sIdx] ? "Show first 25" : `Show all ${sec.rows.length}` }}
                </button>
              </div>
            </div>
          </section>
        </template>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
import { ExternalLink, Info } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AnalyticsRow, AnalyticsValue } from "../../../../src/analytics/types";
import type { AnalyticsDetail } from "@/stores/analytics";
import { fieldKind, fieldLabel, formatField, fullNumber, type FieldKind } from "./labels";

const props = defineProps<{
  open: boolean;
  detail: AnalyticsDetail | null;
  loading: boolean;
  error: string | null;
}>();

defineEmits<{
  (e: "close"): void;
  (e: "retry"): void;
  (e: "open-session", id: number): void;
}>();

const showEmpty = reactive<Record<number, boolean>>({});
const showAll = reactive<Record<number, boolean>>({});

function toggleEmpty(idx: number) {
  showEmpty[idx] = !showEmpty[idx];
}

function toggleAll(idx: number) {
  showAll[idx] = !showAll[idx];
}

const sessionMetadataId = computed<number | null>(() => {
  const first = props.detail?.sections?.[0];
  if (!first || first.title !== "Session Metadata" || first.rows.length === 0) return null;
  const id = first.rows[0].id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
});

function isEmptyValue(v: AnalyticsValue | undefined): boolean {
  return v === null || v === undefined || v === "";
}

function emptyCount(row: AnalyticsRow): number {
  return Object.values(row).filter((v) => isEmptyValue(v)).length;
}

function visibleEntries(row: AnalyticsRow, sIdx: number): [string, AnalyticsValue][] {
  const entries = Object.entries(row);
  if (showEmpty[sIdx]) return entries;
  return entries.filter(([, v]) => !isEmptyValue(v));
}

function tableColumns(rows: AnalyticsRow[]): string[] {
  if (rows.length === 0) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        ordered.push(k);
      }
    }
  }
  return ordered.filter((col) => rows.some((r) => !isEmptyValue(r[col])));
}

function visibleRows(rows: AnalyticsRow[], sIdx: number): AnalyticsRow[] {
  if (showAll[sIdx] || rows.length <= 25) return rows;
  return rows.slice(0, 25);
}

function isNumericKind(kind: FieldKind): boolean {
  return (
    kind === "ms" ||
    kind === "usd" ||
    kind === "percent" ||
    kind === "bytes" ||
    kind === "tokens" ||
    kind === "number" ||
    kind === "id"
  );
}

function isNumericColumn(rows: AnalyticsRow[], col: string): boolean {
  for (const r of rows) {
    if (!isEmptyValue(r[col])) {
      return isNumericKind(fieldKind(col, r[col]));
    }
  }
  return false;
}

function isSessionLink(sectionTitle: string, key: string, value: AnalyticsValue | undefined): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const kind = fieldKind(key, value);
  if (kind === "session") return true;
  if (kind === "id" && sectionTitle === "Session Metadata") return true;
  return false;
}

function rawTitle(_key: string, value: AnalyticsValue | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return fullNumber(value);
  return String(value);
}
</script>
