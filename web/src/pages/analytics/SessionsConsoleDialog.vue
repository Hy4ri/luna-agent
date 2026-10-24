<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="max-w-[1150px] w-[95vw] max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="p-4 border-b border-border bg-sidebar">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <DialogTitle class="text-[15px] font-semibold">Sessions Explorer</DialogTitle>
            <DialogDescription class="text-xs text-muted-foreground">
              Per-session usage, turns, tool errors, and duration across all {{ sessions.length }} sessions.
            </DialogDescription>
          </div>
          <div class="flex items-center gap-2">
            <span v-if="selectedCount" class="text-xs text-muted-foreground">{{ selectedCount }} selected</span>
            <Button v-if="selectedCount" variant="outline" size="sm" class="h-7 text-xs" @click="emit('clearSelection')">Clear</Button>
          </div>
        </div>

        <!-- Filter & Search Controls -->
        <div class="flex items-center gap-2.5 flex-wrap mt-3 pt-2 border-t border-border/60">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search title or ID..."
            class="h-8 px-2.5 text-xs text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring w-[190px]"
          />

          <select
            v-model="sortField"
            class="h-8 px-2 text-xs text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="tokensDesc">Tokens · High to Low</option>
            <option value="tokensAsc">Tokens · Low to High</option>
            <option value="costDesc">Cost · High to Low</option>
            <option value="responsesDesc">Responses · High to Low</option>
            <option value="durationDesc">Duration · Long to Short</option>
            <option value="activityDesc">Last Activity · Newest</option>
          </select>

          <!-- Status Chips Filter -->
          <div class="flex items-center gap-1.5 flex-wrap ml-auto">
            <button
              type="button"
              class="h-6 px-2 rounded-full border text-[11px] font-medium transition-colors"
              :class="activeStatusFilter === '' ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-foreground border-border hover:bg-accent'"
              @click="activeStatusFilter = ''"
            >
              All ({{ sessions.length }})
            </button>
            <button
              v-for="(count, st) in statusBreakdown"
              :key="st"
              type="button"
              class="h-6 px-2 rounded-full border text-[11px] font-medium transition-colors"
              :class="activeStatusFilter === st ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-foreground border-border hover:bg-accent'"
              @click="activeStatusFilter = st"
            >
              {{ statusLabel(st as SessionStatus) }} · {{ count }}
            </button>
          </div>
        </div>
      </DialogHeader>

      <!-- Table Content -->
      <div class="p-4 overflow-auto flex-1 max-h-[calc(90vh-140px)]">
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-left">Session</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-left">Status</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Tokens</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Cost</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Hit Rate</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Responses</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Duration</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-left">Last Activity</th>
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!pagedSessions.length">
              <td colspan="9" class="p-6 text-center text-muted-foreground">No sessions match current filter.</td>
            </tr>
            <tr
              v-for="s in pagedSessions"
              :key="s.id"
              class="border-b border-border last:border-0 hover:bg-accent/30 cursor-pointer"
              @click="emit('inspect', s)"
            >
              <td class="p-2.5 text-left max-w-[260px] truncate">
                <span class="font-medium text-foreground text-[13px] block truncate">{{ s.title || 'Untitled Session' }}</span>
                <span class="text-muted-foreground font-mono text-[10px] block">#{{ s.id }} <span v-if="s.subagentCount">· {{ s.subagentCount }} subagents</span></span>
              </td>
              <td class="p-2.5 text-left">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium" :class="statusChipClass(s.status)">
                  {{ statusLabel(s.status) }}
                </span>
              </td>
              <td class="p-2.5 text-right font-mono font-medium">{{ compact(s.usage.totalTokens) }}</td>
              <td class="p-2.5 text-right font-mono text-primary-text font-medium">{{ usd(s.usage.cost?.total) }}</td>
              <td class="p-2.5 text-right font-mono">{{ pct(s.usage.cacheHitRate) }}</td>
              <td class="p-2.5 text-right font-mono">{{ full(s.responses) }}</td>
              <td class="p-2.5 text-right font-mono">{{ durationFormat(s.durationMs) }}</td>
              <td class="p-2.5 text-left text-muted-foreground text-[11px] font-mono">{{ when(s.lastActivity) }}</td>
              <td class="p-2.5 text-right" @click.stop>
                <Button type="button" variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="emit('inspect', s)">
                  Inspect
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination Footer -->
      <div class="p-3 border-t border-border bg-sidebar flex items-center justify-between text-xs text-muted-foreground">
        <span>Showing {{ startIdx + 1 }}–{{ Math.min(startIdx + pageSize, filteredSessions.length) }} of {{ full(filteredSessions.length) }} sessions</span>
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="currentPage === 0" @click="currentPage = 0">First</Button>
          <Button type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="currentPage === 0" @click="currentPage--">Prev</Button>
          <span class="px-1 font-mono">Page {{ currentPage + 1 }} of {{ totalPages }}</span>
          <Button type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="currentPage >= totalPages - 1" @click="currentPage++">Next</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, computed } from "vue"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { AnalyticsSession } from "./types"
import type { SessionStatus } from "@/lib/types"
import { SESSION_STATUS_LABELS } from "@/lib/session-status"
import { full, compact, usd, pct, when, durationFormat } from "./formatters"

const props = defineProps<{
  open: boolean
  sessions: AnalyticsSession[]
  statusBreakdown?: Record<string, number>
  selectedCount?: number
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
  (e: "inspect", session: AnalyticsSession): void
  (e: "clearSelection"): void
}>()

const searchQuery = ref("")
const sortField = ref("tokensDesc")
const activeStatusFilter = ref<string>("")
const currentPage = ref(0)
const pageSize = 20

function statusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABELS[status] || status
}

function statusChipClass(status: SessionStatus): string {
  switch (status) {
    case "running": return "border-blue-500/40 bg-blue-500/10 text-blue-400"
    case "finished": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    case "needs_approval": return "border-amber-500/40 bg-amber-500/10 text-amber-400"
    case "needs_input": return "border-purple-500/40 bg-purple-500/10 text-purple-400"
    case "limit_reached": return "border-orange-500/40 bg-orange-500/10 text-orange-400"
    case "failed": return "border-destructive/40 bg-destructive/10 text-destructive"
    default: return "border-border bg-secondary text-foreground"
  }
}

const filteredSessions = computed(() => {
  let list = props.sessions
  if (activeStatusFilter.value) {
    list = list.filter((s) => s.status === activeStatusFilter.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter((s) => (s.title && s.title.toLowerCase().includes(q)) || s.id.includes(q))
  }

  return [...list].sort((a, b) => {
    switch (sortField.value) {
      case "tokensDesc": return (b.usage?.totalTokens || 0) - (a.usage?.totalTokens || 0)
      case "tokensAsc": return (a.usage?.totalTokens || 0) - (b.usage?.totalTokens || 0)
      case "costDesc": return (b.usage?.cost?.total || 0) - (a.usage?.cost?.total || 0)
      case "responsesDesc": return (b.responses || 0) - (a.responses || 0)
      case "durationDesc": return (b.durationMs || 0) - (a.durationMs || 0)
      case "activityDesc": return new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime()
      default: return 0
    }
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredSessions.value.length / pageSize)))
const startIdx = computed(() => currentPage.value * pageSize)
const pagedSessions = computed(() => filteredSessions.value.slice(startIdx.value, startIdx.value + pageSize))
</script>
