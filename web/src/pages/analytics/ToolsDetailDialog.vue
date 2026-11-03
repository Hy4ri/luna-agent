<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="analytics-dialog sm:max-w-[900px] w-[calc(100vw-2rem)] max-h-[85dvh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="shrink-0 p-4 pr-12 border-b border-border bg-sidebar">
        <DialogTitle class="text-[15px] font-semibold">Tools Execution & Error Rates</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Tracked calls, error rates, and tool-reported token costs across all {{ tools.length }} tools.
        </DialogDescription>
        <p class="text-xs text-muted-foreground m-0">Select a column header to sort; select it again to reverse. <span class="sm:hidden">Scroll the table sideways for more columns.</span></p>
      </DialogHeader>

      <div class="p-4 overflow-auto min-h-0 min-w-0 flex-1" role="region" tabindex="0" aria-label="Tool usage table">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <SortHeader label="Tool Name" :active="sortKey === 'name'" :descending="descending" align="left" @sort="sortBy('name')" />
              <SortHeader label="Calls" :active="sortKey === 'calls'" :descending="descending" align="right" @sort="sortBy('calls')" />
              <SortHeader label="Errors" :active="sortKey === 'errors'" :descending="descending" align="right" @sort="sortBy('errors')" />
              <SortHeader label="Error Rate" :active="sortKey === 'errorRate'" :descending="descending" align="right" @sort="sortBy('errorRate')" />
              <SortHeader label="Total Tokens" :active="sortKey === 'tokens'" :descending="descending" align="right" @sort="sortBy('tokens')" />
              <SortHeader label="Cost · USD" :active="sortKey === 'cost'" :descending="descending" align="right" @sort="sortBy('cost')" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sortedRows.length"><td colspan="6" class="p-6 text-center text-muted-foreground">No tools recorded.</td></tr>
            <tr v-for="t in sortedRows" :key="t.name" class="border-b border-border last:border-0 hover:bg-accent/30">
              <td class="p-2.5 text-left font-medium text-foreground">{{ t.name }}</td>
              <td class="p-2.5 text-right">{{ compact(t.calls) }}</td>
              <td class="p-2.5 text-right" :class="{ 'text-destructive font-medium': t.errors > 0 }">{{ compact(t.errors) }}</td>
              <td class="p-2.5 text-right" :class="{ 'text-destructive font-medium': (t.errorRate || 0) > 0.05 }">
                {{ t.errorRate == null ? '—' : (t.errorRate * 100).toFixed(1) + '%' }}
              </td>
              <td class="p-2.5 text-right">{{ compact(t.usage.totalTokens) }}</td>
              <td class="p-2.5 text-right">{{ usd(t.usage.cost?.total) }}</td>
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
import type { ToolDetailed } from "./types"
import { compact, usd } from "./formatters"

const props = defineProps<{
  open: boolean
  tools: ToolDetailed[]
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
}>()

const { sortKey, descending, sortBy, sortedRows } = useTableSort(() => props.tools, {
  name: (r: ToolDetailed) => r.name,
  calls: (r: ToolDetailed) => r.calls,
  errors: (r: ToolDetailed) => r.errors,
  errorRate: (r: ToolDetailed) => r.errorRate,
  tokens: (r: ToolDetailed) => r.usage.totalTokens,
  cost: (r: ToolDetailed) => r.usage.cost.total,
}, "calls", true)
</script>
