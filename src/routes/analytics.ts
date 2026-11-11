import type { Hono } from "hono";
import { legacyAnalyticsSnapshot } from "../analytics/compatibility.js";
import type { RouteCtx } from "./context.js";
import { analyticsService } from "../analytics/index.js";
import { ANALYTICS_TABS, type AnalyticsTab } from "../analytics/types.js";
import { analyticsDetail, analyticsExport, analyticsFilterOptions, parseAnalyticsFilters, queryAnalytics } from "../analytics/query.js";

export function registerAnalytics(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err } = ctx;
  const service = analyticsService(harness, opts.conversations);
  const analytics = async (refresh = false) => {
    if (refresh) await service.refresh();
    else await service.ready();
    return legacyAnalyticsSnapshot(service.store);
  };
  const tabOf = (value: string): AnalyticsTab => {
    if (!(ANALYTICS_TABS as readonly string[]).includes(value)) throw new Error("Unknown analytics tab");
    return value as AnalyticsTab;
  };
  app.get("/v1/analytics/v2/filters", async c => {
    await service.ready();
    c.header("Cache-Control", "no-store");
    return c.json(analyticsFilterOptions(service.store));
  });
  app.get("/v1/analytics/v2/:tab/export", async c => {
    let filters, tab;
    try { filters = parseAnalyticsFilters(new URL(c.req.url).searchParams); tab = tabOf(c.req.param("tab")); }
    catch (error) { return err(c, 400, (error as Error).message); }
    const format = c.req.query("format") ?? "csv";
    if (format !== "csv" && format !== "json") return err(c, 400, "Invalid analytics export format");
    await service.ready();
    let body: string;
    try { body = analyticsExport(service.store, tab, filters, format); }
    catch (error) { return err(c, 400, (error as Error).message); }
    c.header("Cache-Control", "no-store");
    c.header("Content-Disposition", `attachment; filename="analytics-${tab}.${format}"`);
    return c.body(body, 200, { "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8" });
  });
  app.get("/v1/analytics/v2/:tab/:kind/:id", async c => {
    let filters, tab;
    try { filters = parseAnalyticsFilters(new URL(c.req.url).searchParams); tab = tabOf(c.req.param("tab")); }
    catch (error) { return err(c, 400, (error as Error).message); }
    await service.ready();
    const detail = analyticsDetail(service.store, tab, c.req.param("kind"), c.req.param("id"), filters);
    c.header("Cache-Control", "no-store");
    return detail ? c.json(detail) : err(c, 404, "Analytics detail not found in the selected scope");
  });
  app.get("/v1/analytics/v2/:tab", async c => {
    let filters, tab;
    try { filters = parseAnalyticsFilters(new URL(c.req.url).searchParams); tab = tabOf(c.req.param("tab")); }
    catch (error) { return err(c, 400, (error as Error).message); }
    await service.ready();
    let result;
    try { result = queryAnalytics(service.store, tab, filters); }
    catch (error) { return err(c, 400, (error as Error).message); }
    result.performance.indexedAt = service.indexedAt ?? result.performance.indexedAt;
    c.header("Cache-Control", "no-store");
    c.header("Server-Timing", `analytics;dur=${result.performance.queryMs.toFixed(2)}`);
    return c.json(result);
  });
  app.get("/v1/analytics", async (c) => {
    const started = performance.now();
    const snapshot = await analytics(c.req.query("refresh") === "true");
    const readMs = performance.now() - started;
    const payload =
      c.req.query("view") === "overview"
        ? { ...snapshot, sessionsList: snapshot.sessionsList.slice(0, 5) }
        : snapshot;
    const serializeStarted = performance.now();
    const body = JSON.stringify(payload);
    c.header(
      "Server-Timing",
      `analytics;dur=${readMs.toFixed(2)}, serialize;dur=${(performance.now() - serializeStarted).toFixed(2)}`,
    );
    c.header("Cache-Control", "no-store");
    return c.body(body, 200, { "Content-Type": "application/json; charset=UTF-8" });
  });

  app.get("/v1/analytics/sessions", async (c) => {
    const pageRaw = c.req.query("page") ?? "0",
      limitRaw = c.req.query("limit") ?? "20";
    const page = Number(pageRaw),
      limit = Number(limitRaw);
    const sorts = ["title", "status", "tokens", "cost", "hitRate", "responses", "duration", "activity"].flatMap(
      (key) => [key + "Asc", key + "Desc"],
    );
    const sort = c.req.query("sort") ?? "tokensDesc";
    if (
      !/^\d+$/.test(pageRaw) ||
      !Number.isSafeInteger(page) ||
      page < 0 ||
      !/^\d+$/.test(limitRaw) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !sorts.includes(sort)
    ) {
      return err(c, 400, "Invalid analytics pagination or sort");
    }
    const started = performance.now();
    const snapshot = await analytics(c.req.query("refresh") === "true");
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const status = c.req.query("status") ?? "";
    const rows = snapshot.sessionsList.filter(
      (row) =>
        (!status || row.status === status) &&
        (!search || row.id.includes(search) || row.title?.toLowerCase().includes(search)),
    );
    const sortValues: Record<string, (row: (typeof rows)[number]) => string | number | null> = {
      title: (row) => row.title || "Untitled session",
      status: (row) => row.status,
      tokens: (row) => row.usage.totalTokens,
      cost: (row) => row.usage.cost.total,
      hitRate: (row) => row.usage.cacheHitRate,
      responses: (row) => row.responses,
      duration: (row) => row.durationMs,
      activity: (row) => row.lastActivity,
    };
    const value = sortValues[sort.replace(/(Asc|Desc)$/, "")]!; // Validated against sorts above.
    rows.sort((a, b) => {
      const left = value(a),
        right = value(b);
      // Unknown values belong last, regardless of the requested direction.
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      const order =
        left == null || right == null
          ? 0
          : typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right), undefined, { numeric: true });
      return (sort.endsWith("Desc") ? -order : order) || a.id.localeCompare(b.id, undefined, { numeric: true });
    });
    const actualPage = Math.min(page, Math.max(0, Math.ceil(rows.length / limit) - 1));
    c.header("Server-Timing", `analytics;dur=${(performance.now() - started).toFixed(2)}`);
    c.header("Cache-Control", "no-store");
    return c.json({
      generatedAt: snapshot.generatedAt,
      sessions: rows.slice(actualPage * limit, (actualPage + 1) * limit),
      total: rows.length,
      allTotal: snapshot.sessions,
      statusBreakdown: snapshot.statusBreakdown,
      page: actualPage,
      limit,
    });
  });
}
