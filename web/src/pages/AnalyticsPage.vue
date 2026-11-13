<template>
  <div
    id="analytics-screen"
    class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-background"
    :aria-busy="loading ? 'true' : 'false'"
  >
    <!-- Header -->
    <header class="shrink-0 flex items-center gap-3 px-6 pt-3 pb-2 max-[760px]:px-3">
      <Button
        id="analytics-menu"
        type="button"
        variant="ghost"
        size="icon"
        class="hidden max-[760px]:inline-flex h-11 w-11 text-muted-foreground hover:text-foreground"
        aria-label="Open navigation"
        aria-controls="side"
        @click="setDrawer(true)"
      >
        <Menu :size="18" />
      </Button>
      <div class="flex-1 min-w-0">
        <h1 tabindex="-1" class="m-0 text-lg font-semibold tracking-tight leading-tight">Analytics</h1>
        <p class="m-0 text-xs text-muted-foreground truncate" aria-live="polite">
          <template v-if="loading">Updating…</template>
          <template v-else-if="queryResult">
            <span :title="new Date(queryResult.generatedAt).toLocaleString()">Updated {{ ago(queryResult.generatedAt) }}</span>
            <span class="max-[760px]:hidden"> · press refresh for new data</span>
          </template>
          <template v-else>Usage, cost, and reliability of your sessions</template>
        </p>
      </div>
      <div class="flex items-center gap-1.5 ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11 max-[760px]:min-w-11" :disabled="exporting || !queryResult" aria-label="Export table">
              <Download :size="14" aria-hidden="true" />
              <span class="max-[760px]:hidden">{{ exporting ? "Exporting…" : "Export" }}</span>
              <ChevronDown :size="14" aria-hidden="true" class="max-[760px]:hidden" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-64">
            <p class="px-2 py-1.5 m-0 text-[11px] text-muted-foreground">
              Every row of “{{ meta.tableTitle }}” that matches the filters, not only this page.
            </p>
            <DropdownMenuItem @select="doExport('csv')">CSV (spreadsheets)</DropdownMenuItem>
            <DropdownMenuItem @select="doExport('json')">JSON</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="outline"
          size="icon"
          class="h-8 w-8 max-[760px]:min-h-11 max-[760px]:min-w-11"
          :disabled="loading"
          aria-label="Refresh now"
          title="Refresh now"
          @click="refresh()"
        >
          <RefreshCw :size="14" :class="{ 'animate-spin': loading }" aria-hidden="true" />
        </Button>
        <button
          type="button"
          class="icon-button h-8 w-8 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          aria-label="Close analytics"
          title="Close analytics"
          @click="navigate('chat')"
        >
          <X :size="18" />
        </button>
      </div>
    </header>

    <!-- Tabs + filters stay fixed while the body scrolls -->
    <div class="shrink-0 z-10 bg-background border-b border-border">
      <!-- Desktop tabs -->
      <nav
        aria-label="Analytics sections"
        class="max-[760px]:hidden flex items-end gap-0.5 px-6 overflow-x-auto overflow-y-hidden no-scrollbar scroll-smooth border-b border-border/60"
      >
        <button
          v-for="tab in ANALYTICS_TABS"
          :key="tab"
          type="button"
          class="h-9 px-3 text-xs font-medium whitespace-nowrap border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          :class="activeTab === tab ? 'border-[var(--primary-text)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50'"
          :aria-current="activeTab === tab ? 'page' : undefined"
          :title="TAB_META[tab].question"
          @click="selectTab(tab)"
        >
          {{ TAB_META[tab].label }}
        </button>
      </nav>

      <!-- Mobile tab picker -->
      <div class="hidden max-[760px]:block px-3 pt-1">
        <label class="sr-only" for="analytics-tab-select">Section</label>
        <select
          id="analytics-tab-select"
          :value="activeTab"
          class="w-full h-10 max-[760px]:min-h-11 px-2 bg-secondary border border-border rounded-[var(--radius)] text-sm text-foreground"
          @change="selectTab(($event.target as HTMLSelectElement).value as AnalyticsTab)"
        >
          <option v-for="tab in ANALYTICS_TABS" :key="tab" :value="tab">{{ TAB_META[tab].label }}</option>
        </select>
      </div>

      <p class="m-0 px-6 max-[760px]:px-3 pt-2 text-sm text-foreground">{{ meta.question }}</p>

      <!-- Filter bar -->
      <div class="flex items-center gap-2 flex-wrap px-6 py-2 max-[760px]:px-3 text-xs" role="group" aria-label="Filters">
        <select
          :value="rangePreset"
          aria-label="Time range"
          class="h-8 max-[760px]:min-h-11 px-2 bg-secondary border rounded-[var(--radius)] text-foreground"
          :class="rangePreset === 'all' ? 'border-border' : 'border-[var(--primary-text)]/60'"
          @change="onPresetChange(($event.target as HTMLSelectElement).value as RangePreset)"
        >
          <option value="all">All time</option>
          <option v-for="p in RANGE_PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
          <option value="custom">Custom range…</option>
        </select>

        <div
          v-if="rangePreset === 'custom'"
          class="min-[761px]:contents max-[760px]:w-full max-[760px]:flex max-[760px]:flex-col max-[760px]:gap-2"
        >
          <label class="inline-flex items-center gap-1 text-muted-foreground max-[760px]:w-full max-[760px]:justify-between">
            From
            <input
              type="datetime-local"
              :value="toLocalInput(filters.from)"
              class="h-8 max-[760px]:min-h-11 max-[760px]:w-full px-2 bg-secondary border border-border rounded-[var(--radius)] text-foreground"
              @change="onCustomDate('from', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="inline-flex items-center gap-1 text-muted-foreground max-[760px]:w-full max-[760px]:justify-between">
            to
            <input
              type="datetime-local"
              :value="toLocalInput(filters.to)"
              class="h-8 max-[760px]:min-h-11 max-[760px]:w-full px-2 bg-secondary border border-border rounded-[var(--radius)] text-foreground"
              @change="onCustomDate('to', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>

        <button
          type="button"
          class="hidden max-[760px]:inline-flex h-8 max-[760px]:min-h-11 px-2.5 items-center gap-1.5 border rounded-[var(--radius)] bg-secondary text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          :class="extraFilterCount ? 'border-[var(--primary-text)]/60' : 'border-border'"
          :aria-expanded="mobileFiltersOpen ? 'true' : 'false'"
          aria-controls="analytics-more-filters"
          @click="mobileFiltersOpen = !mobileFiltersOpen"
        >
          <SlidersHorizontal :size="13" aria-hidden="true" />
          Filters<span v-if="extraFilterCount" class="tabular-nums">· {{ extraFilterCount }}</span>
          <ChevronDown :size="13" class="text-muted-foreground transition-transform" :class="{ 'rotate-180': mobileFiltersOpen }" aria-hidden="true" />
        </button>
        <div
          id="analytics-more-filters"
          :class="mobileFiltersOpen ? 'min-[761px]:contents max-[760px]:w-full max-[760px]:flex max-[760px]:flex-wrap max-[760px]:gap-2' : 'contents max-[760px]:hidden'"
        >
        <div class="relative max-[760px]:w-full">
          <Search :size="13" class="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" aria-hidden="true" />
          <input
            v-model="searchDraft"
            type="text"
            :aria-label="`Search ${meta.tableTitle.toLowerCase()}`"
            :title="`Search ${meta.tableTitle.toLowerCase()}`"
            placeholder="Search…"
            class="h-8 max-[760px]:min-h-11 pl-7 pr-7 w-52 max-[760px]:w-full bg-secondary border border-border rounded-[var(--radius)] text-foreground placeholder:text-muted-foreground"
            @keydown.enter="applySearch"
            @keydown.esc="clearSearch"
          />
          <button
            v-if="searchDraft"
            type="button"
            class="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 max-[760px]:min-h-11 max-[760px]:min-w-11 inline-flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <X :size="13" />
          </button>
        </div>

        <FacetFilter
          v-for="fac in facets"
          :key="fac.key"
          :label="fac.label"
          :singular="fac.singular"
          :options="fac.options"
          :selected="fac.selected"
          @update="(v: string[]) => setFacet(fac.key, v)"
        />

        <select
          v-if="activeTab === 'tools'"
          :value="filters.source || ''"
          aria-label="Who called the tool"
          title="Direct: the model called the tool. Codemode: a codemode script called it."
          class="h-8 max-[760px]:min-h-11 px-2 bg-secondary border rounded-[var(--radius)] text-foreground"
          :class="filters.source ? 'border-[var(--primary-text)]/60' : 'border-border'"
          @change="onSourceChange(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Called by: anyone</option>
          <option value="direct">Called by: model (direct)</option>
          <option value="codemode">Called by: codemode script</option>
        </select>

        <Popover>
          <PopoverTrigger as-child>
            <button
              type="button"
              class="h-8 max-[760px]:min-h-11 px-2.5 inline-flex items-center gap-1.5 border rounded-[var(--radius)] bg-secondary text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              :class="(!filters.includeDeleted || filters.compare) ? 'border-[var(--primary-text)]/60' : 'border-border'"
            >
              <SlidersHorizontal :size="13" aria-hidden="true" />
              Options
              <ChevronDown :size="13" class="text-muted-foreground" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent class="w-72 p-3 space-y-3 text-xs" align="start">
            <label class="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                class="mt-0.5 accent-[var(--primary)]"
                :checked="filters.includeDeleted"
                @change="onToggleIncludeDeleted(($event.target as HTMLInputElement).checked)"
              />
              <span>
                <span class="block text-foreground">Include deleted sessions</span>
                <span class="block text-muted-foreground">Count usage from sessions you deleted. On by default, so totals match what you spent.</span>
              </span>
            </label>
            <label class="flex items-start gap-2" :class="hasFiniteWindow ? 'cursor-pointer' : 'cursor-not-allowed'">
              <input
                type="checkbox"
                class="mt-0.5 accent-[var(--primary)]"
                :checked="filters.compare"
                :disabled="!hasFiniteWindow"
                @change="onToggleCompare(($event.target as HTMLInputElement).checked)"
              />
              <span>
                <span class="block" :class="hasFiniteWindow ? 'text-foreground' : 'text-muted-foreground'">Compare with the previous period</span>
                <span class="block text-muted-foreground">
                  {{ hasFiniteWindow ? `Shows the change against the ${spanLabel(filters.to! - filters.from!)} before this range.` : "Choose a time range other than All time to compare." }}
                </span>
              </span>
            </label>
          </PopoverContent>
        </Popover>
        </div>
      </div>

      <!-- Active filters: real state, each removable -->
      <div
        v-if="activeChips.length > 0"
        class="flex items-center gap-1.5 flex-wrap px-6 max-[760px]:px-3 pb-2 text-xs"
        aria-label="Active filters"
      >
        <span class="text-muted-foreground mr-0.5">Showing only:</span>
        <span
          v-for="chip in activeChips"
          :key="chip.id"
          class="inline-flex items-center gap-1 h-7 pl-2 pr-0.5 border border-border bg-secondary rounded-[var(--radius)] text-foreground max-w-[280px]"
        >
          <span class="truncate" :title="chip.label">{{ chip.label }}</span>
          <button
            type="button"
            class="h-6 w-6 max-[760px]:min-h-11 max-[760px]:min-w-11 shrink-0 inline-flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            :aria-label="`Remove filter ${chip.label}`"
            @click="chip.remove()"
          >
            <X :size="12" />
          </button>
        </span>
        <button type="button" class="h-7 max-[760px]:min-h-11 px-2 text-muted-foreground hover:text-foreground underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" @click="resetFilters">
          Clear all
        </button>
      </div>
    </div>

    <!-- Body -->
    <main ref="body" class="flex-1 min-h-0 overflow-y-auto px-6 py-5 pb-8 max-[760px]:px-3 max-[760px]:py-3 max-[760px]:pb-8 space-y-5">
      <div
        v-if="error"
        role="alert"
        class="p-3 border border-destructive/40 rounded-[var(--radius)] bg-destructive/10 text-destructive flex items-center justify-between gap-3 text-xs"
      >
        <span>Could not load analytics: {{ error }}</span>
        <Button type="button" variant="outline" size="sm" class="max-[760px]:min-h-11" @click="fetchAnalyticsQuery()">Retry</Button>
      </div>
      <div
        v-if="exportError"
        role="alert"
        class="p-3 border border-destructive/40 rounded-[var(--radius)] bg-destructive/10 text-destructive flex items-center justify-between gap-3 text-xs"
      >
        <span>Export failed: {{ exportError }}</span>
        <button type="button" class="px-2 py-1 max-[760px]:min-h-11 underline rounded-[var(--radius)] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" @click="exportError = null">Dismiss</button>
      </div>

      <div v-if="!current && !error" class="space-y-4" role="status" aria-label="Loading analytics">
        <div class="grid gap-3 grid-cols-2 sm:grid-cols-3">
          <div v-for="i in 6" :key="i" class="h-20 border border-border rounded-[var(--radius)] bg-card animate-pulse" />
        </div>
        <div class="h-52 border border-border rounded-[var(--radius)] bg-card animate-pulse" />
      </div>

      <template v-else-if="current">
        <!-- Headline numbers -->
        <section v-if="kpis.length" aria-label="Headline numbers" class="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <div
            v-for="k in kpis"
            :key="k.key"
            class="flex flex-col justify-between border border-border rounded-[var(--radius)] px-3.5 py-3 bg-card min-w-0"
          >
            <div class="flex items-start justify-between gap-1.5 min-h-[1.75rem] text-[11px] text-muted-foreground">
              <span class="line-clamp-2 leading-snug">{{ k.label }}</span>
              <Popover v-if="k.help">
                <PopoverTrigger as-child>
                  <button
                    type="button"
                    class="-mr-1 -mt-0.5 min-h-6 min-w-6 h-6 w-6 max-[760px]:min-h-11 max-[760px]:min-w-11 max-[760px]:-my-2.5 shrink-0 inline-flex items-center justify-center rounded-full hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    :aria-label="`What is ${k.label}?`"
                  >
                    <Info :size="12" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent class="w-64 p-3 text-xs text-foreground" side="top">{{ k.help }}</PopoverContent>
              </Popover>
            </div>
            <div class="mt-auto pt-1">
              <strong class="block text-xl font-semibold tabular-nums tracking-tight text-foreground" :title="k.full">{{ k.value }}</strong>
              <span v-if="k.delta" class="mt-0.5 flex items-center gap-1 text-[11px] tabular-nums" :class="k.delta.tone">
                <component :is="k.delta.icon" :size="12" aria-hidden="true" />
                <span>{{ k.delta.text }}</span>
                <span class="text-muted-foreground">vs {{ k.delta.prev }}</span>
              </span>
            </div>
          </div>
        </section>

        <!-- Trends -->
        <section v-if="current.series.length" aria-label="Trends" class="grid gap-3" :class="current.series.length > 1 ? 'xl:grid-cols-2' : ''">
          <TrendChart
            v-for="s in current.series"
            :key="s.name"
            :name="seriesTitle(s.name)"
            :points="s.points"
            :unit="seriesKind(s.name).unit"
            :aggregate="seriesKind(s.name).aggregate"
            :from="filters.from"
            :to="filters.to"
            @zoom="onZoom"
          />
        </section>

        <!-- Main table -->
        <section :aria-labelledby="'analytics-main-table'" class="space-y-2">
          <div class="flex items-end justify-between gap-3 flex-wrap">
            <div class="min-w-0">
              <h2 id="analytics-main-table" class="m-0 text-sm font-semibold text-foreground flex items-center gap-2">
                <span>{{ meta.tableTitle }}</span>
                <span class="px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground bg-secondary rounded-[var(--radius)] tabular-nums">{{ current.table.total.toLocaleString() }}</span>
              </h2>
              <p class="m-0 mt-0.5 text-xs text-muted-foreground">{{ meta.tableHint }}</p>
            </div>
            <button
              v-if="activeTab === 'overview'"
              type="button"
              class="text-xs text-[var(--primary-text)] hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              @click="selectTab('sessions')"
            >
              All sessions
            </button>
          </div>
          <AnalyticsTable
            :columns="current.table.columns"
            :rows="current.table.rows"
            :total="current.table.total"
            :page="current.table.page"
            :limit="current.table.limit"
            :sort="filters.sort"
            :default-sort="meta.defaultSort"
            :loading="loading"
            :empty-hint="emptyHint"
            @sort="onSort"
            @page="onPage"
            @limit="onLimit"
            @select="onSelectRow"
          />
        </section>

        <!-- Extra tables -->
        <section v-for="sec in optionalSections" :key="sec.title" class="space-y-2">
          <div>
            <h2 class="m-0 text-sm font-semibold text-foreground">{{ SECTION_META[sec.title]?.title ?? sec.title }}</h2>
            <p v-if="SECTION_META[sec.title]" class="m-0 mt-0.5 text-xs text-muted-foreground">{{ SECTION_META[sec.title]!.hint }}</p>
          </div>
          <AnalyticsTable
            :columns="sec.table.columns"
            :rows="sec.table.rows"
            :total="sec.table.total"
            :page="sec.table.page"
            :limit="sec.table.limit"
            :loading="loading"
            :sortable="false"
            :paginated="false"
            @select="onSelectRow"
          />
        </section>

        <!-- How the numbers are measured -->
        <details v-if="current.notes.length" class="group border border-border rounded-[var(--radius)] bg-card text-xs">
          <summary class="flex items-center gap-2 px-3 py-2.5 cursor-pointer text-muted-foreground hover:text-foreground list-none">
            <Info :size="14" aria-hidden="true" />
            How these numbers are measured
            <ChevronDown :size="14" class="ml-auto transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <ul class="m-0 px-3 pb-3 pl-8 space-y-1 text-muted-foreground list-disc">
            <li v-for="(note, i) in current.notes" :key="i">{{ note }}</li>
            <li>Cost is an estimate from recorded usage, not a bill.</li>
            <li>Charts count only events with a timestamp, so a chart's sum can be a little lower than the headline number.</li>
          </ul>
        </details>
      </template>
    </main>

    <AnalyticsDrawer
      :open="!!openTarget"
      :detail="detailResult"
      :loading="detailLoading"
      :error="detailError"
      @close="closeDrawer"
      @retry="retryDrawer"
      @open-session="(id: number) => void openSession(id)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ArrowDownRight, ArrowUpRight, ChevronDown, Download, Info, Menu, Minus, RefreshCw, Search, SlidersHorizontal, X,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { navigate, setDrawer } from "@/stores/app";
import { openSession } from "@/stores/chat";
import type { AnalyticsRow, AnalyticsTab, AnalyticsValue } from "../../../src/analytics/types";
import AnalyticsTable, { type AnalyticsColumn } from "./analytics/AnalyticsTable.vue";
import AnalyticsDrawer from "./analytics/AnalyticsDrawer.vue";
import FacetFilter from "./analytics/FacetFilter.vue";
import TrendChart from "./analytics/TrendChart.vue";
import { compact, durationFormat, pct, usd } from "./analytics/formatters";
import { fullNumber, machineLabel } from "./analytics/labels";
import { loadWorkers } from "@/stores/workers";
import {
  METRIC_HELP, METRIC_LABELS, RANGE_PRESETS, SECTION_META, TAB_META, seriesKind, type RangePreset,
} from "./analytics/meta";
import { ANALYTICS_TABS, buildAnalyticsHash, defaultAnalyticsFilters, parseAnalyticsHash } from "./analytics/url-state";
import {
  activeTab, clearAnalyticsDetail, detailError, detailLoading, detailResult, error,
  exportAnalytics, exporting, fetchAnalyticsDetail, fetchAnalyticsFilterOptions, fetchAnalyticsQuery, filterOptions,
  filters, loading, openTarget, queryResult,
} from "@/stores/analytics";

const rangePreset = ref<RangePreset>("all");
const mobileFiltersOpen = ref(false);
const searchDraft = ref("");
const exportError = ref<string | null>(null);
const body = ref<HTMLElement | null>(null);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let syncingFromHash = false;

const meta = computed(() => TAB_META[activeTab.value]);
/** The last result belongs to another tab while a tab switch loads; never show it under this tab's labels. */
const current = computed(() => (queryResult.value?.tab === activeTab.value ? queryResult.value : null));
const hasFiniteWindow = computed(() => filters.value.from != null && filters.value.to != null);

// ---- formatting ----
function ago(iso: string): string {
  const s = Math.max(0, Math.round((now.value - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function spanLabel(ms: number): string {
  const preset = RANGE_PRESETS.find(p => Math.abs(p.ms - ms) < 60_000);
  if (preset) return preset.label.replace(/^Last /, "");
  const h = ms / 3_600_000;
  return h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
}

function formatMetric(key: string, val: AnalyticsValue): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val !== "number") return String(val);
  if (key === "cost") return usd(val);
  if (key.endsWith("Ms")) return durationFormat(val);
  if (key.endsWith("Rate")) return pct(val);
  return compact(val);
}

function seriesTitle(name: string): string {
  const map: Record<string, string> = {
    "Cost (USD)": "Cost (estimate)",
    "Avg Response Duration (ms)": "Avg response time",
    "Tool & Skill Calls": "Tool and skill calls",
    "Errors": "Failed calls",
    "Response Errors": "Failed responses",
    "Aborted Responses": "Aborted responses",
    "Delegation Events": "Delegation events",
    "Cache Read Tokens": "Cache read tokens",
    "Wait Events": "Waits",
    "Model Switches": "Model switches",
  };
  return map[name] ?? name;
}

/** Up is good for volume; up is bad for cost, errors, and time. Neutral when unsure. */
const BAD_WHEN_UP = new Set(["cost", "errorRate", "responseErrors", "responseErrorRate", "aborts", "toolErrors", "toolErrorRate", "avgDurationMs"]);

const kpis = computed(() => {
  const qr = current.value;
  if (!qr) return [];
  return meta.value.kpis.map((key) => {
    const val: AnalyticsValue = key === "tableTotal" ? qr.table.total : (qr.summary[key] ?? null);
    const prev = key === "tableTotal" ? null : qr.previous?.[key];
    let delta: { text: string; prev: string; tone: string; icon: unknown } | null = null;
    if (typeof val === "number" && typeof prev === "number") {
      const change = prev === 0 ? (val === 0 ? 0 : null) : (val - prev) / Math.abs(prev);
      const up = val > prev, down = val < prev;
      const bad = BAD_WHEN_UP.has(key) ? up : false;
      const good = BAD_WHEN_UP.has(key) ? down : false;
      delta = {
        text: change == null ? "new" : `${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}%`,
        prev: formatMetric(key, prev),
        tone: bad ? "text-destructive" : good ? "text-[var(--ok)]" : "text-muted-foreground",
        icon: up ? ArrowUpRight : down ? ArrowDownRight : Minus,
      };
    }
    return {
      key,
      label: key === "tableTotal" ? meta.value.tableTitle : (METRIC_LABELS[key] ?? key),
      help: METRIC_HELP[key],
      value: key === "tableTotal" && typeof val === "number" ? val.toLocaleString() : formatMetric(key, val),
      full: typeof val === "number" ? fullNumber(val) : undefined,
      delta,
    };
  });
});

interface AnalyticsSection {
  title: string;
  table: { columns: AnalyticsColumn[]; rows: AnalyticsRow[]; total: number; page: number; limit: number };
}
const optionalSections = computed<AnalyticsSection[]>(() => (current.value?.sections ?? []) as AnalyticsSection[]);

// ---- facets ----
type FacetKey = "project" | "model" | "provider" | "worker" | "cwd";
const facets = computed(() => {
  const o = filterOptions.value;
  const f = filters.value;
  return [
    { key: "project" as FacetKey, label: "Projects", singular: "Project", options: o?.projects ?? [], selected: f.project.map(String) },
    { key: "model" as FacetKey, label: "Models", singular: "Model", options: o?.models ?? [], selected: f.model },
    { key: "provider" as FacetKey, label: "Providers", singular: "Provider", options: o?.providers ?? [], selected: f.provider },
    { key: "worker" as FacetKey, label: "Machines", singular: "Machine", options: (o?.workers ?? []).map(w => ({ value: w.value, label: machineLabel(w.value) })), selected: f.worker },
    { key: "cwd" as FacetKey, label: "Folders", singular: "Folder", options: o?.cwds ?? [], selected: f.cwd },
  ];
});

function optionLabel(key: FacetKey, value: string): string {
  return facets.value.find(f => f.key === key)?.options.find(o => o.value === value)?.label ?? value;
}

function shortRange(from?: number, to?: number): string {
  const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (from != null && to != null) return `${fmt(from)} – ${fmt(to)}`;
  if (from != null) return `Since ${fmt(from)}`;
  return `Until ${fmt(to!)}`;
}

const activeChips = computed(() => {
  const f = filters.value;
  const chips: { id: string; label: string; remove: () => void }[] = [];
  if (f.from != null || f.to != null) {
    const preset = RANGE_PRESETS.find(p => p.value === rangePreset.value);
    chips.push({ id: "range", label: preset ? preset.label : shortRange(f.from, f.to), remove: () => onPresetChange("all") });
  }
  if (f.search) chips.push({ id: "search", label: `Search: “${f.search}”`, remove: clearSearch });
  for (const fac of facets.value) {
    for (const v of fac.selected) {
      chips.push({
        id: `${fac.key}:${v}`,
        label: `${fac.singular}: ${optionLabel(fac.key, v)}`,
        remove: () => setFacet(fac.key, fac.selected.filter(x => x !== v)),
      });
    }
  }
  if (f.source) chips.push({ id: "source", label: f.source === "direct" ? "Called by the model" : "Called by codemode", remove: () => onSourceChange("") });
  if (!f.includeDeleted) chips.push({ id: "deleted", label: "Deleted sessions hidden", remove: () => onToggleIncludeDeleted(true) });
  if (f.compare) chips.push({ id: "compare", label: "Comparing with previous period", remove: () => onToggleCompare(false) });
  return chips;
});

/** Filters hidden behind the mobile Filters button, so its badge shows real state. */
const extraFilterCount = computed(() => activeChips.value.filter(c => c.id !== "range").length);

const emptyHint = computed(() =>
  activeChips.value.length ? "Nothing matches the active filters. Remove a filter above or choose a wider time range." : "Nothing has been recorded here yet.",
);

// ---- state changes ----
function commit(next: Partial<typeof filters.value>, resetPage = true) {
  filters.value = { ...filters.value, ...next, ...(resetPage ? { page: 0 } : {}) };
  syncHash();
  void fetchAnalyticsQuery();
}

function syncHash() {
  if (syncingFromHash) return;
  const nextHash = buildAnalyticsHash(activeTab.value, filters.value, openTarget.value);
  if (window.location.hash !== nextHash) window.history.pushState(null, "", nextHash);
}

function inferPreset(from?: number, to?: number): RangePreset {
  if (from == null && to == null) return "all";
  if (from != null && to != null) {
    const p = RANGE_PRESETS.find(p => p.ms === to - from);
    if (p) return p.value;
  }
  return "custom";
}

function applyHashState() {
  syncingFromHash = true;
  try {
    const parsed = parseAnalyticsHash(window.location.hash);
    activeTab.value = parsed.tab;
    filters.value = parsed.filters;
    searchDraft.value = parsed.filters.search;
    openTarget.value = parsed.open;
    rangePreset.value = inferPreset(parsed.filters.from, parsed.filters.to);
    void fetchAnalyticsQuery();
    if (parsed.open) void fetchAnalyticsDetail(parsed.tab, parsed.open.kind, parsed.open.id);
    else clearAnalyticsDetail();
  } finally {
    syncingFromHash = false;
  }
}

function selectTab(tab: AnalyticsTab) {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  // Sort keys and the tool source only exist on some tabs; search text is per table.
  filters.value = { ...filters.value, page: 0, sort: undefined, search: "", source: tab === "tools" ? filters.value.source : undefined };
  searchDraft.value = "";
  openTarget.value = null;
  clearAnalyticsDetail();
  syncHash();
  void fetchAnalyticsQuery();
  body.value?.scrollTo({ top: 0 });
}

/** Rolling presets end "now"; recompute them so Refresh moves the window forward. */
function presetWindow(preset: RangePreset): { from?: number; to?: number } | null {
  const p = RANGE_PRESETS.find(x => x.value === preset);
  if (!p) return null;
  const to = Date.now();
  return { from: to - p.ms, to };
}

function onPresetChange(val: RangePreset) {
  rangePreset.value = val;
  if (val === "all") return commit({ from: undefined, to: undefined, compare: false });
  if (val === "custom") {
    if (filters.value.from == null && filters.value.to == null) {
      const to = Date.now();
      commit({ from: to - 7 * 86_400_000, to });
    }
    return;
  }
  commit(presetWindow(val)!);
}

function toLocalInput(ms?: number): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function onCustomDate(field: "from" | "to", val: string) {
  const ms = val ? new Date(val).getTime() : undefined;
  const next = { ...filters.value, [field]: Number.isFinite(ms) ? ms : undefined };
  commit({ from: next.from, to: next.to, compare: next.from != null && next.to != null ? next.compare : false });
}

function onZoom(range: { from: number; to: number }) {
  rangePreset.value = "custom";
  commit({ from: range.from, to: range.to });
}

function applySearch() {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  const q = searchDraft.value.trim();
  if (filters.value.search === q) return;
  commit({ search: q });
}
function clearSearch() {
  searchDraft.value = "";
  applySearch();
}
watch(searchDraft, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(applySearch, 350);
});

function setFacet(key: FacetKey, values: string[]) {
  if (key === "project") commit({ project: values.map(Number).filter(Number.isFinite) });
  else commit({ [key]: values });
}

function onSourceChange(val: string) {
  commit({ source: val === "direct" || val === "codemode" ? val : undefined });
}
function onToggleIncludeDeleted(checked: boolean) {
  commit({ includeDeleted: checked });
}
function onToggleCompare(checked: boolean) {
  if (checked && !hasFiniteWindow.value) return;
  commit({ compare: checked });
}

function resetFilters() {
  rangePreset.value = "all";
  searchDraft.value = "";
  filters.value = { ...defaultAnalyticsFilters(), limit: filters.value.limit };
  syncHash();
  void fetchAnalyticsQuery();
}

function onSort(nextSort: string) { commit({ sort: nextSort }); }
function onPage(nextPage: number) {
  commit({ page: Math.max(0, nextPage) }, false);
  document.getElementById("analytics-main-table")?.scrollIntoView({ block: "start" });
}
function onLimit(limit: number) { commit({ limit }); }

function refresh() {
  const win = presetWindow(rangePreset.value);
  if (win) filters.value = { ...filters.value, ...win };
  syncHash();
  void fetchAnalyticsQuery();
  void fetchAnalyticsFilterOptions();
}

async function doExport(format: "csv" | "json") {
  exportError.value = null;
  try {
    await exportAnalytics(format);
  } catch (e) {
    exportError.value = e instanceof Error ? e.message : String(e);
  }
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

onMounted(() => {
  applyHashState();
  void fetchAnalyticsFilterOptions();
  void loadWorkers().catch(() => {});
  window.addEventListener("hashchange", applyHashState);
  window.addEventListener("popstate", applyHashState);
  clock = setInterval(() => { now.value = Date.now(); }, 15_000);
  // No live refresh: numbers must not move while someone reads them. Refresh is manual.
});

onUnmounted(() => {
  window.removeEventListener("hashchange", applyHashState);
  window.removeEventListener("popstate", applyHashState);
  if (clock) clearInterval(clock);
  if (searchTimer) clearTimeout(searchTimer);
});

watch(() => queryResult.value, () => { now.value = Date.now(); });
</script>
