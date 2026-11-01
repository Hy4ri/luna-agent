<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="analytics-dialog sm:max-w-[750px] w-[calc(100vw-2rem)] max-h-[85dvh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="shrink-0 p-4 pr-12 border-b border-border bg-sidebar">
        <div class="flex items-center gap-2">
          <DialogTitle class="text-[15px] font-semibold flex-1 truncate">
            {{ session?.title || 'Untitled Session' }}
          </DialogTitle>
          <span v-if="session" class="text-xs text-muted-foreground">#{{ session.id }}</span>
        </div>
        <DialogDescription class="text-xs text-muted-foreground flex items-center gap-2 mt-1">
          <span v-if="session" class="inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium" :class="statusChipClass(session.status)">
            {{ statusLabel(session.status) }}
          </span>
          <span v-if="session?.statusReason">{{ session.statusReason }}</span>
        </DialogDescription>
      </DialogHeader>

      <div v-if="session" class="p-4 overflow-auto min-h-0 min-w-0 flex-1 space-y-4">
        <!-- Top Metrics Cards -->
        <div class="grid grid-cols-3 max-[600px]:grid-cols-1 gap-3">
          <div class="border border-border rounded-[var(--radius)] p-3 bg-secondary/50">
            <span class="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Total Tokens</span>
            <strong class="text-xl font-semibold">{{ compact(session.usage.totalTokens) }}</strong>
            <span class="text-xs text-muted-foreground block mt-0.5">Hit rate: {{ pct(session.usage.cacheHitRate) }}</span>
          </div>
          <div class="border border-border rounded-[var(--radius)] p-3 bg-secondary/50">
            <span class="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Recorded Cost</span>
            <strong class="text-xl font-semibold text-primary-text">{{ usd(session.usage.cost?.total) }}</strong>
            <span class="text-xs text-muted-foreground block mt-0.5">Observed ledger</span>
          </div>
          <div class="border border-border rounded-[var(--radius)] p-3 bg-secondary/50">
            <span class="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">Turns & Activity</span>
            <strong class="text-xl font-semibold">{{ full(session.responses) }} resp</strong>
            <span class="text-xs text-muted-foreground block mt-0.5">{{ full(session.turns?.user) }} user / {{ full(session.turns?.assistant) }} asst</span>
          </div>
        </div>

        <!-- Token Breakdown -->
        <div class="border border-border rounded-[var(--radius)] p-3.5 bg-card">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Token Breakdown</div>
          <div class="grid grid-cols-4 max-[600px]:grid-cols-2 gap-3 text-xs">
            <div>
              <span class="text-muted-foreground block text-[11px]">Uncached Input</span>
              <strong class="text-[13px]">{{ full(session.usage.input) }}</strong>
            </div>
            <div>
              <span class="text-muted-foreground block text-[11px]">Output</span>
              <strong class="text-[13px]">{{ full(session.usage.output) }}</strong>
            </div>
            <div>
              <span class="text-muted-foreground block text-[11px]">Cache Read</span>
              <strong class="text-[13px]">{{ full(session.usage.cacheRead) }}</strong>
            </div>
            <div>
              <span class="text-muted-foreground block text-[11px]">Cache Write</span>
              <strong class="text-[13px]">{{ full(session.usage.cacheWrite) }}</strong>
            </div>
          </div>
          <div class="mt-2.5 pt-2 border-t border-border flex justify-between text-xs text-muted-foreground">
            <span>Reasoning: <strong class="text-foreground">{{ session.usage.reasoning != null ? full(session.usage.reasoning) : '—' }}</strong></span>
            <span>Avg tokens/turn: <strong class="text-foreground">{{ session.avgTokensPerTurn != null ? full(Math.round(session.avgTokensPerTurn)) : '—' }}</strong></span>
          </div>
        </div>

        <!-- Execution Environment -->
        <div class="border border-border rounded-[var(--radius)] p-3.5 bg-card">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">Execution Details</div>
          <div class="grid grid-cols-2 max-[600px]:grid-cols-1 gap-2.5 text-xs">
            <div><span class="text-muted-foreground">Duration:</span> <strong class="">{{ durationFormat(session.durationMs) }}</strong></div>
            <div><span class="text-muted-foreground">Target Worker:</span> <strong class="">{{ session.worker != null ? '#' + session.worker : 'Main' }}</strong></div>
            <div><span class="text-muted-foreground">Tool Calls:</span> <strong class="">{{ full(session.toolCalls) }} ({{ full(session.toolErrors) }} errors)</strong></div>
            <div><span class="text-muted-foreground">Subagents:</span> <strong class="">{{ full(session.subagentCount) }} (Depth: {{ session.forkDepth }})</strong></div>
            <div><span class="text-muted-foreground">Project:</span> <strong class="text-primary-text">{{ session.projectName || 'General' }} (#{{ session.projectId }})</strong></div>
            <div><span class="text-muted-foreground">Last Activity:</span> <span class="">{{ when(session.lastActivity) }}</span></div>
            <div class="col-span-2 max-[600px]:col-span-1"><span class="text-muted-foreground">Models:</span> <span>{{ (session.models || []).join(', ') || '—' }}</span></div>
            <div class="col-span-2 max-[600px]:col-span-1" v-if="session.skills?.length"><span class="text-muted-foreground">Skills:</span> <span>{{ session.skills.join(', ') }}</span></div>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { AnalyticsSession } from "./types"
import { statusLabel, statusChipClass } from "@/lib/session-status"
import { full, compact, usd, pct, when, durationFormat } from "./formatters"

defineProps<{
  open: boolean
  session: AnalyticsSession | null
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
}>()
</script>
