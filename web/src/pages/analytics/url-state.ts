import { ANALYTICS_TABS, type AnalyticsFilters, type AnalyticsTab } from "../../../../src/analytics/types";

export { ANALYTICS_TABS };
export type { AnalyticsFilters, AnalyticsTab };

export interface AnalyticsOpenTarget {
  kind: string;
  id: string;
}

export interface AnalyticsHashState {
  tab: AnalyticsTab;
  filters: AnalyticsFilters;
  open: AnalyticsOpenTarget | null;
}

export function defaultAnalyticsFilters(): AnalyticsFilters {
  return {
    project: [],
    model: [],
    provider: [],
    worker: [],
    cwd: [],
    includeDeleted: true,
    compare: false,
    page: 0,
    limit: 20,
    search: "",
  };
}

export function isAnalyticsTab(value: string): value is AnalyticsTab {
  return (ANALYTICS_TABS as readonly string[]).includes(value);
}

export function parseAnalyticsHash(hash: string): AnalyticsHashState {
  const clean = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart, queryPart = ""] = clean.split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const rawTab = segments[0] === "analytics" ? segments[1] : segments[0];
  const tab: AnalyticsTab = rawTab && isAnalyticsTab(rawTab) ? rawTab : "overview";

  const params = new URLSearchParams(queryPart);
  const filters = defaultAnalyticsFilters();

  const fromStr = params.get("from");
  if (fromStr != null && fromStr !== "" && Number.isFinite(Number(fromStr))) {
    filters.from = Number(fromStr);
  }
  const toStr = params.get("to");
  if (toStr != null && toStr !== "" && Number.isFinite(Number(toStr))) {
    filters.to = Number(toStr);
  }

  filters.project = params.getAll("project").map(Number).filter((n) => Number.isFinite(n));
  filters.model = params.getAll("model").filter(Boolean);
  filters.provider = params.getAll("provider").filter(Boolean);
  filters.worker = params.getAll("worker").filter(Boolean);
  filters.cwd = params.getAll("cwd").filter(Boolean);

  const includeDeleted = params.get("includeDeleted");
  if (includeDeleted === "false" || includeDeleted === "0") {
    filters.includeDeleted = false;
  }

  const compare = params.get("compare");
  if (compare === "true" || compare === "1") {
    filters.compare = true;
  }

  const sort = params.get("sort");
  if (sort) filters.sort = sort;

  const page = Number(params.get("page"));
  if (Number.isInteger(page) && page >= 0) filters.page = page;

  const limit = Number(params.get("limit"));
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) filters.limit = limit;

  const search = params.get("search");
  if (search) filters.search = search;

  const source = params.get("source");
  if (source === "direct" || source === "codemode") filters.source = source;

  let open: AnalyticsOpenTarget | null = null;
  const openRaw = params.get("open");
  if (openRaw) {
    const idx = openRaw.indexOf(":");
    if (idx > 0 && idx < openRaw.length - 1) {
      open = {
        kind: openRaw.slice(0, idx),
        id: openRaw.slice(idx + 1),
      };
    }
  }

  return { tab, filters, open };
}

export function filtersToSearchParams(filters: AnalyticsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from != null) params.set("from", String(filters.from));
  if (filters.to != null) params.set("to", String(filters.to));
  for (const p of filters.project) params.append("project", String(p));
  for (const m of filters.model) params.append("model", m);
  for (const pr of filters.provider) params.append("provider", pr);
  for (const w of filters.worker) params.append("worker", w);
  for (const c of filters.cwd) params.append("cwd", c);
  if (!filters.includeDeleted) params.set("includeDeleted", "false");
  if (filters.compare) params.set("compare", "true");
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.page > 0) params.set("page", String(filters.page));
  if (filters.limit !== 20) params.set("limit", String(filters.limit));
  if (filters.search) params.set("search", filters.search);
  if (filters.source) params.set("source", filters.source);
  return params;
}

export function buildAnalyticsHash(
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
  open: AnalyticsOpenTarget | null
): string {
  const params = filtersToSearchParams(filters);
  if (open) {
    params.set("open", `${open.kind}:${open.id}`);
  }
  const qs = params.toString();
  return `#analytics/${tab}${qs ? `?${qs}` : ""}`;
}
