import type { Hono } from "hono";
import { createAnalyticsReader } from "../analytics.js";
import type { RouteCtx } from "./context.js";

export function registerAnalytics(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err } = ctx;
  const analytics = createAnalyticsReader(harness, opts.models);
  // Delay the first scan until startup settles. The scan shares its in-flight work
  // with requests and releases the harness queue between conversations.
  const warmup = setTimeout(() => {
    void analytics().catch(() => { console.warn("analytics warm-up failed; the next request can retry"); });
  }, 30_000);
  warmup.unref();

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
