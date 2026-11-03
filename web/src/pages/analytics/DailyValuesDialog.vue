<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="analytics-dialog sm:max-w-[850px] w-[calc(100vw-2rem)] max-h-[85dvh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="shrink-0 p-4 pr-12 border-b border-border bg-sidebar">
        <DialogTitle class="text-[15px] font-semibold">Daily Values History (UTC)</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Dated assistant responses over the last 30 active days.
        </DialogDescription>
        <p class="text-xs text-muted-foreground m-0">Select a column header to sort; select it again to reverse. <span class="sm:hidden">Scroll the table sideways for more columns.</span></p>
      </DialogHeader>

      <div class="p-4 overflow-auto min-h-0 min-w-0 flex-1" role="region" tabindex="0" aria-label="Daily token values table">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <SortHeader label="Date" :active="sortKey === 'date'" :descending="descending" align="left" @sort="sortBy('date')" />
              <SortHeader label="Responses" :active="sortKey === 'responses'" :descending="descending" align="right" @sort="sortBy('responses')" />
              <SortHeader label="Input" :active="sortKey === 'input'" :descending="descending" align="right" @sort="sortBy('input')" />
              <SortHeader label="Output" :active="sortKey === 'output'" :descending="descending" align="right" @sort="sortBy('output')" />
              <SortHeader label="Cache Read" :active="sortKey === 'cacheRead'" :descending="descending" align="right" @sort="sortBy('cacheRead')" />
              <SortHeader label="Cache Write" :active="sortKey === 'cacheWrite'" :descending="descending" align="right" @sort="sortBy('cacheWrite')" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="!sortedRows.length"><td colspan="6" class="p-6 text-center text-muted-foreground">No daily usage recorded.</td></tr>
            <tr v-for="d in sortedRows" :key="d.date" class="border-b border-border last:border-0 hover:bg-accent/30">
              <td class="p-2.5 text-left font-medium">{{ d.date }}</td>
              <td class="p-2.5 text-right">{{ compact(d.responses) }}</td>
              <td class="p-2.5 text-right">{{ compact(d.input) }}</td>
              <td class="p-2.5 text-right">{{ compact(d.output) }}</td>
              <td class="p-2.5 text-right">{{ compact(d.cacheRead) }}</td>
              <td class="p-2.5 text-right">{{ compact(d.cacheWrite) }}</td>
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
import type { DailyItem } from "./types"
import { compact } from "./formatters"

const props = defineProps<{
  open: boolean
  items: DailyItem[]
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
}>()

const { sortKey, descending, sortBy, sortedRows } = useTableSort(() => props.items, {
  date: (r: DailyItem) => r.date,
  responses: (r: DailyItem) => r.responses,
  input: (r: DailyItem) => r.input,
  output: (r: DailyItem) => r.output,
  cacheRead: (r: DailyItem) => r.cacheRead,
  cacheWrite: (r: DailyItem) => r.cacheWrite,
}, "date", false)
</script>
