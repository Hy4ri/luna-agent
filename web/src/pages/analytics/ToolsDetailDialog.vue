<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="max-w-[900px] w-[95vw] max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="p-4 border-b border-border bg-sidebar">
        <DialogTitle class="text-[15px] font-semibold">Tools Execution & Error Rates</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Tracked calls, error rates, and tool-reported token costs across all {{ tools.length }} tools.
        </DialogDescription>
      </DialogHeader>

      <div class="p-4 overflow-auto flex-1 max-h-[calc(85vh-80px)]">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-left">Tool Name</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Calls</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Errors</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Error Rate</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Total Tokens</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Cost · USD</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tools" :key="t.name" class="border-b border-border last:border-0 hover:bg-accent/30">
              <td class="p-2.5 text-left font-mono font-medium text-foreground">{{ t.name }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(t.calls) }}</td>
              <td class="p-2.5 text-right font-mono" :class="{ 'text-destructive font-medium': t.errors > 0 }">{{ full(t.errors) }}</td>
              <td class="p-2.5 text-right font-mono" :class="{ 'text-destructive font-medium': (t.errorRate || 0) > 0.05 }">
                {{ t.errorRate == null ? '—' : (t.errorRate * 100).toFixed(1) + '%' }}
              </td>
              <td class="p-2.5 text-right font-mono">{{ compact(t.usage.totalTokens) }}</td>
              <td class="p-2.5 text-right font-mono">{{ usd(t.usage.cost?.total) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { ToolDetailed } from "./types"
import { full, compact, usd } from "./formatters"

defineProps<{
  open: boolean
  tools: ToolDetailed[]
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
}>()
</script>
