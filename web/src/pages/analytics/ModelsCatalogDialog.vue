<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="max-w-[1050px] w-[95vw] max-h-[88vh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="p-4 border-b border-border bg-sidebar">
        <DialogTitle class="text-[15px] font-semibold">Models Catalog & Rates</DialogTitle>
        <DialogDescription class="text-xs text-muted-foreground">
          Detailed ledger usage, token composition, hit rate, and current catalog rates across all {{ models.length }} models.
        </DialogDescription>
      </DialogHeader>

      <div class="p-4 overflow-auto flex-1 max-h-[calc(88vh-80px)]">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-left">Model & Provider</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Total Tokens</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Input</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Output</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Cache Read</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Hit Rate</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Cost · USD</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Responses</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Sessions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in models"
              :key="m.key"
              class="border-b border-border last:border-0 hover:bg-accent/30 cursor-pointer"
              :class="{ 'bg-primary/10 border-l-2 border-l-primary-text': selectedKey === m.key }"
              @click="emit('select', m.key)"
            >
              <td class="p-2.5 text-left">
                <span class="font-medium text-foreground text-[13px] block">{{ m.model }}</span>
                <span class="text-muted-foreground text-[11px] block">{{ m.provider }}</span>
              </td>
              <td class="p-2.5 text-right font-mono font-medium">{{ full(m.usage.totalTokens) }}</td>
              <td class="p-2.5 text-right font-mono">{{ compact(m.usage.input) }}</td>
              <td class="p-2.5 text-right font-mono">{{ compact(m.usage.output) }}</td>
              <td class="p-2.5 text-right font-mono">{{ compact(m.usage.cacheRead) }}</td>
              <td class="p-2.5 text-right font-mono">{{ pct(m.usage.cacheHitRate) }}</td>
              <td class="p-2.5 text-right font-mono text-primary-text font-medium">{{ usd(m.usage.cost.total) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(m.responses) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(m.sessions) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { ModelItem } from "./types"
import { full, compact, usd, pct } from "./formatters"

defineProps<{
  open: boolean
  models: ModelItem[]
  selectedKey?: string
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
  (e: "select", key: string): void
}>()
</script>
