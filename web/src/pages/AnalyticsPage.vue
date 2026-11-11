<template>
  <div
    id="analytics-screen"
    class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background"
    :aria-busy="loading ? 'true' : 'false'"
  >
    <!-- Top Header -->
    <header class="shrink-0 flex items-center gap-3 flex-wrap px-6 py-3 max-[760px]:px-3 border-b border-border/60 bg-background">
      <Button
        id="analytics-menu"
        type="button"
        variant="ghost"
        size="icon"
        class="hidden max-[760px]:inline-flex h-9 w-9 text-muted-foreground hover:text-foreground"
        aria-label="Open navigation"
        aria-controls="side"
        @click="setDrawer(true)"
      >
        <Menu :size="18" />
      </Button>
      <div class="flex-1 min-w-0">
        <h1 tabindex="-1" class="m-0 text-lg font-semibold tracking-tight leading-tight">Analytics</h1>
        <p class="m-0 text-xs text-muted-foreground truncate">
          {{ queryResult ? `Updated ${when(queryResult.generatedAt)} · ${queryResult.performance.queryMs.toFixed(0)}ms` : "Workspace telemetry and usage" }}
        </p>
      </div>
      <div class="flex items-center gap-2 ml-auto flex-wrap">
        <Button type="button" variant="outline" size="sm" :disabled="exporting || loading" @click="exportAnalytics('csv')">
          <Download :size="14" aria-hidden="true" />
          Table CSV
        </Button>
        <Button type="button" variant="outline" size="sm" :disabled="exporting || loading" @click="exportAnalytics('json')">
          <Download :size="14" aria-hidden="true" />
          Table JSON
        </Button>
        <Button type="button" variant="outline" size="sm" :disabled="loading" @click="fetchAnalyticsQuery()">
          <RefreshCw :size="14" :class="{ 'animate-spin': loading }" aria-hidden="true" />
          {{ loading ? "Refreshing…" : "Refresh" }}
        </Button>
        <button
          type="button"
          class="icon-button p-1.5 rounded-[var(--radius)] text-muted-foreground hover:text-foreground hover:bg-secondary"
          aria-label="Close analytics"
          @click="navigate('chat')"
        >
          <X :size="18" />
        </button>
      </div>
    </header>

    <!-- Sticky Tabs + Compact Global Filters -->
    <div class="shrink-0 sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
      <!-- 10 Sub-tabs -->
      <nav
        aria-label="Analytics sections"
        class="flex items-center gap-1 px-6 max-[760px]:px-3 overflow-x-auto no-scrollbar border-b border-border/50"
      >
        <button
          v-for="tab in ANALYTICS_TABS"
          :key="tab"
          type="button"
          class="px-3 py-2 text-xs font-medium capitalize whitespace-nowrap border-b-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          :aria-current="activeTab === tab ? 'page' : undefined"
          @click="selectTab(tab)"
        >
          {{ tab }}
        </button>
      </nav>

      <!-- Compact Filter Bar -->
      <div class="flex items-center gap-2 flex-wrap px-6 py-2 max-[760px]:px-3 text-xs">
        <!-- Time Range Preset -->
        <select
          :value="rangePreset"
          aria-label="Time range"
          class="h-8 px-2 bg-secondary border border-border rounded-[var(--radius)] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          @change="onPresetChange(($event.target as HTMLSelectElement).value)"
        >
          <option value="all">All time</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7d</option>
          <option value="30d">Last 30d</option>
          <option value="custom">Custom</option>
        </select>

        <!-- Custom From/To -->
        <template v-if="rangePreset === 'custom'">
          <input
            type="datetime-local"
            aria-label="From date"
            :value="toLocalInput(filters.from)"
            class="h-8 px-2 bg-secondary border border-border rounded-[var(--radius)] text-foreground"
            @change="onCustomDate('from', ($event.target as HTMLInputElement).value)"
          />
          <input
            type="datetime-local"
            aria-label="To date"
            :value="toLocalInput(filters.to)"
            class="h-8 px-2 bg-secondary border border-border rounded-[var(--radius)] text-foreground"
            @change="onCustomDate('to', ($event.target as HTMLInputElement).value)"
          />
        </template>

        <!-- Search -->
        <input
          v-model="searchDraft"
          type="search"
          aria-label="Search analytics"
          placeholder="Search…"
          class="h-8 px-2.5 w-40 max-[760px]:w-full bg-secondary border border-border rounded-[var(--radius)] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          @keydown.enter="applySearch"
          @blur="applySearch"
        />

        <!-- Multi-select Popovers -->
        <Popover v-for="fac in multiFacets" :key="fac.key">
          <PopoverTrigger as-child>
            <button
              type="button"
              class="h-8 px-2.5 inline-flex items-center gap-1.5 border border-border rounded-[var(--radius)] bg-secondary text-foreground hover:bg-secondary/80"
            >
              <span>{{ fac.label }}</span>
              <span
                v-if="fac.selected.length > 0"
                class="px-1.5 py-0.2 rounded-full bg-primary/20 text-primary text-[11px] tabular-nums"
              >
                {{ fac.selected.length }}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent class="w-64 p-2 space-y-2" align="start">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-foreground">{{ fac.label }}</span>
              <button
                v-if="fac.selected.length > 0"
                type="button"
                class="text-muted-foreground hover:text-foreground"
                @click="clearFacet(fac.key)"
              >
                Clear
              </button>
            </div>
            <select
              multiple
              :aria-label="`Filter by ${fac.label}`"
              class="w-full h-36 p-1 bg-background border border-border rounded-[var(--radius)] text-xs text-foreground"
              @change="onMultiSelectChange(fac.key, $event)"
            >
              <option
                v-for="opt in fac.options"
                :key="opt.value"
                :value="opt.value"
                :selected="fac.selected.includes(opt.value)"
              >
                {{ opt.label }}
              </option>
            </select>
          </PopoverContent>
        </Popover>

        <!-- Tools source selector -->
        <select
          :value="filters.source || ''"
          aria-label="Tools source"
          class="h-8 px-2 bg-secondary border border-border rounded-[var(--radius)] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          @change="onSourceChange(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Tools: All</option>
          <option value="direct">Tools: Direct</option>
          <option value="codemode">Tools: Codemode</option>
        </select>

        <!-- Include deleted (default on) -->
        <label class="inline-flex items-center gap-1.5 text-muted-foreground cursor-pointer select-none px-1">
          <input
            type="checkbox"
            :checked="filters.includeDeleted"
            class="rounded border-border"
            @change="onToggleIncludeDeleted(($event.target as HTMLInputElement).checked)"
          />
          <span>Include deleted</span>
        </label>

        <!-- Compare finite windows -->
        <label
          class="inline-flex items-center gap-1.5 select-none px-1"
          :class="hasFiniteWindow ? 'text-muted-foreground cursor-pointer' : 'text-muted-foreground/40 cursor-not-allowed'"
          :title="hasFiniteWindow ? 'Compare with previous equal window' : 'Select a finite time range to compare'"
        >
          <input
            type="checkbox"
            :checked="filters.compare"
            :disabled="!hasFiniteWindow"
            class="rounded border-border"
            @change="onToggleCompare(($event.target as HTMLInputElement).checked)"
          />
          <span>Compare</span>
        </label>

        <button
          v-if="hasActiveFilters"
          type="button"
          class="ml-auto text-muted-foreground hover:text-foreground underline"
          @click="resetFilters"
        >
          Reset
        </button>
      </div>
    </div>

    <!-- Scrollable Body -->
    <main class="flex-1 min-h-0 overflow-y-auto p-6 max-[760px]:p-3 space-y-5">
      <!-- Error State -->
      <div
        v-if="error"
        role="alert"
        class="p-4 border border-destructive/40 rounded-[var(--radius)] bg-destructive/10 text-destructive flex items-center justify-between gap-3 text-xs"
      >
        <span>{{ error }}</span>
        <Button type="button" variant="outline" size="sm" @click="fetchAnalyticsQuery()">Retry</Button>
      </div>

      <!-- Loading Skeleton -->
      <div v-else-if="loading && !queryResult" class="grid gap-3 grid-cols-2 sm:grid-cols-4" role="status" aria-label="Loading analytics">
        <div v-for="i in 4" :key="i" class="h-24 border border-border rounded-[var(--radius)] bg-card animate-pulse" />
      </div>

      <!-- Data View -->
      <template v-else-if="queryResult">
        <!-- Notes -->
        <div
          v-if="queryResult.notes.length > 0"
          class="p-3 border border-border rounded-[var(--radius)] bg-secondary/30 text-xs text-muted-foreground space-y-1"
        >
          <p v-for="(note, i) in queryResult.notes" :key="i" class="m-0">{{ note }}</p>
        </div>

        <!-- Generic Summary Cards -->
        <div v-if="summaryEntries.length > 0" class="grid gap-3 grid-cols-2 sm:grid-cols-3">
          <div
            v-for="[k, val] in summaryEntries"
            :key="k"
            class="border border-border rounded-[var(--radius)] p-3.5 bg-card"
          >
            <span class="text-[11px] uppercase tracking-wider text-muted-foreground block mb-1">{{ formatKey(k) }}</span>
            <strong class="block text-xl font-semibold tabular-nums tracking-tight text-foreground">
              {{ formatSummaryVal(k, val) }}
            </strong>
            <small
              v-if="queryResult.previous && queryResult.previous[k] != null && typeof val === 'number' && typeof queryResult.previous[k] === 'number'"
              class="text-[11px] text-muted-foreground block mt-1 tabular-nums"
            >
              Prev: {{ formatSummaryVal(k, queryResult.previous[k]) }} · Δ {{ comparisonDelta(val, queryResult.previous[k]) }}
            </small>
          </div>
        </div>

        <!-- Simple Accessible Inline SVG Series -->
        <section
          v-for="(s, sIdx) in queryResult.series"
          :key="sIdx"
          class="border border-border rounded-[var(--radius)] p-4 bg-card space-y-2"
        >
          <div class="flex items-center justify-between text-xs">
            <h2 class="m-0 font-medium text-foreground">{{ s.name }}</h2>
            <span class="text-muted-foreground tabular-nums">{{ s.points.length }} points</span>
          </div>
          <div v-if="s.points.length === 0" class="text-xs text-muted-foreground py-4 text-center">
            No series data.
          </div>
          <svg
            v-else
            viewBox="0 0 600 120"
            preserveAspectRatio="none"
            class="w-full h-28 overflow-visible"
            role="img"
            :aria-label="`${s.name} trend chart`"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              class="text-primary"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
              :points="seriesPolyline(s.points)"
            />
          </svg>
          <div v-if="s.points.length" class="flex justify-between gap-4 text-[10px] text-muted-foreground tabular-nums">
            <span>{{ s.points[0]?.x }} UTC</span>
            <span>{{ s.points[s.points.length - 1]?.x }} UTC</span>
          </div>
        </section>

        <!-- Sortable Paginated Table / Mobile Cards -->
        <AnalyticsTable
          :columns="queryResult.table.columns"
          :rows="queryResult.table.rows"
          :total="queryResult.table.total"
          :page="queryResult.table.page"
          :limit="queryResult.table.limit"
          :sort="filters.sort"
          :loading="loading"
          @sort="onSort"
          @page="onPage"
          @select="onSelectRow"
        />

        <!-- Optional Supplemental Sections -->
        <section
          v-for="(sec, secIdx) in optionalSections"
          :key="secIdx"
          class="space-y-2"
        >
          <h2 class="m-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ sec.title }}
          </h2>
          <AnalyticsTable
            :columns="sec.table.columns"
            :rows="sec.table.rows"
            :total="sec.table.total"
            :page="sec.table.page"
            :limit="sec.table.limit"
            :loading="loading"
            :sortable="false"
            @select="onSelectRow"
          />
        </section>
      </template>
    </main>

    <!-- Detail Drawer -->
    <AnalyticsDrawer
      :open="!!openTarget"
      :detail="detailResult"
      :loading="detailLoading"
      :error="detailError"
      @close="closeDrawer"
      @retry="retryDrawer"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, Menu, RefreshCw, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { watchFeed, type Feed } from "@/lib/sync";
import { navigate, setDrawer } from "@/stores/app";
import type { AnalyticsRow, AnalyticsTab, AnalyticsValue } from "../../../src/analytics/types";
import AnalyticsTable, { type AnalyticsColumn } from "./analytics/AnalyticsTable.vue";
import AnalyticsDrawer from "./analytics/AnalyticsDrawer.vue";
import { compact, durationFormat, pct, usd, when } from "./analytics/formatters";
import {
  ANALYTICS_TABS,
  buildAnalyticsHash,
  defaultAnalyticsFilters,
  parseAnalyticsHash,
} from "./analytics/url-state";
import {
  activeTab,
  cancelScheduledAnalyticsRefresh,
  clearAnalyticsDetail,
  detailError,
  detailLoading,
  detailResult,
  error,
  exportAnalytics,
  exporting,
  fetchAnalyticsDetail,
  fetchAnalyticsFilterOptions,
  fetchAnalyticsQuery,
  filterOptions,
  filters,
  loading,
  openTarget,
  queryResult,
  scheduleAnalyticsRefresh,
} from "@/stores/analytics";

const rangePreset = ref<"all" | "24h" | "7d" | "30d" | "custom">("all");
const searchDraft = ref("");
let feed: Feed | null = null;
let syncingFromHash = false;

const hasFiniteWindow = computed(() => filters.value.from != null && filters.value.to != null);
const hasActiveFilters = computed(() => {
  const f = filters.value;
  return (
    f.from != null ||
    f.to != null ||
    f.project.length > 0 ||
    f.model.length > 0 ||
    f.provider.length > 0 ||
    f.worker.length > 0 ||
    f.cwd.length > 0 ||
    !f.includeDeleted ||
    f.compare ||
    !!f.search ||
    !!f.source
  );
});

const summaryEntries = computed(() => {
  if (!queryResult.value) return [];
  const keys: Record<AnalyticsTab, string[]> = {
    overview: ["sessions", "totalTokens", "cost", "responses", "cacheHitRate", "errorRate"],
    models: ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "cacheHitRate", "cost"],
    tools: ["sessions", "toolCalls", "errors", "errorRate"],
    sessions: ["sessions", "responses", "totalTokens", "cost"],
    delegation: ["sessions", "totalTokens", "cost"],
    reliability: ["responses", "toolCalls", "errors", "errorRate"],
    speed: ["responses", "avgDurationMs", "outputTokens", "sessions"],
    context: ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "cacheHitRate", "totalTokens"],
    workflow: ["sessions", "toolCalls", "errors"],
    projects: ["sessions", "totalTokens", "cost"],
  };
  return keys[activeTab.value].map(key => [key, queryResult.value!.summary[key] ?? null] as [string, AnalyticsValue]);
});

interface AnalyticsSection {
  title: string;
  table: {
    columns: AnalyticsColumn[];
    rows: AnalyticsRow[];
    total: number;
    page: number;
    limit: number;
  };
}

const optionalSections = computed<AnalyticsSection[]>(() => {
  const qr = queryResult.value as (typeof queryResult.value & { sections?: AnalyticsSection[] }) | null;
  return Array.isArray(qr?.sections) ? qr.sections : [];
});

type FacetKey = "project" | "model" | "provider" | "worker" | "cwd";
const multiFacets = computed(() => {
  const opts = filterOptions.value;
  return [
    {
      key: "project" as FacetKey,
      label: "Projects",
      options: opts?.projects || [],
      selected: filters.value.project.map(String),
    },
    {
      key: "model" as FacetKey,
      label: "Models",
      options: opts?.models || [],
      selected: filters.value.model,
    },
    {
      key: "provider" as FacetKey,
      label: "Providers",
      options: opts?.providers || [],
      selected: filters.value.provider,
    },
    {
      key: "worker" as FacetKey,
      label: "Workers",
      options: opts?.workers || [],
      selected: filters.value.worker,
    },
    {
      key: "cwd" as FacetKey,
      label: "CWDs",
      options: opts?.cwds || [],
      selected: filters.value.cwd,
    },
  ];
});

function syncHash() {
  if (syncingFromHash) return;
  const nextHash = buildAnalyticsHash(activeTab.value, filters.value, openTarget.value);
  if (window.location.hash !== nextHash) {
    window.history.pushState(null, "", nextHash);
  }
}

function applyHashState() {
  syncingFromHash = true;
  try {
    const parsed = parseAnalyticsHash(window.location.hash);
    activeTab.value = parsed.tab;
    filters.value = parsed.filters;
    searchDraft.value = parsed.filters.search;
    openTarget.value = parsed.open;

    if (parsed.filters.from != null || parsed.filters.to != null) {
      rangePreset.value = "custom";
    } else {
      rangePreset.value = "all";
    }

    void fetchAnalyticsQuery();
    if (parsed.open) {
      void fetchAnalyticsDetail(parsed.tab, parsed.open.kind, parsed.open.id);
    } else {
      clearAnalyticsDetail();
    }
  } finally {
    syncingFromHash = false;
  }
}

function selectTab(tab: AnalyticsTab) {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  filters.value = { ...filters.value, page: 0, sort: undefined };
  openTarget.value = null;
  clearAnalyticsDetail();
  syncHash();
  void fetchAnalyticsQuery();
}

function onPresetChange(val: string) {
  const now = Date.now();
  if (val === "all") {
    rangePreset.value = "all";
    filters.value = { ...filters.value, from: undefined, to: undefined, compare: false, page: 0 };
  } else if (val === "24h") {
    rangePreset.value = "24h";
    filters.value = { ...filters.value, from: now - 86400_000, to: now, page: 0 };
  } else if (val === "7d") {
    rangePreset.value = "7d";
    filters.value = { ...filters.value, from: now - 7 * 86400_000, to: now, page: 0 };
  } else if (val === "30d") {
    rangePreset.value = "30d";
    filters.value = { ...filters.value, from: now - 30 * 86400_000, to: now, page: 0 };
  } else {
    rangePreset.value = "custom";
    return;
  }
  syncHash();
  void fetchAnalyticsQuery();
}

function toLocalInput(ms?: number): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onCustomDate(field: "from" | "to", val: string) {
  const ms = val ? new Date(val).getTime() : undefined;
  const next = { ...filters.value, [field]: Number.isFinite(ms) ? ms : undefined, page: 0 };
  if (next.from == null || next.to == null) next.compare = false;
  filters.value = next;
  syncHash();
  void fetchAnalyticsQuery();
}

function applySearch() {
  if (filters.value.search === searchDraft.value) return;
  filters.value = { ...filters.value, search: searchDraft.value, page: 0 };
  syncHash();
  void fetchAnalyticsQuery();
}

function onMultiSelectChange(key: FacetKey, event: Event) {
  const select = event.target as HTMLSelectElement;
  const values = Array.from(select.selectedOptions).map((o) => o.value);
  if (key === "project") {
    filters.value = { ...filters.value, project: values.map(Number).filter(Number.isFinite), page: 0 };
  } else {
    filters.value = { ...filters.value, [key]: values, page: 0 };
  }
  syncHash();
  void fetchAnalyticsQuery();
}

function clearFacet(key: FacetKey) {
  filters.value = { ...filters.value, [key]: [], page: 0 };
  syncHash();
  void fetchAnalyticsQuery();
}

function onSourceChange(val: string) {
  const source = val === "direct" || val === "codemode" ? val : undefined;
  filters.value = { ...filters.value, source, page: 0 };
  syncHash();
  void fetchAnalyticsQuery();
}

function onToggleIncludeDeleted(checked: boolean) {
  filters.value = { ...filters.value, includeDeleted: checked, page: 0 };
  syncHash();
  void fetchAnalyticsQuery();
}

function onToggleCompare(checked: boolean) {
  if (!hasFiniteWindow.value) return;
  filters.value = { ...filters.value, compare: checked, page: 0 };
  syncHash();
  void fetchAnalyticsQuery();
}

function resetFilters() {
  rangePreset.value = "all";
  searchDraft.value = "";
  filters.value = defaultAnalyticsFilters();
  syncHash();
  void fetchAnalyticsQuery();
}

function onSort(nextSort: string) {
  filters.value = { ...filters.value, sort: nextSort, page: 0 };
  syncHash();
  void fetchAnalyticsQuery();
}

function onPage(nextPage: number) {
  filters.value = { ...filters.value, page: Math.max(0, nextPage) };
  syncHash();
  void fetchAnalyticsQuery();
}

function onSelectRow(row: AnalyticsRow) {
  if (row.id == null || row.kind == null) return;
  const target = { kind: String(row.kind), id: String(row.id) };
  openTarget.value = target;
  syncHash();
  void fetchAnalyticsDetail(activeTab.value, target.kind, target.id);
}

function closeDrawer() {
  if (!openTarget.value) return;
  openTarget.value = null;
  clearAnalyticsDetail();
  syncHash();
}

function retryDrawer() {
  if (!openTarget.value) return;
  void fetchAnalyticsDetail(activeTab.value, openTarget.value.kind, openTarget.value.id);
}

const SUMMARY_LABELS: Record<string, string> = {
  totalTokens: "Total tokens",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheReadTokens: "Cache read tokens",
  cacheWriteTokens: "Cache write tokens",
  totalCost: "Recorded cost",
  costUsd: "Recorded cost",
  cacheHitRate: "Cache hit rate",
  errorRate: "Error rate",
  abortRate: "Abort rate",
  avgDurationMs: "Avg duration",
  p50DurationMs: "p50 duration",
  p95DurationMs: "p95 duration",
  totalDurationMs: "Total duration",
  sessions: "Sessions",
  responses: "Responses",
  tools: "Tool calls",
  errors: "Errors",
  aborts: "Aborts",
  projects: "Projects",
  models: "Models",
  workers: "Workers",
  uploads: "Uploads",
  visionCalls: "Vision calls",
  compactions: "Compactions",
};

function formatKey(key: string): string {
  return SUMMARY_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
}

function formatSummaryVal(key: string, val: AnalyticsValue): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") {
    const k = key.toLowerCase();
    if (k.includes("cost") || k.includes("usd")) return usd(val);
    if (k.endsWith("ms") || k.includes("duration") || k.includes("latency")) return durationFormat(val);
    if (k.includes("rate") || k.includes("pct") || k.includes("percent")) return pct(val);
    return compact(val);
  }
  return String(val);
}

function comparisonDelta(current: AnalyticsValue, previous: AnalyticsValue): string {
  if (typeof current !== "number" || typeof previous !== "number") return "—";
  if (previous === 0) return current === 0 ? "0.0%" : "— (no baseline)";
  const delta = (current - previous) / Math.abs(previous) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function seriesPolyline(points: { x: string; y: number }[]): string {
  if (points.length === 0) return "";
  const maxY = Math.max(...points.map((p) => p.y), 1);
  const minY = Math.min(...points.map((p) => p.y), 0);
  const spanY = maxY - minY || 1;
  return points
    .map((p, i) => {
      const x = points.length === 1 ? 300 : (i / (points.length - 1)) * 600;
      const y = 110 - ((p.y - minY) / spanY) * 100;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

onMounted(() => {
  applyHashState();
  void fetchAnalyticsFilterOptions();
  window.addEventListener("hashchange", applyHashState);
  window.addEventListener("popstate", applyHashState);

  feed = watchFeed({
    path: "/v1/events",
    api,
    onEvent(type: string) {
      if (type === "analytics_changed" && document.visibilityState === "visible") {
        scheduleAnalyticsRefresh();
      }
    },
  });
});

onUnmounted(() => {
  window.removeEventListener("hashchange", applyHashState);
  window.removeEventListener("popstate", applyHashState);
  cancelScheduledAnalyticsRefresh();
  feed?.stop();
  feed = null;
});

watch(
  () => openTarget.value,
  (next, prev) => {
    if (next && (!prev || next.kind !== prev.kind || next.id !== prev.id)) {
      void fetchAnalyticsDetail(activeTab.value, next.kind, next.id);
    }
  }
);
</script>
