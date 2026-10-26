<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="analytics-dialog sm:max-w-[850px] w-[calc(100vw-2rem)] max-h-[85dvh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="shrink-0 p-4 pr-12 border-b border-border bg-sidebar">
        <DialogTitle class="text-[15px] font-semibold">Daily Values History (UTC)</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Dated assistant responses over the last 30 active days.
        </DialogDescription>
      </DialogHeader>

      <div class="p-4 overflow-auto min-h-0 min-w-0 flex-1">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-left">Date</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Responses</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Input</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Output</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Cache Read</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Cache Write</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in items" :key="d.date" class="border-b border-border last:border-0 hover:bg-accent/30">
              <td class="p-2.5 text-left font-mono font-medium">{{ d.date }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(d.responses) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(d.input) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(d.output) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(d.cacheRead) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(d.cacheWrite) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { DailyItem } from "./types"
import { full } from "./formatters"

defineProps<{
  open: boolean
  items: DailyItem[]
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
}>()
</script>
