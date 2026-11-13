import { ref, shallowRef, watch } from "vue";
import { api, json, serverUrl, token } from "@/lib/api";
import type {
  AnalyticsFilterOptions,
  AnalyticsFilters,
  AnalyticsQueryResult,
  AnalyticsRow,
  AnalyticsTab,
} from "../../../src/analytics/types";
import {
  defaultAnalyticsFilters,
  filtersToSearchParams,
  type AnalyticsOpenTarget,
} from "@/pages/analytics/url-state";

export interface AnalyticsDetail {
  title: string;
  sections: { title: string; rows: AnalyticsRow[] }[];
  notes: string[];
}

export const activeTab = ref<AnalyticsTab>("overview");
export const filters = ref<AnalyticsFilters>(defaultAnalyticsFilters());
export const openTarget = ref<AnalyticsOpenTarget | null>(null);

export const queryResult = shallowRef<AnalyticsQueryResult | null>(null);
export const filterOptions = shallowRef<AnalyticsFilterOptions | null>(null);
export const detailResult = shallowRef<AnalyticsDetail | null>(null);

export const loading = ref(false);
export const error = ref<string | null>(null);
export const optionsLoading = ref(false);
export const detailLoading = ref(false);
export const detailError = ref<string | null>(null);
export const exporting = ref(false);

let generation = 0;
let queryAbort: AbortController | null = null;
let optionsAbort: AbortController | null = null;
let detailAbort: AbortController | null = null;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

watch(
  [serverUrl, token],
  () => {
    generation++;
    queryAbort?.abort();
    optionsAbort?.abort();
    detailAbort?.abort();
    queryAbort = null;
    optionsAbort = null;
    detailAbort = null;
    queryResult.value = null;
    filterOptions.value = null;
    detailResult.value = null;
    error.value = null;
    detailError.value = null;
    loading.value = false;
    detailLoading.value = false;
  },
  { flush: "sync" }
);

export async function fetchAnalyticsQuery(): Promise<void> {
  const ownGen = generation;
  queryAbort?.abort();
  const controller = new AbortController();
  queryAbort = controller;

  loading.value = true;
  error.value = null;

  try {
    const params = filtersToSearchParams(filters.value);
    const qs = params.toString();
    const path = `/v1/analytics/v2/${activeTab.value}${qs ? `?${qs}` : ""}`;
    const res = await json<AnalyticsQueryResult>(path, { signal: controller.signal });
    if (ownGen !== generation || controller.signal.aborted) return;
    queryResult.value = res;
  } catch (err) {
    if (ownGen !== generation || isAbortError(err)) return;
    error.value = err instanceof Error ? err.message : "Failed to load analytics";
  } finally {
    if (queryAbort === controller) {
      queryAbort = null;
      loading.value = false;
    }
  }
}

export async function fetchAnalyticsFilterOptions(): Promise<void> {
  const ownGen = generation;
  optionsAbort?.abort();
  const controller = new AbortController();
  optionsAbort = controller;
  optionsLoading.value = true;

  try {
    const res = await json<AnalyticsFilterOptions>("/v1/analytics/v2/filters", {
      signal: controller.signal,
    });
    if (ownGen !== generation || controller.signal.aborted) return;
    filterOptions.value = res;
  } catch (err) {
    if (ownGen !== generation || isAbortError(err)) return;
    // Filter options failure is non-fatal; keep existing or null.
  } finally {
    if (optionsAbort === controller) {
      optionsAbort = null;
      optionsLoading.value = false;
    }
  }
}

export async function fetchAnalyticsDetail(
  tab: AnalyticsTab,
  kind: string,
  id: string
): Promise<void> {
  const ownGen = generation;
  detailAbort?.abort();
  const controller = new AbortController();
  detailAbort = controller;

  detailLoading.value = true;
  detailError.value = null;
  detailResult.value = null;

  try {
    const params = filtersToSearchParams(filters.value);
    const qs = params.toString();
    const path = `/v1/analytics/v2/${tab}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
    const res = await json<AnalyticsDetail>(path, { signal: controller.signal });
    if (ownGen !== generation || controller.signal.aborted) return;
    detailResult.value = res;
  } catch (err) {
    if (ownGen !== generation || isAbortError(err)) return;
    detailError.value = err instanceof Error ? err.message : "Failed to load details";
  } finally {
    if (detailAbort === controller) {
      detailAbort = null;
      detailLoading.value = false;
    }
  }
}

export function clearAnalyticsDetail(): void {
  detailAbort?.abort();
  detailAbort = null;
  detailResult.value = null;
  detailError.value = null;
  detailLoading.value = false;
}

export async function exportAnalytics(format: "csv" | "json"): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const params = filtersToSearchParams(filters.value);
    params.set("format", format);
    const path = `/v1/analytics/v2/${activeTab.value}/export?${params.toString()}`;
    const res = await api(path, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `analytics-${activeTab.value}-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } finally {
    exporting.value = false;
  }
}

