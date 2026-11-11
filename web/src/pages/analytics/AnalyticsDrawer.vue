<template>
  <Dialog :open="open" @update:open="(val) => !val && $emit('close')">
    <DialogContent class="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader class="shrink-0">
        <DialogTitle class="text-base font-semibold tracking-tight pr-6">
          {{ detail?.title || (loading ? "Loading details…" : "Details") }}
        </DialogTitle>
        <DialogDescription class="sr-only">
          Analytics detail view
        </DialogDescription>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4 text-xs">
        <div v-if="loading" class="py-8 text-center text-muted-foreground" role="status" aria-busy="true">
          Loading details…
        </div>

        <div v-else-if="error" class="p-4 border border-destructive/40 rounded-[var(--radius)] bg-destructive/10 text-destructive space-y-2">
          <p class="m-0 font-medium">{{ error }}</p>
          <button
            type="button"
            class="px-3 py-1.5 text-xs font-medium border border-border rounded-[var(--radius)] bg-background text-foreground hover:bg-secondary"
            @click="$emit('retry')"
          >
            Retry
          </button>
        </div>

        <div v-else-if="!detail" class="py-8 text-center text-muted-foreground">
          No detail record found.
        </div>

        <template v-else>
          <div v-if="detail.notes.length > 0" class="p-3 border border-border rounded-[var(--radius)] bg-secondary/40 text-muted-foreground space-y-1">
            <p v-for="(note, i) in detail.notes" :key="i" class="m-0">{{ note }}</p>
          </div>

          <section v-for="(sec, sIdx) in detail.sections" :key="sIdx" class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground m-0">
              {{ sec.title }}
            </h3>
            <div v-if="sec.rows.length === 0" class="text-muted-foreground py-2">
              No rows.
            </div>
            <div v-else class="border border-border rounded-[var(--radius)] divide-y divide-border/60 bg-card overflow-hidden">
              <div v-for="(row, rIdx) in sec.rows" :key="rIdx" class="p-2.5 grid gap-1">
                <div
                  v-for="[k, v] in Object.entries(row)"
                  :key="k"
                  class="flex items-baseline justify-between gap-4"
                >
                  <span class="text-muted-foreground shrink-0">{{ k }}</span>
                  <span class="text-foreground text-right break-all tabular-nums">
                    {{ formatValue(k, v) }}
                  </span>
                </div>
              </div>
            </div>
          </section>
        </template>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AnalyticsValue } from "../../../../src/analytics/types";
import type { AnalyticsDetail } from "@/stores/analytics";
import { compact, durationFormat, pct, usd, when } from "./formatters";

defineProps<{
  open: boolean;
  detail: AnalyticsDetail | null;
  loading: boolean;
  error: string | null;
}>();

defineEmits<{
  (e: "close"): void;
  (e: "retry"): void;
}>();

function formatValue(key: string, v: AnalyticsValue): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (key === "id" || key.endsWith("Id")) return String(v);
    const k = key.toLowerCase();
    if (k === "ts") return when(new Date(v).toISOString());
    if (k.includes("cost") || k.includes("usd")) return usd(v);
    if (k.endsWith("ms") || k.includes("duration") || k.includes("latency")) return durationFormat(v);
    if (k.includes("rate") || k.includes("pct") || k.includes("percent")) return pct(v);
    return compact(v);
  }
  return String(v);
}
</script>
