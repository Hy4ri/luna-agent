import type { AnalyticsStore } from "./store.js";
import type {
  AnalyticsFilterOptions,
  AnalyticsFilters,
  AnalyticsQueryResult,
  AnalyticsRow,
  AnalyticsTab,
  AnalyticsValue,
} from "./types.js";

type ColumnDef = {
  key: string;
  label: string;
  format?: "number" | "usd" | "ms" | "percent" | "date";
};

const MAX_EPOCH_MS = 8.64e15;
const MAX_REPEATED_FILTERS = 100;

// Cache parsed/aggregated views, never source scans. SQLite's connection change
// counter invalidates every view after an atomic index write (including tombstones).
const views = new WeakMap<AnalyticsStore, { revision: number; values: Map<string, unknown> }>();
function memo<T>(store: AnalyticsStore, key: string, read: () => T): T {
  const revision = (store.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
  let cache = views.get(store);
  if (!cache || cache.revision !== revision) {
    cache = { revision, values: new Map() };
    views.set(store, cache);
  }
  if (cache.values.has(key)) return cache.values.get(key) as T;
  const value = read();
  if (cache.values.size >= 128) cache.values.delete(cache.values.keys().next().value!);
  cache.values.set(key, value);
  return value;
}
function scopeKey(filters: AnalyticsFilters): string {
  return JSON.stringify({ ...filters, page: 0, limit: 0, sort: undefined, search: "", compare: false });
}

function parseStrictInt(raw: string, name: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Out-of-range integer for ${name}: ${raw}`);
  }
  return n;
}

function parseBoolParam(raw: string, name: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

export function parseAnalyticsFilters(params: URLSearchParams): AnalyticsFilters {
  let from: number | undefined;
  let to: number | undefined;

  const rawFrom = params.get("from");
  if (rawFrom !== null && rawFrom !== "") {
    from = parseStrictInt(rawFrom, "from");
    if (from < 0 || from > MAX_EPOCH_MS) throw new Error("from out of valid Date range");
  }

  const rawTo = params.get("to");
  if (rawTo !== null && rawTo !== "") {
    to = parseStrictInt(rawTo, "to");
    if (to < 0 || to > MAX_EPOCH_MS) throw new Error("to out of valid Date range");
  }

  if (from !== undefined && to !== undefined && from >= to) {
    throw new Error("from must be less than to");
  }

  const project: number[] = [];
  for (const p of params.getAll("project")) {
    if (p !== "") project.push(parseStrictInt(p, "project"));
  }
  if (project.length > MAX_REPEATED_FILTERS) {
    throw new Error(`Too many project filters (max ${MAX_REPEATED_FILTERS})`);
  }

  const model = params.getAll("model").filter((v) => v !== "");
  const provider = params.getAll("provider").filter((v) => v !== "");
  const worker = params.getAll("worker").filter((v) => v !== "");
  const cwd = params.getAll("cwd").filter((v) => v !== "");

  if (
    model.length > MAX_REPEATED_FILTERS ||
    provider.length > MAX_REPEATED_FILTERS ||
    worker.length > MAX_REPEATED_FILTERS ||
    cwd.length > MAX_REPEATED_FILTERS
  ) {
    throw new Error(`Too many repeated filter values (max ${MAX_REPEATED_FILTERS})`);
  }

  const rawIncludeDeleted = params.get("includeDeleted");
  const includeDeleted =
    rawIncludeDeleted !== null && rawIncludeDeleted !== ""
      ? parseBoolParam(rawIncludeDeleted, "includeDeleted")
      : true;

  const rawCompare = params.get("compare");
  const compare =
    rawCompare !== null && rawCompare !== ""
      ? parseBoolParam(rawCompare, "compare")
      : false;

  const rawPage = params.get("page");
  const page =
    rawPage !== null && rawPage !== "" ? parseStrictInt(rawPage, "page") : 0;
  if (page < 0) throw new Error("page must be >= 0");

  const rawLimit = params.get("limit");
  const limit =
    rawLimit !== null && rawLimit !== "" ? parseStrictInt(rawLimit, "limit") : 20;
  if (limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");

  const search = params.get("search") ?? "";
  if (search.length > 512) throw new Error("search exceeds max length 512");

  const rawSort = params.get("sort");
  let sort: string | undefined;
  if (rawSort !== null && rawSort !== "") {
    if (rawSort.length > 100 || !/^[a-zA-Z0-9_]+(?::(?:asc|desc))?$/.test(rawSort)) {
      throw new Error(`Invalid sort parameter: ${rawSort}`);
    }
    sort = rawSort;
  }

  const rawSource = params.get("source");
  let source: "direct" | "codemode" | undefined;
  if (rawSource !== null && rawSource !== "") {
    if (rawSource !== "direct" && rawSource !== "codemode") {
      throw new Error(`Invalid source: ${rawSource}`);
    }
    source = rawSource;
  }

  return {
    from,
    to,
    project,
    model,
    provider,
    worker,
    cwd,
    includeDeleted,
    compare,
    sort,
    page,
    limit,
    search,
    source,
  };
}

function providerExpr(alias = "f"): string {
  return `COALESCE(json_extract(${alias}.data, '$.provider'), CASE WHEN instr(${alias}.model, '/') > 0 THEN substr(${alias}.model, 1, instr(${alias}.model, '/') - 1) ELSE NULL END)`;
}

function buildSessionWhere(
  filters: AnalyticsFilters,
  alias = "s",
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (!filters.includeDeleted) {
    clauses.push(`${alias}.deleted_at IS NULL`);
  }
  if (filters.project.length > 0) {
    clauses.push(
      `${alias}.project_id IN (${filters.project.map(() => "?").join(",")})`,
    );
    params.push(...filters.project);
  }
  if (filters.worker.length > 0) {
    clauses.push(`${alias}.worker IN (${filters.worker.map(() => "?").join(",")})`);
    params.push(...filters.worker);
  }
  if (filters.cwd.length > 0) {
    clauses.push(`${alias}.cwd IN (${filters.cwd.map(() => "?").join(",")})`);
    params.push(...filters.cwd);
  }

  return {
    sql: clauses.length > 0 ? clauses.join(" AND ") : "1=1",
    params,
  };
}

function buildFactWhere(
  filters: AnalyticsFilters,
  alias = "f",
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters.from !== undefined) {
    clauses.push(`${alias}.ts >= ?`);
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    clauses.push(`${alias}.ts < ?`);
    params.push(filters.to);
  }
  if (filters.model.length > 0) {
    clauses.push(`${alias}.model IN (${filters.model.map(() => "?").join(",")})`);
    params.push(...filters.model);
  }
  if (filters.provider.length > 0) {
    clauses.push(
      `${providerExpr(alias)} IN (${filters.provider.map(() => "?").join(",")})`,
    );
    params.push(...filters.provider);
  }
  if (filters.source !== undefined) {
    clauses.push(`${alias}.source = ?`);
    params.push(filters.source);
  }

  return {
    sql: clauses.length > 0 ? clauses.join(" AND ") : "1=1",
    params,
  };
}

function hasFactFilters(filters: AnalyticsFilters): boolean {
  return (
    filters.from !== undefined ||
    filters.to !== undefined ||
    filters.model.length > 0 ||
    filters.provider.length > 0 ||
    filters.source !== undefined
  );
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? null;
}

function sortRows(
  rows: AnalyticsRow[],
  sortSpec: string | undefined,
  allowlist: Set<string>,
  defaultKey: string,
  defaultDir: "asc" | "desc" = "desc",
): AnalyticsRow[] {
  let key = defaultKey;
  let dir = defaultDir;

  if (sortSpec) {
    const [rawKey, rawDir] = sortSpec.split(":");
    if (!rawKey || !allowlist.has(rawKey)) {
      throw new Error(`Invalid sort key: ${sortSpec}`);
    }
    key = rawKey;
    if (rawDir === "asc" || rawDir === "desc") {
      dir = rawDir;
    } else if (rawDir !== undefined) {
      throw new Error(`Invalid sort direction: ${sortSpec}`);
    }
  }

  return [...rows].sort((a, b) => {
    const av = a[key] ?? null;
    const bv = b[key] ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    let cmp = 0;
    if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      cmp = String(av).localeCompare(String(bv));
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

function filterBySearch(rows: AnalyticsRow[], search: string, keys: string[]): AnalyticsRow[] {
  const q = search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    keys.some((k) => {
      const val = row[k];
      return val !== null && val !== undefined && String(val).toLowerCase().includes(q);
    }),
  );
}

function computeSummary(store: AnalyticsStore, filters: AnalyticsFilters): AnalyticsRow {
  const sWhere = buildSessionWhere(filters, "s");
  const fWhere = buildFactWhere(filters, "f");
  const factScoped = hasFactFilters(filters);

  const factCounts = store.db
    .query(
      `SELECT
         COUNT(DISTINCT s.id) AS factSessions,
         SUM(CASE WHEN f.kind = 'response' THEN 1 ELSE 0 END) AS responses,
         SUM(CASE WHEN f.kind = 'tool' THEN 1 ELSE 0 END) AS toolCalls,
         SUM(CASE WHEN f.kind IN ('response', 'tool') AND f.error = 1 THEN 1 ELSE 0 END) AS errors,
         AVG(CASE WHEN f.kind = 'response' AND f.duration_ms IS NOT NULL THEN f.duration_ms ELSE NULL END) AS avgDurationMs
       FROM analytics_facts f
       JOIN analytics_sessions s ON s.id = f.session_id
       WHERE ${sWhere.sql} AND ${fWhere.sql}`,
    )
    .get(...sWhere.params, ...fWhere.params) as Record<string, number | null> | null;

  let sessionsCount = factCounts?.factSessions ?? 0;
  let usageRow: Record<string, number | null> | null = null;
  if (factScoped) {
    usageRow = store.db
      .query(
        `SELECT
           COALESCE(SUM(f.input_tokens), 0) AS inputTokens,
           COALESCE(SUM(f.output_tokens), 0) AS outputTokens,
           COALESCE(SUM(f.cache_read), 0) AS cacheRead,
           COALESCE(SUM(f.cache_write), 0) AS cacheWrite,
           COALESCE(SUM(f.total_tokens), 0) AS totalTokens,
           COALESCE(SUM(f.cost_total), 0) AS cost
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response'`,
      )
      .get(...sWhere.params, ...fWhere.params) as Record<string, number | null> | null;
  } else {
    usageRow = store.db
      .query(
        `SELECT
           COUNT(*) AS sessions,
           COALESCE(SUM(CAST(json_extract(s.record, '$.usage.input') AS REAL)), 0) AS inputTokens,
           COALESCE(SUM(CAST(json_extract(s.record, '$.usage.output') AS REAL)), 0) AS outputTokens,
           COALESCE(SUM(CAST(json_extract(s.record, '$.usage.cacheRead') AS REAL)), 0) AS cacheRead,
           COALESCE(SUM(CAST(json_extract(s.record, '$.usage.cacheWrite') AS REAL)), 0) AS cacheWrite,
           COALESCE(SUM(CAST(json_extract(s.record, '$.usage.totalTokens') AS REAL)), 0) AS totalTokens,
           COALESCE(SUM(CAST(json_extract(s.record, '$.usage.cost.total') AS REAL)), 0) AS cost
         FROM analytics_sessions s
         WHERE ${sWhere.sql}`,
      )
      .get(...sWhere.params) as Record<string, number | null> | null;
    sessionsCount = usageRow?.sessions ?? 0;
  }

  const responses = factCounts?.responses ?? 0;
  const toolCalls = factCounts?.toolCalls ?? 0;
  const errors = factCounts?.errors ?? 0;
  const totalEvents = responses + toolCalls;
  const inputTokens = usageRow?.inputTokens ?? 0;
  const cacheRead = usageRow?.cacheRead ?? 0;
  const cacheWrite = usageRow?.cacheWrite ?? 0;
  const cacheDenom = inputTokens + cacheRead + cacheWrite;

  return {
    sessions: sessionsCount,
    responses,
    toolCalls,
    errors,
    errorRate: totalEvents > 0 ? errors / totalEvents : 0,
    avgDurationMs: factCounts?.avgDurationMs ?? null,
    inputTokens,
    outputTokens: usageRow?.outputTokens ?? 0,
    cacheRead,
    cacheWrite,
    cacheHitRate: cacheDenom > 0 ? cacheRead / cacheDenom : null,
    totalTokens: usageRow?.totalTokens ?? 0,
    cost: usageRow?.cost ?? 0,
  };
}

function buildTimeSeries(
  store: AnalyticsStore,
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
): { name: string; points: { x: string; y: number }[] }[] {
  const sWhere = buildSessionWhere(filters, "s");
  const fWhere = buildFactWhere(filters, "f");

  if (tab === "tools") {
    const rows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
           COUNT(*) AS calls,
           COALESCE(SUM(CASE WHEN f.error = 1 THEN 1 ELSE 0 END), 0) AS errors
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind IN ('tool', 'skill') AND f.ts IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...sWhere.params, ...fWhere.params) as { bucket: string; calls: number; errors: number }[];

    return [
      { name: "Tool & Skill Calls", points: rows.map((r) => ({ x: r.bucket, y: r.calls ?? 0 })) },
      { name: "Errors", points: rows.map((r) => ({ x: r.bucket, y: r.errors ?? 0 })) },
    ];
  }

  if (tab === "reliability") {
    const rows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
           COALESCE(SUM(CASE WHEN f.error = 1 THEN 1 ELSE 0 END), 0) AS errors,
           COALESCE(SUM(CASE WHEN f.aborted = 1 THEN 1 ELSE 0 END), 0) AS aborted
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response' AND f.ts IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...sWhere.params, ...fWhere.params) as { bucket: string; errors: number; aborted: number }[];

    return [
      { name: "Response Errors", points: rows.map((r) => ({ x: r.bucket, y: r.errors ?? 0 })) },
      { name: "Aborted Responses", points: rows.map((r) => ({ x: r.bucket, y: r.aborted ?? 0 })) },
    ];
  }

  if (tab === "speed") {
    const rows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
           AVG(f.duration_ms) AS avgDurationMs
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response' AND f.duration_ms IS NOT NULL AND f.ts IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...sWhere.params, ...fWhere.params) as { bucket: string; avgDurationMs: number }[];

    return [
      { name: "Avg Response Duration (ms)", points: rows.map((r) => ({ x: r.bucket, y: r.avgDurationMs ?? 0 })) },
    ];
  }

  if (tab === "context") {
    const rows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
           COALESCE(SUM(CASE WHEN f.kind = 'compaction' THEN 1 ELSE 0 END), 0) AS compactions,
           COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.cache_read ELSE 0 END), 0) AS cacheRead
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind IN ('compaction', 'response') AND f.ts IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...sWhere.params, ...fWhere.params) as { bucket: string; compactions: number; cacheRead: number }[];

    return [
      { name: "Compactions", points: rows.map((r) => ({ x: r.bucket, y: r.compactions ?? 0 })) },
      { name: "Cache Read Tokens", points: rows.map((r) => ({ x: r.bucket, y: r.cacheRead ?? 0 })) },
    ];
  }

  if (tab === "workflow") {
    const rows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
           COALESCE(SUM(CASE WHEN f.kind = 'wait' THEN 1 ELSE 0 END), 0) AS waits,
           COALESCE(SUM(CASE WHEN f.kind = 'model_switch' THEN 1 ELSE 0 END), 0) AS modelSwitches
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind IN ('wait', 'model_switch') AND f.ts IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...sWhere.params, ...fWhere.params) as { bucket: string; waits: number; modelSwitches: number }[];

    return [
      { name: "Wait Events", points: rows.map((r) => ({ x: r.bucket, y: r.waits ?? 0 })) },
      { name: "Model Switches", points: rows.map((r) => ({ x: r.bucket, y: r.modelSwitches ?? 0 })) },
    ];
  }

  if (tab === "delegation") {
    const rows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
           COUNT(*) AS delegations
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'delegation' AND f.ts IS NOT NULL
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all(...sWhere.params, ...fWhere.params) as { bucket: string; delegations: number }[];

    return [
      { name: "Delegation Events", points: rows.map((r) => ({ x: r.bucket, y: r.delegations ?? 0 })) },
    ];
  }

  const rows = store.db
    .query(
      `SELECT
         strftime('%Y-%m-%d %H:00', f.ts / 1000, 'unixepoch') AS bucket,
         COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.cost_total ELSE 0 END), 0) AS cost,
         COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.total_tokens ELSE 0 END), 0) AS tokens
       FROM analytics_facts f
       JOIN analytics_sessions s ON s.id = f.session_id
       WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response' AND f.ts IS NOT NULL
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(...sWhere.params, ...fWhere.params) as { bucket: string; cost: number; tokens: number }[];

  return [
    {
      name: "Cost (USD)",
      points: rows.map((r) => ({ x: r.bucket, y: r.cost ?? 0 })),
    },
    {
      name: "Tokens",
      points: rows.map((r) => ({ x: r.bucket, y: r.tokens ?? 0 })),
    },
  ];
}

function queryTabTable(
  store: AnalyticsStore,
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
): { columns: ColumnDef[]; rows: AnalyticsRow[]; searchKeys: string[]; allowSort: Set<string>; defaultSort: string } {
  const sWhere = buildSessionWhere(filters, "s");
  const fWhere = buildFactWhere(filters, "f");
  const factScoped = hasFactFilters(filters);

  if (tab === "models") {
    const respMetrics = store.db
      .query(
        `SELECT
           f.model AS model,
           ${providerExpr("f")} AS provider,
           COUNT(*) AS responses,
           COALESCE(SUM(f.input_tokens), 0) AS inputTokens,
           COALESCE(SUM(f.output_tokens), 0) AS outputTokens,
           COALESCE(SUM(f.cache_read), 0) AS cacheRead,
           COALESCE(SUM(f.cache_write), 0) AS cacheWrite,
           SUM(f.cache_write_1h) AS cacheWrite1h,
           SUM(f.reasoning_tokens) AS reasoning,
           COALESCE(SUM(f.total_tokens), 0) AS totalTokens,
           COALESCE(SUM(f.cost_total), 0) AS cost,
           COALESCE(SUM(f.cost_input), 0) AS inputCost,
           COALESCE(SUM(f.cost_output), 0) AS outputCost,
           COALESCE(SUM(f.cost_cache_read), 0) AS cacheReadCost,
           COALESCE(SUM(f.cost_cache_write), 0) AS cacheWriteCost,
           AVG(f.duration_ms) AS avgDurationMs,
           SUM(f.error) AS errors,
           MIN(f.ts) AS firstSeen,
           MAX(f.ts) AS lastSeen
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response' AND f.model IS NOT NULL
         GROUP BY f.model`,
      )
      .all(...sWhere.params, ...fWhere.params) as Record<string, number | string | null>[];

    let rows: AnalyticsRow[];
    if (!factScoped) {
      const ledgerRows = store.db
        .query(
          `SELECT
             j.key AS model,
             COALESCE(SUM(CAST(json_extract(j.value, '$.input') AS REAL)), 0) AS inputTokens,
             COALESCE(SUM(CAST(json_extract(j.value, '$.output') AS REAL)), 0) AS outputTokens,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cacheRead') AS REAL)), 0) AS cacheRead,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cacheWrite') AS REAL)), 0) AS cacheWrite,
             SUM(CAST(json_extract(j.value, '$.cacheWrite1h') AS REAL)) AS cacheWrite1h,
             SUM(CAST(json_extract(j.value, '$.reasoning') AS REAL)) AS reasoning,
             COALESCE(SUM(CAST(json_extract(j.value, '$.totalTokens') AS REAL)), 0) AS totalTokens,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cost.total') AS REAL)), 0) AS cost,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cost.input') AS REAL)), 0) AS inputCost,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cost.output') AS REAL)), 0) AS outputCost,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cost.cacheRead') AS REAL)), 0) AS cacheReadCost,
             COALESCE(SUM(CAST(json_extract(j.value, '$.cost.cacheWrite') AS REAL)), 0) AS cacheWriteCost
           FROM analytics_sessions s, json_each(s.record, '$.modelUsage') j
           WHERE ${sWhere.sql} AND json_type(s.record, '$.modelUsage') = 'object'
           GROUP BY j.key`,
        )
        .all(...sWhere.params) as Record<string, number | string | null>[];

      const fallbackRows = store.db
        .query(
          `SELECT
             f.model AS model,
             COALESCE(SUM(f.input_tokens), 0) AS inputTokens,
             COALESCE(SUM(f.output_tokens), 0) AS outputTokens,
             COALESCE(SUM(f.cache_read), 0) AS cacheRead,
             COALESCE(SUM(f.cache_write), 0) AS cacheWrite,
             SUM(f.cache_write_1h) AS cacheWrite1h,
             SUM(f.reasoning_tokens) AS reasoning,
             COALESCE(SUM(f.total_tokens), 0) AS totalTokens,
             COALESCE(SUM(f.cost_total), 0) AS cost,
             COALESCE(SUM(f.cost_input), 0) AS inputCost,
             COALESCE(SUM(f.cost_output), 0) AS outputCost,
             COALESCE(SUM(f.cost_cache_read), 0) AS cacheReadCost,
             COALESCE(SUM(f.cost_cache_write), 0) AS cacheWriteCost
           FROM analytics_facts f
           JOIN analytics_sessions s ON s.id = f.session_id
           WHERE ${sWhere.sql} AND json_type(s.record, '$.modelUsage') IS NULL AND f.kind = 'response' AND f.model IS NOT NULL
           GROUP BY f.model`,
        )
        .all(...sWhere.params) as Record<string, number | string | null>[];

      const respByModel = new Map<string, Record<string, number | string | null>>();
      for (const r of respMetrics) {
        if (r.model) respByModel.set(String(r.model), r);
      }
      const usageByModel = new Map<string, Record<string, number | string | null>>();
      for (const u of [...ledgerRows, ...fallbackRows]) {
        const m = String(u.model);
        const prev = usageByModel.get(m);
        if (!prev) {
          usageByModel.set(m, { ...u });
        } else {
          for (const k of ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "totalTokens", "cost", "inputCost", "outputCost", "cacheReadCost", "cacheWriteCost"]) {
            prev[k] = Number(prev[k] ?? 0) + Number(u[k] ?? 0);
          }
          for (const k of ["cacheWrite1h", "reasoning"]) {
            if (u[k] !== null && u[k] !== undefined) {
              prev[k] = Number(prev[k] ?? 0) + Number(u[k]);
            }
          }
        }
      }

      const allModels = new Set([...respByModel.keys(), ...usageByModel.keys()]);
      rows = [];
      for (const m of allModels) {
        const u = usageByModel.get(m) ?? {};
        const r = respByModel.get(m) ?? {};
        const inputTokens = Number(u.inputTokens ?? r.inputTokens ?? 0);
        const cacheRead = Number(u.cacheRead ?? r.cacheRead ?? 0);
        const cacheWrite = Number(u.cacheWrite ?? r.cacheWrite ?? 0);
        const cacheDenom = inputTokens + cacheRead + cacheWrite;
        const responses = Number(r.responses ?? 0);
        const errors = Number(r.errors ?? 0);
        const provider = r.provider ?? (m.includes("/") ? m.split("/")[0]! : null);
        rows.push({
          id: m,
          kind: "model",
          model: m,
          provider,
          responses,
          inputTokens,
          outputTokens: Number(u.outputTokens ?? r.outputTokens ?? 0),
          cacheRead,
          cacheWrite: Number(u.cacheWrite ?? r.cacheWrite ?? 0),
          cacheWrite1h: (u.cacheWrite1h ?? r.cacheWrite1h ?? null) as number | null,
          reasoning: (u.reasoning ?? r.reasoning ?? null) as number | null,
          cacheHitRate: cacheDenom > 0 ? cacheRead / cacheDenom : null,
          totalTokens: Number(u.totalTokens ?? r.totalTokens ?? 0),
          cost: Number(u.cost ?? r.cost ?? 0),
          inputCost: Number(u.inputCost ?? r.inputCost ?? 0),
          outputCost: Number(u.outputCost ?? r.outputCost ?? 0),
          cacheReadCost: Number(u.cacheReadCost ?? r.cacheReadCost ?? 0),
          cacheWriteCost: Number(u.cacheWriteCost ?? r.cacheWriteCost ?? 0),
          avgDurationMs: (r.avgDurationMs ?? null) as number | null,
          errorRate: responses > 0 ? errors / responses : 0,
          firstSeen: (r.firstSeen ?? null) as number | null,
          lastSeen: (r.lastSeen ?? null) as number | null,
        });
      }
    } else {
      rows = respMetrics.map((r) => {
        const inputTokens = Number(r.inputTokens ?? 0);
        const cacheRead = Number(r.cacheRead ?? 0);
        const cacheWrite = Number(r.cacheWrite ?? 0);
        const cacheDenom = inputTokens + cacheRead + cacheWrite;
        const responses = Number(r.responses ?? 0);
        const errors = Number(r.errors ?? 0);
        return {
          id: r.model ?? "unknown",
          kind: "model",
          model: r.model ?? null,
          provider: r.provider ?? null,
          responses,
          inputTokens,
          outputTokens: Number(r.outputTokens ?? 0),
          cacheRead,
          cacheWrite: Number(r.cacheWrite ?? 0),
          cacheWrite1h: (r.cacheWrite1h ?? null) as number | null,
          reasoning: (r.reasoning ?? null) as number | null,
          cacheHitRate: cacheDenom > 0 ? cacheRead / cacheDenom : null,
          totalTokens: Number(r.totalTokens ?? 0),
          cost: Number(r.cost ?? 0),
          inputCost: Number(r.inputCost ?? 0),
          outputCost: Number(r.outputCost ?? 0),
          cacheReadCost: Number(r.cacheReadCost ?? 0),
          cacheWriteCost: Number(r.cacheWriteCost ?? 0),
          avgDurationMs: (r.avgDurationMs ?? null) as number | null,
          errorRate: responses > 0 ? errors / responses : 0,
          firstSeen: (r.firstSeen ?? null) as number | null,
          lastSeen: (r.lastSeen ?? null) as number | null,
        };
      });
    }

    return {
      columns: [
        { key: "model", label: "Model" },
        { key: "provider", label: "Provider" },
        { key: "responses", label: "Responses", format: "number" },
        { key: "inputTokens", label: "Input", format: "number" },
        { key: "outputTokens", label: "Output", format: "number" },
        { key: "cacheRead", label: "Cache Read", format: "number" },
        { key: "cacheWrite", label: "Cache Write", format: "number" },
        { key: "cacheHitRate", label: "Cache Hit", format: "percent" },
        { key: "totalTokens", label: "Tokens", format: "number" },
        { key: "cost", label: "Cost", format: "usd" },
        { key: "avgDurationMs", label: "Avg Duration", format: "ms" },
        { key: "errorRate", label: "Error Rate", format: "percent" },
        { key: "firstSeen", label: "First Seen", format: "date" },
        { key: "lastSeen", label: "Last Seen", format: "date" },
      ],
      rows,
      searchKeys: ["model", "provider"],
      allowSort: new Set([
        "model", "provider", "responses", "inputTokens", "outputTokens",
        "cacheRead", "cacheWrite", "cacheHitRate", "totalTokens", "cost",
        "avgDurationMs", "errorRate", "firstSeen", "lastSeen",
      ]),
      defaultSort: "cost",
    };
  }

  if (tab === "tools") {
    const raw = store.db
      .query(
        `SELECT
           f.name AS id,
           f.kind AS kind,
           f.name AS name,
           COUNT(*) AS calls,
           SUM(CASE WHEN f.source = 'direct' THEN 1 ELSE 0 END) AS directCalls,
           SUM(CASE WHEN f.source = 'codemode' THEN 1 ELSE 0 END) AS codemodeCalls,
           SUM(f.error) AS errors,
           AVG(f.duration_ms) AS avgDurationMs
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind IN ('tool', 'skill') AND f.name IS NOT NULL
         GROUP BY f.name, f.kind`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    const rows = raw.map((r) => ({
      ...r,
      errorRate: Number(r.calls) > 0 ? Number(r.errors) / Number(r.calls) : 0,
    }));

    return {
      columns: [
        { key: "name", label: "Name" },
        { key: "kind", label: "Kind" },
        { key: "calls", label: "Calls", format: "number" },
        { key: "directCalls", label: "Direct", format: "number" },
        { key: "codemodeCalls", label: "Codemode", format: "number" },
        { key: "errors", label: "Errors", format: "number" },
        { key: "errorRate", label: "Error Rate", format: "percent" },
        { key: "avgDurationMs", label: "Avg Duration", format: "ms" },
      ],
      rows,
      searchKeys: ["name", "kind"],
      allowSort: new Set(["name", "kind", "calls", "directCalls", "codemodeCalls", "errors", "errorRate", "avgDurationMs"]),
      defaultSort: "calls",
    };
  }

  if (tab === "projects") {
    const rows = factScoped
      ? (store.db
          .query(
            `SELECT
               (CAST(s.project_id AS TEXT) || '|' || COALESCE(s.worker, '') || '|' || COALESCE(s.cwd, '')) AS id,
               'repo' AS kind,
               s.project_id AS projectId,
               COALESCE(json_extract(s.record, '$.projectName'), CAST(s.project_id AS TEXT)) AS projectName,
               s.worker AS worker,
               s.cwd AS cwd,
               COUNT(DISTINCT s.id) AS sessions,
               COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.total_tokens ELSE 0 END), 0) AS totalTokens,
               COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.cost_total ELSE 0 END), 0) AS cost,
               MAX(s.last_activity) AS lastActivity
             FROM analytics_sessions s
             JOIN analytics_facts f ON f.session_id = s.id
             WHERE ${sWhere.sql} AND ${fWhere.sql}
             GROUP BY s.project_id, s.worker, s.cwd`,
          )
          .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[])
      : (store.db
          .query(
            `SELECT
               (CAST(s.project_id AS TEXT) || '|' || COALESCE(s.worker, '') || '|' || COALESCE(s.cwd, '')) AS id,
               'repo' AS kind,
               s.project_id AS projectId,
               COALESCE(json_extract(s.record, '$.projectName'), CAST(s.project_id AS TEXT)) AS projectName,
               s.worker AS worker,
               s.cwd AS cwd,
               COUNT(DISTINCT s.id) AS sessions,
               COALESCE(SUM(CAST(json_extract(s.record, '$.usage.totalTokens') AS REAL)), 0) AS totalTokens,
               COALESCE(SUM(CAST(json_extract(s.record, '$.usage.cost.total') AS REAL)), 0) AS cost,
               MAX(s.last_activity) AS lastActivity
             FROM analytics_sessions s
             WHERE ${sWhere.sql}
             GROUP BY s.project_id, s.worker, s.cwd`,
          )
          .all(...sWhere.params) as AnalyticsRow[]);

    return {
      columns: [
        { key: "projectName", label: "Project" },
        { key: "worker", label: "Worker" },
        { key: "cwd", label: "CWD" },
        { key: "sessions", label: "Sessions", format: "number" },
        { key: "totalTokens", label: "Tokens", format: "number" },
        { key: "cost", label: "Cost", format: "usd" },
        { key: "lastActivity", label: "Last Activity", format: "date" },
      ],
      rows,
      searchKeys: ["projectName", "worker", "cwd"],
      allowSort: new Set(["projectName", "worker", "cwd", "sessions", "totalTokens", "cost", "lastActivity"]),
      defaultSort: "cost",
    };
  }

  if (tab === "speed") {
    const raw = store.db
      .query(
        `SELECT
           f.model AS model,
           f.duration_ms AS durationMs,
           COALESCE(f.output_tokens, 0) AS outputTokens
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response' AND f.duration_ms IS NOT NULL AND f.model IS NOT NULL`,
      )
      .all(...sWhere.params, ...fWhere.params) as { model: string; durationMs: number; outputTokens: number }[];

    const byModel = new Map<string, { durations: number[]; outputTokens: number }>();
    for (const r of raw) {
      const entry = byModel.get(r.model) ?? { durations: [], outputTokens: 0 };
      entry.durations.push(r.durationMs);
      entry.outputTokens += r.outputTokens ?? 0;
      byModel.set(r.model, entry);
    }

    const rows: AnalyticsRow[] = [];
    for (const [model, entry] of byModel.entries()) {
      entry.durations.sort((a, b) => a - b);
      const totalDurationMs = entry.durations.reduce((acc, v) => acc + v, 0);
      rows.push({
        id: model,
        kind: "model",
        model,
        count: entry.durations.length,
        avgDurationMs: totalDurationMs / entry.durations.length,
        p50DurationMs: percentile(entry.durations, 50),
        p95DurationMs: percentile(entry.durations, 95),
        outputTokensPerSec: totalDurationMs > 0 ? entry.outputTokens / (totalDurationMs / 1000) : null,
      });
    }

    return {
      columns: [
        { key: "model", label: "Model" },
        { key: "count", label: "Samples", format: "number" },
        { key: "avgDurationMs", label: "Avg", format: "ms" },
        { key: "p50DurationMs", label: "Median (p50)", format: "ms" },
        { key: "p95DurationMs", label: "p95", format: "ms" },
        { key: "outputTokensPerSec", label: "Output tok/s", format: "number" },
      ],
      rows,
      searchKeys: ["model"],
      allowSort: new Set(["model", "count", "avgDurationMs", "p50DurationMs", "p95DurationMs", "outputTokensPerSec"]),
      defaultSort: "p95DurationMs",
    };
  }

  if (tab === "reliability") {
    const rows = store.db
      .query(
        `SELECT
           f.key AS id,
           'event' AS kind,
           f.kind AS eventKind,
           f.name AS name,
           f.model AS model,
           f.session_id AS sessionId,
           f.duration_ms AS durationMs,
           f.error AS error,
           f.aborted AS aborted,
           f.ts AS ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND (f.error = 1 OR f.aborted = 1)`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    return {
      columns: [
        { key: "eventKind", label: "Type" },
        { key: "name", label: "Name" },
        { key: "model", label: "Model" },
        { key: "sessionId", label: "Session", format: "number" },
        { key: "durationMs", label: "Duration", format: "ms" },
        { key: "ts", label: "Time", format: "date" },
      ],
      rows,
      searchKeys: ["eventKind", "name", "model"],
      allowSort: new Set(["eventKind", "name", "model", "sessionId", "durationMs", "ts"]),
      defaultSort: "ts",
    };
  }

  if (tab === "delegation") {
    const rows = store.db
      .query(
        `SELECT
           f.key AS id,
           'event' AS kind,
           f.name AS name,
           f.model AS model,
           COALESCE(CAST(json_extract(f.data, '$.sourceSessionId') AS INTEGER), f.session_id) AS sourceSessionId,
           json_extract(s.record, '$.title') AS sourceTitle,
           CAST(json_extract(f.data, '$.targetSessionId') AS INTEGER) AS targetSessionId,
           json_extract(ts.record, '$.title') AS targetTitle,
           json_extract(ts.record, '$.status') AS targetStatus,
           CAST(json_extract(ts.record, '$.usage.totalTokens') AS REAL) AS targetTotalTokens,
           CAST(json_extract(ts.record, '$.usage.cost.total') AS REAL) AS targetCost,
           COALESCE(json_extract(f.data, '$.outcome'), CASE WHEN f.error = 1 THEN 'error' WHEN f.aborted = 1 THEN 'aborted' ELSE NULL END) AS outcome,
           f.duration_ms AS durationMs,
           f.ts AS ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         LEFT JOIN analytics_sessions ts ON ts.id = CAST(json_extract(f.data, '$.targetSessionId') AS INTEGER)
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'delegation'`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    return {
      columns: [
        { key: "name", label: "Name" },
        { key: "sourceSessionId", label: "Source Session", format: "number" },
        { key: "sourceTitle", label: "Source Title" },
        { key: "targetSessionId", label: "Target Session", format: "number" },
        { key: "targetTitle", label: "Target Title" },
        { key: "targetStatus", label: "Target Status" },
        { key: "targetTotalTokens", label: "Target Tokens", format: "number" },
        { key: "targetCost", label: "Target Cost", format: "usd" },
        { key: "outcome", label: "Outcome" },
        { key: "model", label: "Model" },
        { key: "durationMs", label: "Duration", format: "ms" },
        { key: "ts", label: "Time", format: "date" },
      ],
      rows,
      searchKeys: ["name", "model", "outcome", "sourceTitle", "targetTitle", "targetStatus"],
      allowSort: new Set(["name", "sourceSessionId", "targetSessionId", "targetTotalTokens", "targetCost", "outcome", "model", "durationMs", "ts"]),
      defaultSort: "ts",
    };
  }

  if (tab === "context") {
    const rows = store.db
      .query(
        `SELECT
           f.key AS id,
           'event' AS kind,
           f.kind AS eventKind,
           f.name AS name,
           f.model AS model,
           f.session_id AS sessionId,
           f.chars AS chars,
           f.thinking_chars AS thinkingChars,
           f.cache_read AS cacheReadTokens,
           f.duration_ms AS durationMs,
           f.ts AS ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind IN ('response', 'compaction', 'upload', 'vision', 'system', 'model_switch', 'undo')`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    return {
      columns: [
        { key: "eventKind", label: "Type" },
        { key: "name", label: "Name" },
        { key: "sessionId", label: "Session", format: "number" },
        { key: "chars", label: "Chars", format: "number" },
        { key: "thinkingChars", label: "Thinking Chars", format: "number" },
        { key: "cacheReadTokens", label: "Cache Read Tokens", format: "number" },
        { key: "durationMs", label: "Duration", format: "ms" },
        { key: "ts", label: "Time", format: "date" },
      ],
      rows,
      searchKeys: ["eventKind", "name", "model"],
      allowSort: new Set(["eventKind", "name", "sessionId", "chars", "thinkingChars", "cacheReadTokens", "durationMs", "ts"]),
      defaultSort: "ts",
    };
  }

  if (tab === "workflow") {
    const wfJoin = factScoped
      ? `WHERE ${sWhere.sql} AND EXISTS (SELECT 1 FROM analytics_facts f WHERE f.session_id = s.id AND ${fWhere.sql})`
      : `WHERE ${sWhere.sql}`;

    const rows = store.db
      .query(
        `SELECT
           s.id AS id,
           'session' AS kind,
           json_extract(s.record, '$.title') AS title,
           json_extract(s.record, '$.projectName') AS projectName,
           COALESCE(CAST(json_extract(s.record, '$.workflow.goals') AS INTEGER), 0) AS goals,
           COALESCE(CAST(json_extract(s.record, '$.workflow.completedGoals') AS INTEGER), 0) AS completedGoals,
           COALESCE(CAST(json_extract(s.record, '$.workflow.todos') AS INTEGER), 0) AS todos,
           COALESCE(CAST(json_extract(s.record, '$.workflow.completedTodos') AS INTEGER), 0) AS completedTodos,
           COALESCE(CAST(json_extract(s.record, '$.workflow.visionCalls') AS INTEGER), 0) AS visionCalls,
           COALESCE(CAST(json_extract(s.record, '$.workflow.uploads') AS INTEGER), 0) AS uploads,
           COALESCE(CAST(json_extract(s.record, '$.workflow.uploadBytes') AS INTEGER), 0) AS uploadBytes,
           s.last_activity AS lastActivity
         FROM analytics_sessions s
         ${wfJoin}`,
      )
      .all(...sWhere.params, ...(factScoped ? fWhere.params : [])) as AnalyticsRow[];

    return {
      columns: [
        { key: "title", label: "Session" },
        { key: "projectName", label: "Project" },
        { key: "goals", label: "Goals", format: "number" },
        { key: "completedGoals", label: "Completed Goals", format: "number" },
        { key: "todos", label: "Todos", format: "number" },
        { key: "completedTodos", label: "Completed Todos", format: "number" },
        { key: "visionCalls", label: "Vision Calls", format: "number" },
        { key: "uploads", label: "Uploads", format: "number" },
        { key: "uploadBytes", label: "Upload Bytes", format: "number" },
        { key: "lastActivity", label: "Last Activity", format: "date" },
      ],
      rows,
      searchKeys: ["title", "projectName"],
      allowSort: new Set(["title", "projectName", "goals", "todos", "visionCalls", "uploads", "uploadBytes", "lastActivity"]),
      defaultSort: "lastActivity",
    };
  }

  // Default: "sessions" and "overview"
  const rows = factScoped
    ? (store.db
        .query(
          `SELECT
             s.id AS id,
             'session' AS kind,
             json_extract(s.record, '$.title') AS title,
             json_extract(s.record, '$.projectName') AS projectName,
             s.worker AS worker,
             json_extract(s.record, '$.status') AS status,
             COALESCE(CAST(json_extract(s.record, '$.userTurns') AS INTEGER), 0) AS userTurns,
             COALESCE(CAST(json_extract(s.record, '$.assistantTurns') AS INTEGER), 0) AS assistantTurns,
             COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.total_tokens ELSE 0 END), 0) AS totalTokens,
             COALESCE(SUM(CASE WHEN f.kind = 'response' THEN f.cost_total ELSE 0 END), 0) AS cost,
             s.deleted_at AS deletedAt,
             s.last_activity AS lastActivity
           FROM analytics_sessions s
           JOIN analytics_facts f ON f.session_id = s.id
           WHERE ${sWhere.sql} AND ${fWhere.sql}
           GROUP BY s.id`,
        )
        .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[])
    : (store.db
        .query(
          `SELECT
             s.id AS id,
             'session' AS kind,
             json_extract(s.record, '$.title') AS title,
             json_extract(s.record, '$.projectName') AS projectName,
             s.worker AS worker,
             json_extract(s.record, '$.status') AS status,
             COALESCE(CAST(json_extract(s.record, '$.userTurns') AS INTEGER), 0) AS userTurns,
             COALESCE(CAST(json_extract(s.record, '$.assistantTurns') AS INTEGER), 0) AS assistantTurns,
             COALESCE(CAST(json_extract(s.record, '$.usage.totalTokens') AS REAL), 0) AS totalTokens,
             COALESCE(CAST(json_extract(s.record, '$.usage.cost.total') AS REAL), 0) AS cost,
             s.deleted_at AS deletedAt,
             s.last_activity AS lastActivity
           FROM analytics_sessions s
           WHERE ${sWhere.sql}`,
        )
        .all(...sWhere.params) as AnalyticsRow[]);

  return {
    columns: [
      { key: "title", label: "Session" },
      { key: "projectName", label: "Project" },
      { key: "worker", label: "Worker" },
      { key: "status", label: "Status" },
      { key: "totalTokens", label: "Tokens", format: "number" },
      { key: "cost", label: "Cost", format: "usd" },
      { key: "lastActivity", label: "Last Activity", format: "date" },
    ],
    rows,
    searchKeys: ["title", "projectName", "worker", "status"],
    allowSort: new Set(["title", "projectName", "worker", "status", "totalTokens", "cost", "lastActivity"]),
    defaultSort: "lastActivity",
  };
}

type SectionTable = {
  title: string;
  table: AnalyticsQueryResult["table"];
};

function queryTabSections(
  store: AnalyticsStore,
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
): SectionTable[] | undefined {
  const sWhere = buildSessionWhere(filters, "s");
  const fWhere = buildFactWhere(filters, "f");

  if (tab === "speed") {
    const toolRaw = store.db
      .query(
        `SELECT f.name AS name, f.duration_ms AS durationMs
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'tool' AND f.duration_ms IS NOT NULL AND f.name IS NOT NULL`,
      )
      .all(...sWhere.params, ...fWhere.params) as { name: string; durationMs: number }[];

    const byTool = new Map<string, number[]>();
    for (const r of toolRaw) {
      const arr = byTool.get(r.name) ?? [];
      arr.push(r.durationMs);
      byTool.set(r.name, arr);
    }

    const toolRows: AnalyticsRow[] = [];
    for (const [name, durations] of byTool.entries()) {
      durations.sort((a, b) => a - b);
      const sum = durations.reduce((acc, v) => acc + v, 0);
      toolRows.push({
        id: name,
        kind: "tool",
        name,
        calls: durations.length,
        avgDurationMs: sum / durations.length,
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
      });
    }
    toolRows.sort((a, b) => Number(b.p95DurationMs ?? 0) - Number(a.p95DurationMs ?? 0));
    const toolSlice = toolRows.slice(0, 100);

    const turnRaw = store.db
      .query(
        `SELECT f.session_id AS sessionId, f.duration_ms AS durationMs
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'turn' AND f.duration_ms IS NOT NULL`,
      )
      .all(...sWhere.params, ...fWhere.params) as { sessionId: number; durationMs: number }[];

    const bySession = new Map<number, number[]>();
    for (const r of turnRaw) {
      const arr = bySession.get(r.sessionId) ?? [];
      arr.push(r.durationMs);
      bySession.set(r.sessionId, arr);
    }

    const turnRows: AnalyticsRow[] = [];
    for (const [sessionId, durations] of bySession.entries()) {
      durations.sort((a, b) => a - b);
      const sum = durations.reduce((acc, v) => acc + v, 0);
      turnRows.push({
        id: sessionId,
        kind: "session",
        sessionId,
        turns: durations.length,
        avgDurationMs: sum / durations.length,
        p95DurationMs: percentile(durations, 95),
        maxDurationMs: durations[durations.length - 1] ?? null,
      });
    }
    turnRows.sort((a, b) => Number(b.p95DurationMs ?? 0) - Number(a.p95DurationMs ?? 0));
    const turnSlice = turnRows.slice(0, 100);

    return [
      {
        title: "Tool Latencies",
        table: {
          columns: [
            { key: "name", label: "Tool" },
            { key: "calls", label: "Calls", format: "number" },
            { key: "avgDurationMs", label: "Avg", format: "ms" },
            { key: "p50DurationMs", label: "Median (p50)", format: "ms" },
            { key: "p95DurationMs", label: "p95", format: "ms" },
          ],
          rows: toolSlice,
          total: toolRows.length,
          page: 0,
          limit: 100,
        },
      },
      {
        title: "Slowest Sessions (Turn Wall Times)",
        table: {
          columns: [
            { key: "sessionId", label: "Session", format: "number" },
            { key: "turns", label: "Turns", format: "number" },
            { key: "avgDurationMs", label: "Avg", format: "ms" },
            { key: "p95DurationMs", label: "p95", format: "ms" },
            { key: "maxDurationMs", label: "Max", format: "ms" },
          ],
          rows: turnSlice,
          total: turnRows.length,
          page: 0,
          limit: 100,
        },
      },
    ];
  }

  if (tab === "reliability") {
    const raw = store.db
      .query(
        `SELECT
           f.model AS model,
           ${providerExpr("f")} AS provider,
           f.served_model AS servedModel,
           f.error_reason AS errorReason,
           f.thinking_level AS thinkingLevel,
           COUNT(*) AS count,
           SUM(f.error) AS errors,
           SUM(f.aborted) AS aborts,
           SUM(CASE WHEN f.served_model IS NOT NULL AND f.model IS NOT NULL AND f.served_model != f.model AND f.served_model != (CASE WHEN instr(f.model, '/') > 0 THEN substr(f.model, instr(f.model, '/') + 1) ELSE f.model END) THEN 1 ELSE 0 END) AS mismatchCount
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response'
         GROUP BY f.model, provider, f.served_model, f.error_reason, f.thinking_level
         ORDER BY errors DESC, count DESC
         LIMIT 100`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    const rows = raw.map((r) => ({
      ...r,
      id: r.model ?? null,
      kind: r.model ? "model" : null,
      mismatchRate: Number(r.count) > 0 ? Number(r.mismatchCount ?? 0) / Number(r.count) : 0,
    }));

    return [
      {
        title: "Reliability by Model & Reason",
        table: {
          columns: [
            { key: "model", label: "Requested Model" },
            { key: "provider", label: "Provider" },
            { key: "servedModel", label: "Served Model" },
            { key: "errorReason", label: "Error Reason" },
            { key: "thinkingLevel", label: "Thinking" },
            { key: "count", label: "Count", format: "number" },
            { key: "errors", label: "Errors", format: "number" },
            { key: "aborts", label: "Aborts", format: "number" },
            { key: "mismatchRate", label: "Mismatch Rate", format: "percent" },
          ],
          rows,
          total: rows.length,
          page: 0,
          limit: 100,
        },
      },
    ];
  }

  if (tab === "context") {
    const cacheRaw = store.db
      .query(
        `SELECT
           f.model AS model,
           json_extract(f.data, '$.thinkingLevel') AS thinkingLevel,
           COUNT(*) AS responses,
           COALESCE(SUM(f.input_tokens), 0) AS inputTokens,
           COALESCE(SUM(f.cache_read), 0) AS cacheRead,
           COALESCE(SUM(f.cache_write), 0) AS cacheWrite,
           AVG(CAST(json_extract(f.data, '$.thinkingChars') AS REAL)) AS avgThinkingChars
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'response'
         GROUP BY f.model, thinkingLevel
         ORDER BY responses DESC
         LIMIT 100`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    const cacheRows = cacheRaw.map((r) => {
      const denom = Number(r.inputTokens ?? 0) + Number(r.cacheRead ?? 0) + Number(r.cacheWrite ?? 0);
      return {
        ...r,
        id: `${String(r.model ?? "")}|${String(r.thinkingLevel ?? "")}`,
        kind: "model",
        cacheHitRate: denom > 0 ? Number(r.cacheRead ?? 0) / denom : null,
      };
    });

    const compRows = store.db
      .query(
        `SELECT
           strftime('%Y-%m-%d', f.ts / 1000, 'unixepoch') AS day,
           COUNT(*) AS compactions,
           AVG(CAST(json_extract(f.data, '$.chars') AS REAL)) AS avgChars
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind = 'compaction' AND f.ts IS NOT NULL
         GROUP BY day
         ORDER BY day DESC
         LIMIT 100`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    return [
      {
        title: "Cache & Thinking by Model",
        table: {
          columns: [
            { key: "model", label: "Model" },
            { key: "thinkingLevel", label: "Thinking" },
            { key: "responses", label: "Responses", format: "number" },
            { key: "inputTokens", label: "Input", format: "number" },
            { key: "cacheRead", label: "Cache Read", format: "number" },
            { key: "cacheWrite", label: "Cache Write", format: "number" },
            { key: "cacheHitRate", label: "Cache Hit", format: "percent" },
            { key: "avgThinkingChars", label: "Avg Thinking Chars", format: "number" },
          ],
          rows: cacheRows,
          total: cacheRows.length,
          page: 0,
          limit: 100,
        },
      },
      {
        title: "Compactions by Day",
        table: {
          columns: [
            { key: "day", label: "Day" },
            { key: "compactions", label: "Compactions", format: "number" },
            { key: "avgChars", label: "Avg Chars", format: "number" },
          ],
          rows: compRows,
          total: compRows.length,
          page: 0,
          limit: 100,
        },
      },
    ];
  }

  if (tab === "workflow") {
    const wfEvents = store.db
      .query(
        `SELECT
           f.key AS id,
           'event' AS kind,
           f.kind AS eventKind,
           f.name AS name,
           f.session_id AS sessionId,
           f.duration_ms AS durationMs,
           f.ts AS ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE ${sWhere.sql} AND ${fWhere.sql} AND f.kind IN ('wait', 'quota_wait', 'model_switch', 'undo')
         ORDER BY f.ts DESC
         LIMIT 100`,
      )
      .all(...sWhere.params, ...fWhere.params) as AnalyticsRow[];

    return [
      {
        title: "Workflow Events (Wait / Switch / Undo)",
        table: {
          columns: [
            { key: "eventKind", label: "Type" },
            { key: "name", label: "Name" },
            { key: "sessionId", label: "Session", format: "number" },
            { key: "durationMs", label: "Recorded wait (ms)", format: "ms" },
            { key: "ts", label: "Time", format: "date" },
          ],
          rows: wfEvents,
          total: wfEvents.length,
          page: 0,
          limit: 100,
        },
      },
    ];
  }

  return undefined;
}

function queryInternal(
  store: AnalyticsStore,
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
  paginate: boolean,
): AnalyticsQueryResult {
  const start = Date.now();
  const notes: string[] = [];

  if (hasFactFilters(filters)) {
    notes.push(
      "Filtered totals are computed from matching response facts and exclude undated compaction costs.",
    );
  }
  if (tab === "models") {
    notes.push(
      "Model-level totals are computed from response facts only and exclude undated compaction costs.",
    );
  }
  if (tab === "models") {
    notes.push(
      hasFactFilters(filters)
        ? "Models table shows response-fact usage matching the active filters (not the full session ledger)."
        : "Models table shows complete session modelUsage ledger totals for all-time queries (falling back to response facts only where modelUsage is absent).",
    );
  }
  if (tab === "workflow") {
    notes.push(
      "Workflow counters (goals, todos, visionCalls, uploads, uploadBytes) reflect latest session state, not historical counts. Recorded wait durations reflect future recorded waits; historical wait durations are unavailable, and quota_wait planned reset timestamps are not elapsed durations.",
    );
  }
  const key = scopeKey(filters);
  const sections = memo(store, `sections:${tab}:${key}`, () => queryTabSections(store, tab, filters));
  if (sections && sections.length > 0) {
    notes.push("Supplemental sections are capped at top 100 rows.");
  }
  if (tab === "context") {
    notes.push(
      "Context metrics (chars, thinkingChars, cacheReadTokens) are null when not recorded by the provider or fact.",
    );
  }
  if (tab === "delegation") {
    notes.push(
      "Delegation source/target session IDs and outcome are shown when recorded in fact metadata and null when absent.",
    );
  }

  let previous: AnalyticsRow | undefined;
  if (filters.compare) {
    if (filters.from === undefined || filters.to === undefined) {
      notes.push("Compare mode is disabled on all-time queries without finite from/to bounds.");
    } else {
      const span = filters.to - filters.from;
      const prevFilters: AnalyticsFilters = {
        ...filters,
        from: filters.from - span,
        to: filters.from,
        compare: false,
      };
      previous = memo(store, `summary:${scopeKey(prevFilters)}`, () => computeSummary(store, prevFilters));
    }
  }

  const summary = memo(store, `summary:${key}`, () => computeSummary(store, filters));
  const series = memo(store, `series:${tab}:${key}`, () => buildTimeSeries(store, tab, filters));
  const tableData = memo(store, `table:${tab}:${key}`, () => queryTabTable(store, tab, filters));
  const searched = filterBySearch(tableData.rows, filters.search, tableData.searchKeys);
  const sorted = sortRows(
    searched,
    filters.sort,
    tableData.allowSort,
    tableData.defaultSort,
    "desc",
  );

  const total = sorted.length;
  const rows = paginate
    ? sorted.slice(filters.page * filters.limit, (filters.page + 1) * filters.limit)
    : sorted;

  const metaRow = store.db
    .query(`SELECT value FROM analytics_meta WHERE key = 'indexed_at'`)
    .get() as { value: string } | null;

  return {
    generatedAt: new Date().toISOString(),
    tab,
    filters,
    summary,
    series,
    table: {
      columns: tableData.columns,
      rows,
      total,
      page: filters.page,
      limit: filters.limit,
    },
    ...(sections ? { sections } : {}),
    previous,
    notes,
    performance: {
      queryMs: Date.now() - start,
      sessionsScanned: 0,
      entriesScanned: 0,
      indexedAt: metaRow?.value ?? null,
    },
  };
}

export function queryAnalytics(
  store: AnalyticsStore,
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
): AnalyticsQueryResult {
  return queryInternal(store, tab, filters, true);
}

export function analyticsFilterOptions(store: AnalyticsStore): AnalyticsFilterOptions {
  const projectRows = store.db
    .query(
      `SELECT DISTINCT
         project_id AS value,
         COALESCE(json_extract(record, '$.projectName'), CAST(project_id AS TEXT)) AS label
       FROM analytics_sessions
       ORDER BY label ASC`,
    )
    .all() as { value: number; label: string }[];

  const modelRows = store.db
    .query(
      `SELECT DISTINCT model AS value FROM analytics_facts WHERE model IS NOT NULL ORDER BY model ASC`,
    )
    .all() as { value: string }[];

  const providerRows = store.db
    .query(
      // Same rule as providerExpr (explicit data.provider, else model prefix) without a second JSON parse per fact:
      // explicit providers in one pass, plus the prefix of each model that has a fact without one (index probe).
      `SELECT value FROM (
         SELECT json_extract(data, '$.provider') AS value FROM analytics_facts WHERE json_extract(data, '$.provider') IS NOT NULL
         UNION
         SELECT substr(m.model, 1, instr(m.model, '/') - 1) FROM (SELECT DISTINCT model FROM analytics_facts WHERE instr(model, '/') > 0) m
         WHERE EXISTS (SELECT 1 FROM analytics_facts f WHERE f.model = m.model AND json_extract(f.data, '$.provider') IS NULL)
       )
       ORDER BY value ASC`,
    )
    .all() as { value: string }[];

  const workerRows = store.db
    .query(
      `SELECT DISTINCT worker AS value FROM analytics_sessions WHERE worker IS NOT NULL ORDER BY worker ASC`,
    )
    .all() as { value: string }[];

  const cwdRows = store.db
    .query(
      `SELECT DISTINCT cwd AS value FROM analytics_sessions WHERE cwd IS NOT NULL ORDER BY cwd ASC`,
    )
    .all() as { value: string }[];

  return {
    projects: projectRows.map((r) => ({ value: String(r.value), label: r.label })),
    models: modelRows.map((r) => ({ value: r.value, label: r.value })),
    providers: providerRows.map((r) => ({ value: r.value, label: r.value })),
    workers: workerRows.map((r) => ({ value: r.value, label: r.value })),
    cwds: cwdRows.map((r) => ({ value: r.value, label: r.value })),
  };
}

export function analyticsDetail(
  store: AnalyticsStore,
  _tab: AnalyticsTab,
  kind: string,
  id: string,
  filters: AnalyticsFilters,
): { title: string; sections: { title: string; rows: AnalyticsRow[] }[]; notes: string[] } | undefined {
  const sWhere = buildSessionWhere(filters, "s");
  const fWhere = buildFactWhere(filters, "f");

  if (kind === "session") {
    const sessionId = Number(id);
    if (!Number.isSafeInteger(sessionId)) return undefined;
    const row = store.db
      .query(`SELECT s.record FROM analytics_sessions s WHERE s.id = ? AND ${sWhere.sql}`)
      .get(sessionId, ...sWhere.params) as { record: string } | null;
    if (!row) return undefined;
    const rec = JSON.parse(row.record) as Record<string, unknown>;
    const facts = store.db
      .query(
        `SELECT f.key AS id, f.kind, f.name, f.model, f.source, f.duration_ms AS durationMs, f.error, f.aborted, f.ts
         FROM analytics_facts f
         WHERE f.session_id = ? AND ${fWhere.sql}
         ORDER BY f.ts ASC
         LIMIT 200`,
      )
      .all(sessionId, ...fWhere.params) as AnalyticsRow[];

    if (hasFactFilters(filters) && facts.length === 0) return undefined;

    // Subtree cost rollup with cycle deduplication (delegated children + fork parentId, scoped to active filters)
    const factScoped = hasFactFilters(filters);
    const visited = new Set<number>();
    const queue: number[] = [sessionId];
    let subtreeTokens = 0;
    let subtreeCost = 0;
    let subtreeSessions = 0;

    while (queue.length > 0) {
      const currId = queue.shift()!;
      if (visited.has(currId)) continue;
      visited.add(currId);

      // Check if currId matches active session filters
      const sMatch = store.db
        .query(
          `SELECT id,
             COALESCE(CAST(json_extract(record, '$.usage.totalTokens') AS REAL), 0) AS totalTokens,
             COALESCE(CAST(json_extract(record, '$.usage.cost.total') AS REAL), 0) AS cost
           FROM analytics_sessions s
           WHERE s.id = ? AND ${sWhere.sql}`,
        )
        .get(currId, ...sWhere.params) as { id: number; totalTokens: number; cost: number } | null;

      if (sMatch) {
        if (factScoped) {
          const fAgg = store.db
            .query(
              `SELECT
                 COUNT(*) AS cnt,
                 COALESCE(SUM(CAST(json_extract(f.usage, '$.totalTokens') AS REAL)), 0) AS totalTokens,
                 COALESCE(SUM(CAST(json_extract(f.usage, '$.cost.total') AS REAL)), 0) AS cost
               FROM analytics_facts f
               WHERE f.session_id = ? AND f.kind = 'response' AND ${fWhere.sql}`,
            )
            .get(currId, ...fWhere.params) as { cnt: number; totalTokens: number; cost: number } | null;
          if (fAgg && fAgg.cnt > 0) {
            subtreeSessions++;
            subtreeTokens += fAgg.totalTokens ?? 0;
            subtreeCost += fAgg.cost ?? 0;
          }
        } else {
          subtreeSessions++;
          subtreeTokens += sMatch.totalTokens ?? 0;
          subtreeCost += sMatch.cost ?? 0;
        }
      }

      // Traverse fork parentId -> child
      const forkChildren = store.db
        .query(
          `SELECT id FROM analytics_sessions WHERE CAST(json_extract(record, '$.parentId') AS INTEGER) = ?`,
        )
        .all(currId) as { id: number }[];
      for (const c of forkChildren) {
        if (!visited.has(c.id)) queue.push(c.id);
      }

      // Traverse delegation facts (name = 'delegate.child') -> targetSessionId
      const delChildren = store.db
        .query(
          `SELECT DISTINCT CAST(json_extract(data, '$.targetSessionId') AS INTEGER) AS targetId
           FROM analytics_facts
           WHERE session_id = ? AND kind = 'delegation' AND name = 'delegate.child'
             AND json_extract(data, '$.targetSessionId') IS NOT NULL`,
        )
        .all(currId) as { targetId: number }[];
      for (const c of delChildren) {
        if (c.targetId && !visited.has(c.targetId)) queue.push(c.targetId);
      }
    }

    const usage = (rec.usage && typeof rec.usage === "object" ? rec.usage : {}) as Record<string, unknown>;
    const usageCost = (usage.cost && typeof usage.cost === "object" ? usage.cost : {}) as Record<string, unknown>;

    return {
      title: String(rec.title ?? `Session #${sessionId}`),
      sections: [
        {
          title: "Session Metadata",
          rows: [
            {
              id: sessionId,
              title: (rec.title as AnalyticsValue) ?? null,
              parentId: (rec.parentId as AnalyticsValue) ?? null,
              projectName: (rec.projectName as AnalyticsValue) ?? null,
              worker: (rec.worker as AnalyticsValue) ?? null,
              cwd: (rec.cwd as AnalyticsValue) ?? null,
              status: (rec.status as AnalyticsValue) ?? null,
              statusReason: (rec.statusReason as AnalyticsValue) ?? null,
              createdAt: (rec.createdAt as AnalyticsValue) ?? null,
              lastActivity: (rec.lastActivity as AnalyticsValue) ?? null,
              deletedAt: (rec.deletedAt as AnalyticsValue) ?? null,
              archived: (rec.archived as AnalyticsValue) ?? null,
              pinned: (rec.pinned as AnalyticsValue) ?? null,
            },
          ],
        },
        {
          title: "Latest session ledger",
          rows: [
            {
              input: (usage.input as AnalyticsValue) ?? null,
              output: (usage.output as AnalyticsValue) ?? null,
              cacheRead: (usage.cacheRead as AnalyticsValue) ?? null,
              cacheWrite: (usage.cacheWrite as AnalyticsValue) ?? null,
              cacheWrite1h: (usage.cacheWrite1h as AnalyticsValue) ?? null,
              reasoning: (usage.reasoning as AnalyticsValue) ?? null,
              totalTokens: (usage.totalTokens as AnalyticsValue) ?? null,
              costInput: (usageCost.input as AnalyticsValue) ?? null,
              costOutput: (usageCost.output as AnalyticsValue) ?? null,
              costCacheRead: (usageCost.cacheRead as AnalyticsValue) ?? null,
              costCacheWrite: (usageCost.cacheWrite as AnalyticsValue) ?? null,
              costTotal: (usageCost.total as AnalyticsValue) ?? null,
            },
          ],
        },
        {
          title: "Subtree Cost Rollup",
          rows: [
            {
              id: sessionId,
              subtreeSessions,
              subtreeTotalTokens: subtreeTokens,
              subtreeCost,
            },
          ],
        },
        {
          title: "Facts",
          rows: facts,
        },
      ],
      notes: [
        "Session Metadata and Latest session ledger reflect the latest full session record (unscoped to date/fact filters). Subtree Cost Rollup respects active session and fact filters.",
      ],
    };
  }

  if (kind === "model") {
    const facts = store.db
      .query(
        `SELECT f.key AS id, f.session_id AS sessionId, f.kind, f.name, f.duration_ms AS durationMs, f.error, f.ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE f.model = ? AND ${sWhere.sql} AND ${fWhere.sql}
         ORDER BY f.ts DESC
         LIMIT 200`,
      )
      .all(id, ...sWhere.params, ...fWhere.params) as AnalyticsRow[];
    const aggregateRow = queryTabTable(store, "models", filters).rows.find((r) => r.model === id);
    if (facts.length === 0 && !aggregateRow) return undefined;
    const sections: { title: string; rows: AnalyticsRow[] }[] = [];
    if (aggregateRow) {
      sections.push({ title: "Recorded usage", rows: [aggregateRow] });
    }
    sections.push({ title: "Recent Facts", rows: facts });
    return {
      title: `Model: ${id}`,
      sections,
      notes: [],
    };
  }

  if (kind === "tool" || kind === "skill") {
    const facts = store.db
      .query(
        `SELECT f.key AS id, f.session_id AS sessionId, f.kind, f.model, f.source, f.duration_ms AS durationMs, f.error, f.ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE f.name = ? AND f.kind = ? AND ${sWhere.sql} AND ${fWhere.sql}
         ORDER BY f.ts DESC
         LIMIT 200`,
      )
      .all(id, kind, ...sWhere.params, ...fWhere.params) as AnalyticsRow[];
    if (facts.length === 0) return undefined;
    return {
      title: `${kind === "skill" ? "Skill" : "Tool"}: ${id}`,
      sections: [{ title: "Recent Calls", rows: facts }],
      notes: [],
    };
  }

  if (kind === "project" || kind === "repo") {
    let projectId: number;
    let workerFilter: string | null = null;
    let cwdFilter: string | null = null;

    if (kind === "repo") {
      const parts = id.split("|");
      projectId = Number(parts[0]);
      workerFilter = parts[1] ?? "";
      cwdFilter = parts.slice(2).join("|");
    } else {
      projectId = Number(id);
    }

    if (!Number.isSafeInteger(projectId)) return undefined;
    const factScoped = hasFactFilters(filters);
    const repoClause =
      kind === "repo"
        ? ` AND COALESCE(s.worker, '') = ? AND COALESCE(s.cwd, '') = ?`
        : "";
    const repoParams = kind === "repo" ? [workerFilter!, cwdFilter!] : [];

    const sessions = factScoped
      ? (store.db
          .query(
            `SELECT DISTINCT s.id, json_extract(s.record, '$.title') AS title, s.worker, s.cwd, s.last_activity AS lastActivity
             FROM analytics_sessions s
             JOIN analytics_facts f ON f.session_id = s.id
             WHERE s.project_id = ?${repoClause} AND ${sWhere.sql} AND ${fWhere.sql}
             ORDER BY s.last_activity DESC
             LIMIT 200`,
          )
          .all(projectId, ...repoParams, ...sWhere.params, ...fWhere.params) as AnalyticsRow[])
      : (store.db
          .query(
            `SELECT s.id, json_extract(s.record, '$.title') AS title, s.worker, s.cwd, s.last_activity AS lastActivity
             FROM analytics_sessions s
             WHERE s.project_id = ?${repoClause} AND ${sWhere.sql}
             ORDER BY s.last_activity DESC
             LIMIT 200`,
          )
          .all(projectId, ...repoParams, ...sWhere.params) as AnalyticsRow[]);
    if (sessions.length === 0) return undefined;
    return {
      title: kind === "repo" ? `Repo: ${cwdFilter || workerFilter || `#${projectId}`}` : `Project #${projectId}`,
      sections: [{ title: "Sessions", rows: sessions }],
      notes: [],
    };
  }

  if (kind === "event") {
    const fact = store.db
      .query(
        `SELECT f.key AS id, f.session_id AS sessionId, f.kind, f.name, f.model, f.source, f.duration_ms AS durationMs, f.error, f.aborted, f.ts
         FROM analytics_facts f
         JOIN analytics_sessions s ON s.id = f.session_id
         WHERE f.key = ? AND ${sWhere.sql} AND ${fWhere.sql}`,
      )
      .get(id, ...sWhere.params, ...fWhere.params) as AnalyticsRow | null;
    if (!fact) return undefined;
    return {
      title: `Event: ${String(fact.name ?? fact.kind ?? id)}`,
      sections: [{ title: "Event", rows: [fact] }],
      notes: [],
    };
  }

  return undefined;
}

function csvCell(val: AnalyticsValue): string {
  if (val === null || val === undefined) return "";
  let str = String(val);
  let guarded = false;
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
    guarded = true;
  }
  if (guarded || /[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function analyticsExport(
  store: AnalyticsStore,
  tab: AnalyticsTab,
  filters: AnalyticsFilters,
  format: "csv" | "json",
): string {
  const result = queryInternal(store, tab, filters, false);
  const rows = result.table.rows;

  if (format === "json") {
    return JSON.stringify(rows, null, 2);
  }

  const cols = result.table.columns;
  const header = cols.map((c) => csvCell(c.key)).join(",");
  const lines = rows.map((row) =>
    cols.map((c) => csvCell(row[c.key] ?? null)).join(","),
  );
  return [header, ...lines].join("\n");
}
