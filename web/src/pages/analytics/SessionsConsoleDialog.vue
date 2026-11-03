<template>
  <Dialog :open="open" @update:open="(val) => emit('update:open', val)">
    <DialogContent class="analytics-dialog sm:max-w-[1150px] w-[calc(100vw-2rem)] max-h-[90dvh] flex flex-col p-0 gap-0 overflow-hidden bg-card border-border">
      <DialogHeader class="shrink-0 p-4 pr-12 border-b border-border bg-sidebar">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <DialogTitle class="text-[15px] font-semibold">Sessions Explorer</DialogTitle>
            <DialogDescription class="text-xs text-muted-foreground">
              Per-session usage, turns, tool errors, and duration across all {{ allTotal }} sessions.
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
            aria-label="Search sessions"
            placeholder="Search title or ID..."
            class="h-8 px-2.5 text-xs text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring w-[190px]"
          />


          <!-- Status Chips Filter -->
          <div class="flex items-center gap-1.5 flex-wrap ml-auto">
            <button
              type="button"
              :aria-pressed="activeStatusFilter === ''"
              class="min-h-8 px-2 rounded-full border text-[11px] font-medium transition-colors"
              :class="activeStatusFilter === '' ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-foreground border-border hover:bg-accent'"
              @click="activeStatusFilter = ''"
            >
              All ({{ allTotal }})
            </button>
            <button
              v-for="(count, st) in statusBreakdown"
              :key="st"
              type="button"
              :aria-pressed="activeStatusFilter === st"
              class="min-h-8 px-2 rounded-full border text-[11px] font-medium transition-colors"
              :class="activeStatusFilter === st ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-foreground border-border hover:bg-accent'"
              @click="activeStatusFilter = st"
            >
              {{ statusLabel(st as SessionStatus) }} · {{ count }}
            </button>
          </div>
        </div>
        <p class="text-xs text-muted-foreground m-0">Select a column header to sort; select it again to reverse. <span class="sm:hidden">Scroll the table sideways for more columns.</span></p>
      </DialogHeader>

      <!-- Table Content -->
      <div class="p-4 overflow-auto min-h-0 min-w-0 flex-1" role="region" tabindex="0" aria-label="Session usage table" :aria-busy="loading">
        <p v-if="loading" role="status" class="mb-3 text-muted-foreground">Loading sessions…</p>
        <div v-if="errorMessage" role="alert" class="mb-3 text-destructive">
          {{ errorMessage }}
          <Button type="button" variant="outline" size="sm" class="ml-2" @click="scheduleLoad(true)">Retry</Button>
        </div>
        <table class="w-full border-collapse text-xs whitespace-nowrap tabular-nums">
          <thead class="sticky top-0 bg-secondary/80 backdrop-blur z-10">
            <tr class="border-b border-border">
              <SortHeader label="Session" :active="sortField.startsWith('title')" :descending="sortField.endsWith('Desc')" align="left" @sort="sortBy('title')" />
              <SortHeader label="Status" :active="sortField.startsWith('status')" :descending="sortField.endsWith('Desc')" align="left" @sort="sortBy('status')" />
              <SortHeader label="Tokens" :active="sortField.startsWith('tokens')" :descending="sortField.endsWith('Desc')" align="right" @sort="sortBy('tokens')" />
              <SortHeader label="Cost" :active="sortField.startsWith('cost')" :descending="sortField.endsWith('Desc')" align="right" @sort="sortBy('cost')" />
              <SortHeader label="Hit Rate" :active="sortField.startsWith('hitRate')" :descending="sortField.endsWith('Desc')" align="right" @sort="sortBy('hitRate')" />
              <SortHeader label="Responses" :active="sortField.startsWith('responses')" :descending="sortField.endsWith('Desc')" align="right" @sort="sortBy('responses')" />
              <SortHeader label="Duration" :active="sortField.startsWith('duration')" :descending="sortField.endsWith('Desc')" align="right" @sort="sortBy('duration')" />
              <SortHeader label="Last Activity" :active="sortField.startsWith('activity')" :descending="sortField.endsWith('Desc')" align="left" @sort="sortBy('activity')" />
              <th scope="col" class="text-muted-foreground text-[11px] font-medium uppercase tracking-wider p-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!loading && !errorMessage && !pagedSessions.length">
              <td colspan="9" class="p-6 text-center text-muted-foreground">No sessions match current filter.</td>
            </tr>
            <tr
              v-for="s in pagedSessions"
              :key="s.id"
              class="border-b border-border last:border-0 hover:bg-accent/30 cursor-pointer"
              @click="emit('inspect', s)"
            >
              <td class="p-2.5 text-left max-w-[260px] truncate">
                <span class="font-medium text-foreground text-[13px] block truncate" :title="s.title || 'Untitled session'">{{ s.title || 'Untitled session' }}</span>
                <span class="text-muted-foreground text-[10px] block">#{{ s.id }} <span v-if="s.subagentCount">· {{ s.subagentCount }} subagents</span></span>
              </td>
              <td class="p-2.5 text-left">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium" :class="statusChipClass(s.status)">
                  {{ statusLabel(s.status) }}
                </span>
              </td>
              <td class="p-2.5 text-right font-medium">{{ compact(s.usage.totalTokens) }}</td>
              <td class="p-2.5 text-right text-primary-text font-medium">{{ usd(s.usage.cost?.total) }}</td>
              <td class="p-2.5 text-right">{{ pct(s.usage.cacheHitRate) }}</td>
              <td class="p-2.5 text-right">{{ compact(s.responses) }}</td>
              <td class="p-2.5 text-right">{{ durationFormat(s.durationMs) }}</td>
              <td class="p-2.5 text-left text-muted-foreground text-[11px]">{{ when(s.lastActivity) }}</td>
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
      <div v-if="!loading && !errorMessage" class="p-3 border-t border-border bg-sidebar shrink-0 flex flex-wrap gap-3 items-center justify-between text-xs text-muted-foreground">
        <span>Showing {{ totalSessions ? startIdx + 1 : 0 }}–{{ Math.min(startIdx + pageSize, totalSessions) }} of {{ compact(totalSessions) }} sessions</span>
        <div class="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="loading || currentPage === 0" @click="currentPage = 0">First</Button>
          <Button type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="loading || currentPage === 0" @click="currentPage--">Prev</Button>
          <span class="px-1">Page {{ currentPage + 1 }} of {{ totalPages }}</span>
          <Button type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="loading || currentPage >= totalPages - 1" @click="currentPage++">Next</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import SortHeader from "./SortHeader.vue"
import { ref, computed, watch, onUnmounted } from "vue"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { AnalyticsSession } from "./types"
import type { SessionStatus } from "@/lib/types"
import { json, serverUrl, token } from "@/lib/api"
import { statusLabel, statusChipClass } from "@/lib/session-status"
import { compact, usd, pct, when, durationFormat } from "./formatters"

const props = defineProps<{
  open: boolean
  selectedCount?: number
}>()

const emit = defineEmits<{
  (e: "update:open", val: boolean): void
  (e: "inspect", session: AnalyticsSession): void
  (e: "clearSelection"): void
}>()

const searchQuery = ref("")
const sortField = ref("tokensDesc")
function sortBy(key: string) {
  const direction = sortField.value === key + "Desc" ? "Asc"
    : sortField.value === key + "Asc" ? "Desc"
    : key === "title" || key === "status" ? "Asc" : "Desc"
  sortField.value = key + direction
}
const activeStatusFilter = ref<string>("")
const currentPage = ref(0)
const pageSize = 20
const pagedSessions = ref<AnalyticsSession[]>([])
const totalSessions = ref(0)
const allTotal = ref(0)
const statusBreakdown = ref<Record<string, number>>({})
const loading = ref(false)
const errorMessage = ref("")
interface SessionsPage {
  generatedAt: string
  sessions: AnalyticsSession[]
  total: number
  allTotal: number
  statusBreakdown: Record<string, number>
  page: number
  limit: number
}
let generation = 0
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let applyingPage = false

const totalPages = computed(() => Math.max(1, Math.ceil(totalSessions.value / pageSize)))
const startIdx = computed(() => currentPage.value * pageSize)

function invalidate() {
  generation++
  controller?.abort()
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

function scheduleLoad(force = false, delay = 0) {
  invalidate()
  pagedSessions.value = []
  errorMessage.value = ""
  loading.value = props.open
  if (!props.open) return
  const own = generation
  timer = setTimeout(async () => {
    timer = undefined
    controller = new AbortController()
    const query = new URLSearchParams({
      search: searchQuery.value, status: activeStatusFilter.value, sort: sortField.value,
      page: String(currentPage.value), limit: String(pageSize),
    })
    if (force) query.set("refresh", "true")
    try {
      const result = await json<SessionsPage>(`/v1/analytics/sessions?${query}`, { signal: controller.signal })
      if (own !== generation || !props.open) return
      pagedSessions.value = result.sessions
      totalSessions.value = result.total
      allTotal.value = result.allTotal
      statusBreakdown.value = result.statusBreakdown
      applyingPage = true
      currentPage.value = result.page
      applyingPage = false
    } catch (error: any) {
      if (own === generation && props.open && error?.name !== "AbortError") {
        errorMessage.value = error?.message || "Could not load sessions."
      }
    } finally {
      if (own === generation) loading.value = false
    }
  }, delay)
}

watch([searchQuery, activeStatusFilter, sortField], () => {
  currentPage.value = 0
}, { flush: "sync" })
watch([serverUrl, token], () => {
  totalSessions.value = 0
  allTotal.value = 0
  statusBreakdown.value = {}
  currentPage.value = 0
}, { flush: "sync" })
watch(
  () => [props.open, searchQuery.value, activeStatusFilter.value, sortField.value,
    currentPage.value, serverUrl.value, token.value] as const,
  (next, previous) => {
    if (applyingPage) return
    const opening = next[0] && !previous?.[0]
    const connectionChanged = !!previous && (next[5] !== previous[5] || next[6] !== previous[6])
    const searchChanged = !!previous && next[1] !== previous[1]
    scheduleLoad(opening || connectionChanged, searchChanged && !opening ? 250 : 0)
  },
  { immediate: true, flush: "sync" },
)
onUnmounted(invalidate)
</script>
