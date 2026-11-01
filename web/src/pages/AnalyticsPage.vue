<template>
  <div id="analytics-screen" class="flex-1 min-w-0 min-h-0 overflow-auto p-6 max-[760px]:p-3 [padding-inline:max(16px,calc((100%-1475px)/2))] [overflow-wrap:anywhere]" :aria-busy="busy ? 'true' : 'false'">
    <!-- Top Header -->
    <header class="a-header flex items-center gap-3 flex-wrap mb-5 max-w-[1475px] mx-auto">
      <Button id="analytics-menu" type="button" variant="ghost" size="icon" class="hidden max-[760px]:inline-flex h-9 w-9 text-muted-foreground hover:text-foreground" aria-label="Open navigation" aria-controls="side" @click="setDrawer(true)">
        <Menu :size="18" />
      </Button>
      <div class="flex-1 a-heading">
        <div class="eyebrow text-xs uppercase tracking-wider text-muted-foreground">Workspace / Usage</div>
        <h1 tabindex="-1" class="m-0 text-[22px] font-semibold tracking-tight leading-[1.3]">Analytics</h1>
        <p class="m-0 text-xs text-muted-foreground">Model usage, token consumption, and recorded cost.</p>
      </div>
      <div class="a-header-actions flex items-center gap-3 ml-auto">
        <span class="text-muted-foreground text-xs" role="status">{{ updatedText }}</span>
        <Button type="button" variant="outline" size="sm" :disabled="refreshing" @click="load(true)">
          <RefreshCw :size="14" :class="{ 'animate-spin': refreshing }" aria-hidden="true" />
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </Button>
      </div>
      <button type="button" class="a-close icon-button" aria-label="Close analytics" @click="navigate('chat')"><X :size="18" /></button>
    </header>

    <!-- Controls Row -->
    <div class="flex items-end gap-3 flex-wrap pb-4 max-w-[1475px] mx-auto border-b border-border/60">
      <label class="grid gap-1 text-xs text-muted-foreground min-w-0 w-full max-w-[320px]">
        Token usage by model
        <select
          v-model="selected"
          aria-label="Analytics model"
          class="max-w-full w-full min-w-0 h-8 px-2.5 text-xs text-foreground bg-secondary border border-border rounded-[var(--radius)] focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All models</option>
          <option v-for="m in snapshot?.models || []" :key="m.key" :value="m.key">
            {{ m.model }} · {{ m.provider }}
          </option>
        </select>
      </label>
      <p class="text-xs text-muted-foreground m-0">Model selection applies to token totals and charts. Other cards show workspace totals.</p>
    </div>

    <p v-if="statusText" class="a-status max-w-[1475px] mx-auto my-3 text-xs" :class="{ 'text-destructive font-medium': statusIsError, 'text-muted-foreground': !statusIsError }" role="status" aria-live="polite">
      {{ statusText }}
    </p>

    <!-- Bento Matrix Content -->
    <div data-analytics-content class="max-w-[1475px] mx-auto">
      <template v-if="snapshot">
        <!-- 4 Top KPI Cards -->
        <div class="a-kpis grid gap-3 my-3 mb-5">
          <div class="border border-border rounded-[var(--radius)] p-4 bg-card a-kpi">
            <span class="eyebrow text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Total tokens</span>
            <strong class="block text-[26px] font-semibold leading-tight tracking-tight tabular-nums a-value" :title="full(activeUsage.totalTokens)">
              {{ compact(activeUsage.totalTokens) }}
            </strong>
            <small class="text-muted-foreground text-xs block mt-1">
              {{ activeSelectedModel ? full(activeSelectedModel.responses) + ' responses' : full(responsesCount) + ' observed responses' }}
            </small>
          </div>

          <div class="border border-border rounded-[var(--radius)] p-4 bg-card a-kpi">
            <span class="eyebrow text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Recorded cost · USD</span>
            <strong class="block text-[26px] font-semibold leading-tight tracking-tight tabular-nums text-primary-text a-value">
              {{ usd(activeUsage.cost.total) }}
            </strong>
            <small class="text-muted-foreground text-xs block mt-1">Estimate, not an invoice</small>
          </div>

          <div class="border border-border rounded-[var(--radius)] p-4 bg-card a-kpi">
            <span class="eyebrow text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">Cache hit rate</span>
            <strong class="block text-[26px] font-semibold leading-tight tracking-tight tabular-nums a-value">
              {{ pct(activeUsage.cacheHitRate) }}
            </strong>
            <small class="text-muted-foreground text-xs block mt-1">
              {{ cacheTotal ? `${compact(activeUsage.cacheRead)} cached / ${compact(cacheTotal)} input` : 'No input tokens' }}
            </small>
          </div>

          <div class="border border-border rounded-[var(--radius)] p-4 bg-card a-kpi">
            <span class="eyebrow text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">{{ selected ? 'Model sessions' : 'Retained sessions' }}</span>
            <strong class="block text-[26px] font-semibold leading-tight tracking-tight tabular-nums a-value">
              {{ full(selected ? activeSelectedModel?.sessions : snapshot.sessions) }}
            </strong>
            <small class="text-muted-foreground text-xs block mt-1">
              {{ selected ? activeSelectedModel?.provider : `${full(snapshot.models.length)} models · includes subagents` }}
            </small>
          </div>
        </div>

        <template v-if="!snapshot.models.length">
          <p class="a-empty py-8 text-muted-foreground text-sm">No model usage recorded yet. Usage will appear after a model response.</p>
        </template>
        <template v-else>
          <!-- 12-Column Responsive Bento Grid -->
          <div class="a-grid grid gap-4 mb-6">
            <!-- TILE 1: Daily Token Activity (Col Span 8) -->
            <section class="a-timeline border border-border rounded-[var(--radius)] p-4 bg-card flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between gap-3 mb-1">
                  <h2 class="m-0 text-[15px] font-semibold">Daily Token Activity</h2>
                  <Button type="button" variant="ghost" size="sm" class="h-7 text-xs text-muted-foreground hover:text-foreground" @click="dailyValuesOpen = true">
                    Daily values table →
                  </Button>
                </div>
                <p class="text-muted-foreground text-xs mb-3">Last 30 active days · UTC · Stacked input, output, cache read and cache write</p>
              </div>

              <template v-if="!visibleTimeline.length">
                <p class="py-8 text-center text-muted-foreground text-xs">No dated response history is available.</p>
              </template>
              <template v-else>
                <div class="relative w-full overflow-x-auto" tabindex="0" aria-label="Daily token chart, scroll horizontally on small screens">
                  <svg viewBox="0 0 640 200" class="w-full min-w-[480px] h-auto block" role="img" aria-label="Daily token activity timeline">
                    <g v-for="r in [0, 0.5, 1]" :key="r">
                      <line :x1="leftMargin" :y1="topMargin + chartHeight * (1 - r)" :x2="632" :y2="topMargin + chartHeight * (1 - r)" stroke="var(--border)" stroke-dasharray="3 4" />
                      <text :x="leftMargin - 8" :y="topMargin + chartHeight * (1 - r) + 4" text-anchor="end" class="fill-muted-foreground text-[10px]">{{ compact(maxTimeline * r) }}</text>
                    </g>
                    <g v-for="(day, index) in visibleTimeline" :key="day.date">
                      <title>{{ day.date }} UTC · {{ full(day.responses) }} responses&#10;{{ fields.map(([key, label]) => `${label}: ${full(day[key] as number)}`).join('\n') }}</title>
                      <rect
                        v-for="(f, i) in fields"
                        :key="f[0]"
                        :x="leftMargin + index * timelineStep + timelineStep * 0.15"
                        :y="getRectY(day, i)"
                        :width="timelineStep * 0.7"
                        :height="getRectSize(day, i)"
                        :fill="colors[i]"
                        rx="1"
                      />
                      <text
                        v-if="index === 0 || index === visibleTimeline.length - 1 || (visibleTimeline.length > 8 && index % Math.ceil(visibleTimeline.length / 5) === 0)"
                        :x="leftMargin + index * timelineStep + timelineStep / 2"
                        y="194"
                        text-anchor="middle"
                        class="fill-muted-foreground text-[10px]"
                      >{{ day.date.slice(5) }}</text>
                    </g>
                  </svg>
                </div>

                <div class="flex gap-4 flex-wrap text-xs text-muted-foreground mt-3 pt-2 border-t border-border/60">
                  <span v-for="([_, label], i) in fields" :key="i" class="inline-flex gap-1.5 items-center">
                    <i class="w-2 h-2 inline-block rounded-[1px] shrink-0" :style="`background:${colors[i]}`" aria-hidden="true"></i>
                    {{ label }}
                  </span>
                </div>
              </template>
            </section>

            <!-- TILE 2: Token Composition & Spend (Col Span 4) -->
            <section class="a-tile border border-border rounded-[var(--radius)] p-4 bg-card flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between gap-2 mb-1">
                  <h2 class="m-0 text-[15px] font-semibold">Composition & Spend</h2>
                  <strong class="text-sm text-primary-text">{{ usd(activeUsage.cost.total) }}</strong>
                </div>
                <p class="text-muted-foreground text-xs mb-3">Input excludes cache reads/writes.</p>

                <!-- 4-segment visual gauge -->
                <div class="h-3 rounded-[1px] overflow-hidden flex bg-secondary my-3" role="img" :aria-label="fields.map(([key, label]) => `${label}: ${full(activeUsage[key] as number)}`).join(', ')">
                  <span
                    v-for="([key, label], i) in fields"
                    :key="key"
                    class="min-w-0"
                    :style="`width:${compositionSum ? (activeUsage[key] as number) / compositionSum * 100 : 0}%;background:${colors[i]}`"
                    :title="`${label}: ${full(activeUsage[key] as number)}`"
                  ></span>
                </div>

                <div class="grid gap-2 text-xs">
                  <div v-for="([key, label], i) in fields" :key="key" class="flex justify-between items-baseline">
                    <span class="text-muted-foreground flex items-center gap-1.5">
                      <i class="w-1.5 h-1.5 inline-block rounded-[1px]" :style="`background:${colors[i]}`"></i>
                      {{ label }}
                    </span>
                    <strong class="text-foreground">{{ compact(activeUsage[key] as number) }}</strong>
                  </div>
                </div>
              </div>

              <div class="mt-4 pt-3 border-t border-border/60 text-xs text-muted-foreground flex flex-col gap-1">
                <div class="flex justify-between">
                  <span>Reasoning (in output):</span>
                  <strong class="text-foreground">{{ activeUsage.reasoning == null ? "Not reported" : compact(activeUsage.reasoning) }}</strong>
                </div>
                <div class="flex justify-between">
                  <span>1h writes (in cache):</span>
                  <strong class="text-foreground">{{ activeUsage.cacheWrite1h == null ? "Not reported" : compact(activeUsage.cacheWrite1h) }}</strong>
                </div>
                <div class="mt-1 text-[11px] text-emerald-400">
                  {{ compact(activeUsage.cacheRead) }} tokens served from cache
                </div>
              </div>
            </section>

            <!-- TILE 3: Models Leaderboard (Col Span 4) -->
            <section class="a-tile border border-border rounded-[var(--radius)] p-4 bg-card flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between gap-2 mb-1">
                  <h2 class="m-0 text-[15px] font-semibold">Top Models Leaderboard</h2>
                  <Button type="button" variant="ghost" size="sm" class="h-7 text-xs text-muted-foreground hover:text-foreground" @click="modelsCatalogOpen = true">
                    View all ({{ snapshot.models.length }}) →
                  </Button>
                </div>
                <p class="text-muted-foreground text-xs mb-3">Highest token consumption models</p>

                <div class="flex flex-col gap-2.5">
                  <button
                    type="button"
                    :aria-pressed="selected === m.key"
                    v-for="m in topModels"
                    :key="m.key"
                    class="a-card-action p-2 rounded-[var(--radius)] border border-border/60 bg-secondary/30 hover:bg-accent/40 transition-colors"
                    :class="{ 'border-primary-text bg-primary/10': selected === m.key }"
                    @click="selected = (selected === m.key ? '' : m.key)"
                  >
                    <div class="flex justify-between items-center gap-3 text-xs mb-1">
                      <div class="truncate max-w-[170px]">
                        <strong class="text-foreground block truncate">{{ m.model }}</strong>
                        <span class="text-[10px] text-muted-foreground block">{{ m.provider }}</span>
                      </div>
                      <div class="text-right">
                        <div class="font-medium text-foreground">{{ compact(m.usage.totalTokens) }}</div>
                        <div class="text-[10px] text-primary-text">{{ usd(m.usage.cost.total) }}</div>
                      </div>
                    </div>
                    <div class="h-1 bg-secondary rounded-[1px] overflow-hidden">
                      <div class="h-full bg-primary-text" :style="`width:${topModelMaxTokens ? (m.usage.totalTokens / topModelMaxTokens * 100) : 0}%`"></div>
                    </div>
                  </button>
                </div>
              </div>

              <div class="mt-3 pt-2 text-[11px] text-muted-foreground text-center">
                Click any model card to isolate its usage in the token charts and totals
              </div>
            </section>

            <!-- TILE 4: Tool Health & Operations (Col Span 4) -->
            <section class="a-tile border border-border rounded-[var(--radius)] p-4 bg-card flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between gap-2 mb-1">
                  <h2 class="m-0 text-[15px] font-semibold">Tool Health & Operations</h2>
                  <Button type="button" variant="ghost" size="sm" class="h-7 text-xs text-muted-foreground hover:text-foreground" @click="toolsDetailOpen = true">
                    View all tools →
                  </Button>
                </div>
                <p class="text-muted-foreground text-xs mb-3">Most called tools and error rates</p>

                <div class="flex flex-col gap-1.5 text-xs">
                  <p v-if="!topTools.length" class="py-4 text-muted-foreground">No tool calls recorded.</p>
                  <div v-for="t in topTools" :key="t.name" class="flex justify-between items-center py-1 border-b border-border/40 last:border-0">
                    <span class="text-foreground font-medium break-all">{{ t.name }}</span>
                    <div class="flex items-center gap-2">
                      <span>{{ full(t.calls) }} calls</span>
                      <span v-if="t.errors > 0" class="text-destructive font-semibold">({{ full(t.errors) }} err)</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Content Operations Summary -->
              <div v-if="snapshot.contentActions" class="mt-4 pt-3 border-t border-border/60">
                <span class="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2 font-medium">Content Actions</span>
                <div class="grid grid-cols-4 gap-1.5 text-center">
                  <div class="bg-secondary/40 p-1.5 rounded-[var(--radius)] border border-border/40">
                    <span class="text-[10px] text-muted-foreground block">Reads</span>
                    <strong class="text-xs">{{ full(snapshot.contentActions.reads) }}</strong>
                  </div>
                  <div class="bg-secondary/40 p-1.5 rounded-[var(--radius)] border border-border/40">
                    <span class="text-[10px] text-muted-foreground block">Writes</span>
                    <strong class="text-xs">{{ full(snapshot.contentActions.writes) }}</strong>
                  </div>
                  <div class="bg-secondary/40 p-1.5 rounded-[var(--radius)] border border-border/40">
                    <span class="text-[10px] text-muted-foreground block">Edits</span>
                    <strong class="text-xs">{{ full(snapshot.contentActions.edits) }}</strong>
                  </div>
                  <div class="bg-secondary/40 p-1.5 rounded-[var(--radius)] border border-border/40">
                    <span class="text-[10px] text-muted-foreground block">Bash</span>
                    <strong class="text-xs">{{ full(snapshot.contentActions.bashes) }}</strong>
                  </div>
                </div>
              </div>
            </section>

            <!-- TILE 5: Active & Recent Sessions (Col Span 4) -->
            <section class="a-tile border border-border rounded-[var(--radius)] p-4 bg-card flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between gap-2 mb-1">
                  <h2 class="m-0 text-[15px] font-semibold">Active & Recent Sessions</h2>
                  <Button type="button" variant="ghost" size="sm" class="h-7 text-xs text-muted-foreground hover:text-foreground" @click="sessionsConsoleOpen = true">
                    Open console ({{ full(snapshot.sessions) }}) →
                  </Button>
                </div>
                <p class="text-muted-foreground text-xs mb-3">Live status and activity</p>

                <div class="flex flex-col gap-2">
                  <p v-if="!recentSessions.length" class="py-4 text-xs text-muted-foreground">No recent sessions.</p>
                  <button
                    type="button"
                    v-for="s in recentSessions"
                    :key="s.id"
                    class="a-card-action p-2 rounded-[var(--radius)] border border-border/60 bg-secondary/30 hover:bg-accent/40 transition-colors"
                    @click="inspectSession(s)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <strong class="text-xs text-foreground truncate max-w-[160px]">{{ s.title || 'Untitled Session' }}</strong>
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded-full border text-[9px] font-medium" :class="statusChipClass(s.status)">
                        {{ statusLabel(s.status) }}
                      </span>
                    </div>
                    <div class="flex justify-between items-center text-[10px] text-muted-foreground mt-1">
                      <span>#{{ s.id }} · {{ compact(s.usage.totalTokens) }} tokens</span>
                      <span>{{ when(s.lastActivity) }}</span>
                    </div>
                  </button>
                </div>
              </div>

              <div class="mt-3 pt-2 text-[11px] text-muted-foreground text-center">
                Click any session to open turn ratios, durations, and tool errors
              </div>
            </section>

            <!-- TILE 6: Projects, Workers & Reliability (Col Span 12) -->
            <section class="a-footprint border border-border rounded-[var(--radius)] p-4 bg-card">
              <div class="flex items-center justify-between gap-3 mb-3">
                <div>
                  <h2 class="m-0 text-[15px] font-semibold">System Footprint & Projects</h2>
                  <p class="text-muted-foreground text-xs">Cross-project resource allocation and worker execution targets</p>
                </div>
              </div>

              <div class="a-system grid gap-4">
                <!-- Projects Column -->
                <div class="border border-border/60 rounded-[var(--radius)] p-3 bg-secondary/20">
                  <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Projects ({{ snapshot.projects?.length || 0 }})</span>
                  <div class="space-y-1.5 text-xs">
                    <div v-for="p in snapshot.projects || []" :key="p.id" class="flex justify-between items-center py-1 border-b border-border/40 last:border-0">
                      <div>
                        <strong class="text-foreground">{{ p.name }}</strong>
                        <span class="text-muted-foreground text-[10px] ml-1">#{{ p.id }}</span>
                      </div>
                      <div class="text-right">
                        <span class="text-foreground">{{ compact(p.usage.totalTokens) }}</span>
                        <span class="text-primary-text text-[10px] ml-1.5">{{ usd(p.usage.cost?.total) }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Workers Column -->
                <div class="border border-border/60 rounded-[var(--radius)] p-3 bg-secondary/20">
                  <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Execution Workers</span>
                  <div class="space-y-1.5 text-xs">
                    <div v-for="w in snapshot.workers || []" :key="String(w.worker)" class="flex justify-between items-center py-1 border-b border-border/40 last:border-0">
                      <strong class="text-foreground">{{ w.label }}</strong>
                      <div class="text-right">
                        <span class="text-muted-foreground">{{ full(w.sessions) }} sess</span>
                        <span class="text-primary-text text-[10px] ml-1.5">{{ usd(w.usage.cost?.total) }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Reliability Column -->
                <div class="border border-border/60 rounded-[var(--radius)] p-3 bg-secondary/20">
                  <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground block mb-2">Reliability Summary</span>
                  <div class="space-y-1.5 text-xs">
                    <div v-for="r in (snapshot.reliability?.byModel || []).slice(0, 4)" :key="r.key" class="flex justify-between items-center py-1 border-b border-border/40 last:border-0">
                      <span class="text-foreground truncate max-w-[140px]">{{ r.model }}</span>
                      <div class="text-right text-[11px]">
                        <span :class="r.errors > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'">{{ full(r.errors) }} err</span>
                        <span v-if="r.aborted > 0" class="text-amber-400 ml-1.5">({{ full(r.aborted) }} abort)</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- Bottom Reference Notes -->
          <details class="text-muted-foreground text-xs border-t border-border pt-4 pb-2 a-notes">
            <summary class="cursor-pointer text-foreground min-h-[32px] font-medium">How to read these numbers</summary>
            <p class="my-2">{{ snapshot.scope }}</p>
            <ul class="list-disc pl-4 space-y-1 my-2">
              <li v-for="(note, i) in snapshot.notes" :key="i">{{ note }}</li>
            </ul>
            <p class="my-2">Cache hit rate = cache read ÷ (uncached input + cache read + cache write).</p>
          </details>
        </template>
      </template>
    </div>

    <!-- Modal Dialogs -->
    <DailyValuesDialog
      v-if="snapshot"
      v-model:open="dailyValuesOpen"
      :items="visibleTimeline"
    />

    <ModelsCatalogDialog
      v-if="snapshot"
      v-model:open="modelsCatalogOpen"
      :models="snapshot.models"
      :selected-key="selected"
      @select="onSelectModel"
    />

    <ToolsDetailDialog
      v-if="snapshot"
      v-model:open="toolsDetailOpen"
      :tools="snapshot.toolsDetailed || []"
    />

    <SessionsConsoleDialog
      v-if="snapshot"
      v-model:open="sessionsConsoleOpen"
      @inspect="inspectSession"
    />

    <SessionInspectDialog
      v-model:open="sessionInspectOpen"
      :session="inspectingSession"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from "vue"
import { Menu, X, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { ui, setDrawer, navigate } from "@/stores/app"
import { serverUrl, token } from "@/lib/api"
import { analyticsSnapshot as snapshot, loadAnalytics } from "@/stores/analytics"
import { SESSION_STATUS_LABELS } from "@/lib/session-status"
import type { SessionStatus } from "@/lib/types"

import type { DailyItem, AnalyticsSession } from "./analytics/types"
import { full, compact, usd, pct, when, COLORS, FIELDS } from "./analytics/formatters"

import DailyValuesDialog from "./analytics/DailyValuesDialog.vue"
import ModelsCatalogDialog from "./analytics/ModelsCatalogDialog.vue"
import ToolsDetailDialog from "./analytics/ToolsDetailDialog.vue"
import SessionsConsoleDialog from "./analytics/SessionsConsoleDialog.vue"
import SessionInspectDialog from "./analytics/SessionInspectDialog.vue"

const opened = ref(false)
const generation = ref(0)
const selected = ref("")
const refreshing = ref(false)
const busy = ref(false)
const statusText = ref("")
const statusIsError = ref(false)
const updatedText = ref("")

// Dialog states
const dailyValuesOpen = ref(false)
const modelsCatalogOpen = ref(false)
const toolsDetailOpen = ref(false)
const sessionsConsoleOpen = ref(false)
const sessionInspectOpen = ref(false)
const inspectingSession = ref<AnalyticsSession | null>(null)

const colors = COLORS
const fields = FIELDS.map(([k, l]) => [k, l] as [string, string])

function statusLabel(s: SessionStatus): string {
  return (SESSION_STATUS_LABELS as Record<string, string>)[s] ?? s
}

function statusChipClass(s: SessionStatus): string {
  switch (s) {
    case "running": return "border-blue-500/40 bg-blue-500/10 text-blue-400"
    case "finished": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    case "needs_approval": return "border-amber-500/40 bg-amber-500/10 text-amber-400"
    case "needs_input": return "border-purple-500/40 bg-purple-500/10 text-purple-400"
    case "limit_reached": return "border-orange-500/40 bg-orange-500/10 text-orange-400"
    case "failed": return "border-destructive/40 bg-destructive/10 text-destructive"
    default: return "border-border bg-secondary text-foreground"
  }
}

function inspectSession(session: AnalyticsSession) {
  inspectingSession.value = session
  sessionInspectOpen.value = true
}

function onSelectModel(key: string) {
  selected.value = key
  modelsCatalogOpen.value = false
}

const activeModels = computed(() => {
  if (!snapshot.value) return []
  return snapshot.value.models.filter((m) => !selected.value || m.key === selected.value)
})

const activeSelectedModel = computed(() => {
  if (!selected.value || !snapshot.value) return null
  return snapshot.value.models.find((m) => m.key === selected.value) || null
})

const activeUsage = computed(() => {
  if (!snapshot.value) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      reasoning: null,
      cacheWrite1h: null,
      cacheHitRate: null,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
  }
  if (selected.value && activeSelectedModel.value) {
    return activeSelectedModel.value.usage
  }
  return snapshot.value.totals
})

const responsesCount = computed(() => {
  return activeModels.value.reduce((n, m) => n + m.responses, 0)
})

const cacheTotal = computed(() => {
  const u = activeUsage.value
  return u.input + u.cacheRead + u.cacheWrite
})

const compositionSum = computed(() => {
  const u = activeUsage.value as any
  return fields.reduce((n, [key]) => n + (Number(u[key]) || 0), 0)
})

// Top Models Leaderboard
const topModels = computed(() => {
  if (!snapshot.value) return []
  return [...snapshot.value.models]
    .filter((m) => m.usage.totalTokens > 0)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
    .slice(0, 5)
})

const topModelMaxTokens = computed(() => {
  const list = topModels.value
  return list.length ? list[0].usage.totalTokens : 1
})

// Top Tools
const topTools = computed(() => {
  if (!snapshot.value?.toolsDetailed) return []
  return [...snapshot.value.toolsDetailed].sort((a, b) => b.calls - a.calls).slice(0, 5)
})

// Recent & Active Sessions
const recentSessions = computed(() => {
  if (!snapshot.value?.sessionsList) return []
  const list = snapshot.value.sessionsList
  return [...list]
    .sort((a, b) => new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime())
    .slice(0, 5)
})

// Timeline computation
const visibleTimeline = computed(() => {
  const days = new Map<string, DailyItem>()
  for (const model of activeModels.value) {
    for (const day of model.daily) {
      let item = days.get(day.date)
      if (!item) {
        item = { date: day.date, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        days.set(day.date, item)
      }
      item.responses += day.responses
      for (const [key] of fields) {
        item[key] += Number(day.usage[key]) || 0
      }
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30)
})

const leftMargin = 50
const topMargin = 12
const chartHeight = 160
const chartWidth = 580

const maxTimeline = computed(() => {
  const vis = visibleTimeline.value
  if (!vis.length) return 1
  return Math.max(1, ...vis.map((d) => fields.reduce((n, [key]) => n + (Number(d[key]) || 0), 0)))
})

const timelineStep = computed(() => {
  const vis = visibleTimeline.value
  if (!vis.length) return chartWidth
  return chartWidth / vis.length
})

function getRectY(day: DailyItem, fieldIndex: number) {
  let y = topMargin + chartHeight
  const max = maxTimeline.value
  const dAny = day as any
  for (let i = 0; i <= fieldIndex; i++) {
    const key = fields[i][0]
    const val = Number(dAny[key]) || 0
    const size = (val / max) * chartHeight
    y -= size
  }
  return y
}

function getRectSize(day: DailyItem, fieldIndex: number) {
  const max = maxTimeline.value
  const key = fields[fieldIndex][0]
  const val = Number((day as any)[key]) || 0
  return (val / max) * chartHeight
}

async function load(force = false) {
  if (!opened.value || refreshing.value) return
  const own = ++generation.value
  refreshing.value = true
  busy.value = true
  statusIsError.value = false
  statusText.value = snapshot.value ? "Updating usage…" : "Loading usage…"

  const loadStarted = performance.now()
  try {
    const next = await loadAnalytics(force)
    const requestFinished = performance.now()

    if (!opened.value || own !== generation.value) return
    if (selected.value && !next.models.some((m) => m.key === selected.value)) {
      selected.value = ""
    }
    updatedText.value = "Updated " + when(next.generatedAt)
    statusText.value = ""

    await nextTick()
    if (!opened.value || own !== generation.value) return
    performance.clearMeasures("analytics-request")
    performance.clearMeasures("analytics-render")
    performance.clearMeasures("analytics-request-to-render")
    performance.measure("analytics-request", { start: loadStarted, end: requestFinished })
    performance.measure("analytics-render", { start: requestFinished, end: performance.now() })
    performance.measure("analytics-request-to-render", { start: loadStarted, end: performance.now() })
  } catch (error: any) {
    if (opened.value && own === generation.value) {
      statusIsError.value = true
      statusText.value = (snapshot.value ? "Could not refresh. Showing the previous snapshot. " : "Could not load usage. ") + error.message
    }
  } finally {
    if (opened.value && own === generation.value) {
      refreshing.value = false
      busy.value = false
    }
  }
}

watch(
  () => [ui.view, serverUrl.value, token.value] as const,
  ([newView]) => {
    generation.value++
    refreshing.value = false
    updatedText.value = snapshot.value ? "Updated " + when(snapshot.value.generatedAt) : ""
    if (newView === "analytics") {
      opened.value = true
      load()
    } else {
      opened.value = false
      generation.value++
      refreshing.value = false
      busy.value = false
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  opened.value = false
  generation.value++
})
</script>

<style scoped>
/* Respond to the content width, not the window behind the sidebar. */
#analytics-screen { container-type: inline-size; }
.a-heading { min-width: 0; }
#analytics-screen :is(button, select) { font-size: 13px; }
:global(.analytics-dialog button), :global(.analytics-dialog input), :global(.analytics-dialog select) { font-size: 13px; }
:global(.analytics-dialog [data-slot="dialog-header"]) { overflow-y: auto; max-height: 50dvh; }
:global(.analytics-dialog button:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
.a-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.a-grid, .a-system { grid-template-columns: minmax(0, 1fr); }
.a-grid > section, .a-kpi, .a-system > div { min-width: 0; }
.a-grid h2 { line-height: 1.5; }
.a-grid section > div > .flex:first-child { flex-wrap: wrap; }
.a-grid section > div > .flex:first-child > button { white-space: normal; height: auto; min-height: 32px; text-align: left; }
.a-card-action { display: block; width: 100%; min-width: 0; text-align: left; cursor: pointer; }
.a-card-action:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
.a-card-action .truncate { max-width: none; min-width: 0; flex: 1; }
.a-card-action .text-right, .a-card-action span.rounded-full { flex-shrink: 0; }
.a-grid .break-all + div { flex-shrink: 0; }
.a-grid .justify-between { gap: 8px; }
.a-grid .text-\[9px\], .a-grid .text-\[10px\] { font-size: 12px; }
@container (min-width: 720px) {
  .a-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .a-timeline, .a-footprint { grid-column: 1 / -1; }
}
@container (min-width: 1120px) {
  .a-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .a-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .a-timeline { grid-column: span 2; }
  .a-system { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container (max-width: 600px) {
  .a-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; }
  #analytics-menu { grid-column: 1; grid-row: 1; }
  .a-heading { grid-column: 2; grid-row: 1; }
  .a-close { grid-column: 3; grid-row: 1; }
  .a-header-actions { grid-column: 1 / -1; justify-content: space-between; width: 100%; margin-left: 0; }
  .a-header-actions > span { min-width: 0; }
}
@container (max-width: 420px) {
  .a-kpis { grid-template-columns: minmax(0, 1fr); }
}
</style>
