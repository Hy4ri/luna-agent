<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="analytics-dialog sm:max-w-[1050px] w-[calc(100vw-2rem)] max-h-[88dvh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="shrink-0 p-4 pr-12 border-b border-border bg-sidebar">
        <DialogTitle class="text-[15px] font-semibold">Model usage</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Recorded usage, token composition, and cache hit rate across all {{ models.length }} models.
        </DialogDescription>
        <p class="text-xs text-muted-foreground m-0">Select a column header to sort; select it again to reverse. <span class="sm:hidden">Scroll the table sideways for more columns.</span></p>
      </DialogHeader>

      <div class="p-4 overflow-auto min-h-0 min-w-0 flex-1" role="region" tabindex="0" aria-label="Model usage table">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <SortHeader label="Model &amp; Provider" :active="sortKey === 'model'" :descending="descending" align="left" @sort="sortBy('model')" />
              <SortHeader label="Total Tokens" :active="sortKey === 'tokens'" :descending="descending" align="right" @sort="sortBy('tokens')" />
              <SortHeader label="Input" :active="sortKey === 'input'" :descending="descending" align="right" @sort="sortBy('input')" />
              <SortHeader label="Output" :active="sortKey === 'output'" :descending="descending" align="right" @sort="sortBy('output')" />
              <SortHeader label="Cache Read" :active="sortKey === 'cacheRead'" :descending="descending" align="right" @sort="sortBy('cacheRead')" />
              <SortHeader label="Hit Rate" :active="sortKey === 'hitRate'" :descending="descending" align="right" @sort="sortBy('hitRate')" />
              <SortHeader label="Cost · USD" :active="sortKey === 'cost'" :descending="descending" align="right" @sort="sortBy('cost')" />
              <SortHeader label="Responses" :active="sortKey === 'responses'" :descending="descending" align="right" @sort="sortBy('responses')" />
              <SortHeader label="Sessions" :active="sortKey === 'sessions'" :descending="descending" align="right" @sort="sortBy('sessions')" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sortedRows.length"><td colspan="9" class="p-6 text-center text-muted-foreground">No models recorded.</td></tr>
            <tr
              v-for="m in sortedRows"
              :key="m.key"
              class="border-b border-border last:border-0 hover:bg-accent/30 cursor-pointer"
              :class="{ 'bg-primary/10 border-l-2 border-l-primary-text': selectedKey === m.key }"
              @click="emit('select', m.key)"
            >
              <td class="p-2.5 text-left">
                <button type="button" class="font-medium text-foreground text-[13px] block text-left underline-offset-4 hover:underline focus-visible:underline" :aria-pressed="selectedKey === m.key" @click.stop="emit('select', m.key)">{{ m.model }}</button>
                <span class="text-muted-foreground text-[11px] block">{{ m.provider }}</span>
              </td>
              <td class="p-2.5 text-right font-medium">{{ compact(m.usage.totalTokens) }}</td>
              <td class="p-2.5 text-right">{{ compact(m.usage.input) }}</td>
              <td class="p-2.5 text-right">{{ compact(m.usage.output) }}</td>
              <td class="p-2.5 text-right">{{ compact(m.usage.cacheRead) }}</td>
              <td class="p-2.5 text-right">{{ pct(m.usage.cacheHitRate) }}</td>
              <td class="p-2.5 text-right text-primary-text font-medium">{{ usd(m.usage.cost.total) }}</td>
              <td class="p-2.5 text-right">{{ compact(m.responses) }}</td>
              <td class="p-2.5 text-right">{{ compact(m.sessions) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import SortHeader from "./SortHeader.vue"
import { useTableSort } from "./useTableSort"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { ModelItem } from "./types"
import { compact, usd, pct } from "./formatters"

const props = defineProps<{
  open: boolean
  models: ModelItem[]
  selectedKey?: string
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
  (e: "select", key: string): void
}>()

const { sortKey, descending, sortBy, sortedRows } = useTableSort(() => props.models, {
  model: (r: ModelItem) => r.model + " · " + r.provider,
  tokens: (r: ModelItem) => r.usage.totalTokens,
  input: (r: ModelItem) => r.usage.input,
  output: (r: ModelItem) => r.usage.output,
  cacheRead: (r: ModelItem) => r.usage.cacheRead,
  hitRate: (r: ModelItem) => r.usage.cacheHitRate,
  cost: (r: ModelItem) => r.usage.cost.total,
  responses: (r: ModelItem) => r.responses,
  sessions: (r: ModelItem) => r.sessions,
}, "tokens", true)
</script>
