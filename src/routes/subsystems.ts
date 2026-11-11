import type { Hono, Context as HonoContext } from "hono";
import { scanSkills, linkedFiles } from "../skills.js";
import type { RouteCtx } from "./context.js";

export function registerSubsystems(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;

  const attempt = async (c: HonoContext, fn: () => Promise<unknown>, status: 200 | 201 = 200) => {
    try {
      return c.json((await fn()) ?? { ok: true }, status);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  };

  // ---- MCP servers: daemon mutations use the shared settings file ----
  const mcpOff = (c: HonoContext) => (opts.mcp ? undefined : err(c, 404, "mcp disabled"));

  app.get("/v1/mcp", (c) => mcpOff(c) ?? c.json({ servers: opts.mcp!.list() }));

  app.post("/v1/mcp", async (c) => mcpOff(c) ?? attempt(c, async () => opts.mcp!.add(await c.req.json().catch(() => ({}))), 201));

  app.patch("/v1/mcp/:name", async (c) => {
    const no = mcpOff(c);
    if (no) return no;
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") return err(c, 400, "enabled (boolean) required");
    return attempt(c, () => opts.mcp!.setEnabled(c.req.param("name"), b.enabled as boolean));
  });

  app.delete("/v1/mcp/:name", async (c) =>
    mcpOff(c) ?? attempt(c, () => opts.mcp!.remove(c.req.param("name"))),
  );

  // ---- cron ----
  const cron = (c: HonoContext) => (opts.store ? undefined : err(c, 404, "cron disabled"));

  app.get("/v1/cron", (c) => {
    if (!opts.store) return err(c, 404, "cron disabled");
    const jobs = opts.store.listJobs().map((j) => ({
      ...j,
      lastRun: opts.store!.lastRun(j.id) ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));
    return c.json({
      jobs,
      runs: c.req.query("summary") === "1" ? [] : opts.store.runs(undefined, 50),
      unreadCount: opts.store.unreadCount(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  app.post("/v1/cron", async (c) => {
    const no = cron(c);
    if (no) return no;
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (!b || typeof b !== "object" || Array.isArray(b)) return err(c, 400, "invalid body");
    const allowed = ["name", "expr", "prompt", "reportPolicy", "graceMs", "timeoutMs", "retries"];
    const keys = Object.keys(b);
    if (!keys.length || keys.some((k) => !allowed.includes(k))) return err(c, 400, "invalid or unknown fields");
    if (
      !b.name ||
      typeof b.name !== "string" ||
      !b.name.trim() ||
      !b.expr ||
      typeof b.expr !== "string" ||
      !b.prompt ||
      typeof b.prompt !== "string" ||
      !b.prompt.trim()
    )
      return err(c, 400, "name, expr and prompt required");
    if (b.reportPolicy !== undefined && !["always", "changes", "failures"].includes(b.reportPolicy))
      return err(c, 400, "invalid report policy");
    if (opts.store!.listJobs().some((j) => j.name === b.name)) return err(c, 409, "a job with that name exists");
    try {
      const job = opts.store!.addJob(b.name, b.expr, b.prompt, undefined, Date.now(), b.reportPolicy, {
        graceMs: b.graceMs,
        timeoutMs: b.timeoutMs,
        retries: b.retries,
      });
      opts.scheduler?.rearm();
      return c.json(job, 201);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });

  app.patch("/v1/cron/:id", async (c) => {
    const no = cron(c);
    if (no) return no;
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such job");
    const existing = opts.store!.getJob(id);
    if (!existing) return err(c, 404, "no such job");
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (!b || typeof b !== "object" || Array.isArray(b)) return err(c, 400, "invalid body");
    const allowed = ["name", "expr", "prompt", "enabled", "reportPolicy", "graceMs", "timeoutMs", "retries"];
    const keys = Object.keys(b);
    if (!keys.length || keys.some((k) => !allowed.includes(k))) return err(c, 400, "invalid or unknown fields");
    if ("name" in b && (typeof b.name !== "string" || !b.name.trim())) return err(c, 400, "invalid name");
    if ("expr" in b && (typeof b.expr !== "string" || !b.expr.trim())) return err(c, 400, "invalid expr");
    if ("prompt" in b && b.prompt !== undefined) {
      if (typeof b.prompt !== "string") return err(c, 400, "invalid prompt");
      if (!b.prompt.trim() && !existing.execution) {
        return err(c, 400, "prompt required");
      }
    }
    if ("enabled" in b && typeof b.enabled !== "boolean") return err(c, 400, "enabled must be boolean");
    if ("reportPolicy" in b && !["always", "changes", "failures"].includes(b.reportPolicy))
      return err(c, 400, "invalid report policy");

    if ("name" in b && b.name !== existing.name) {
      if (opts.store!.listJobs().some((j) => j.name === b.name && j.id !== id))
        return err(c, 409, "a job with that name exists");
    }

    try {
      const updated = opts.store!.updateJob(id, b);
      opts.scheduler?.rearm();
      return c.json(updated);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("running")) return err(c, 409, msg);
      if (msg.includes("interval")) return err(c, 400, msg);
      return err(c, 400, msg);
    }
  });

  app.post("/v1/cron/:id/run", (c) => {
    const no = cron(c);
    if (no) return no;
    if (!opts.scheduler) return err(c, 404, "scheduler disabled");
    try {
      return c.json(opts.scheduler.runNow(Number(c.req.param("id"))), 202);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("already running")) return err(c, 409, msg);
      return err(c, 404, msg);
    }
  });

  app.delete("/v1/cron/:id", (c) => {
    const no = cron(c);
    if (no) return no;
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1 || !opts.store!.getJob(id)) return err(c, 404, "no such job");
    try {
      opts.store!.removeJob(id);
      opts.scheduler?.rearm();
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("running")) return err(c, 409, msg);
      return err(c, 400, msg);
    }
  });

  app.get("/v1/cron/reports", (c) => {
    const no = cron(c);
    if (no) return no;
    const history = c.req.query("history") === "1" || c.req.query("history") === "true";
    const jobId = c.req.query("jobId") !== undefined ? Number(c.req.query("jobId")) : undefined;
    const before = c.req.query("before") !== undefined ? Number(c.req.query("before")) : undefined;
    const limit = c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : 50;
    const order = c.req.query("order");
    const cursorStr = c.req.query("cursor");

    if (order !== undefined && order !== "attention") return err(c, 400, "invalid order");
    if (order === "attention" && history) return err(c, 400, "order=attention is only supported for inbox");
    if (cursorStr !== undefined && order !== "attention") return err(c, 400, "cursor is only supported with order=attention");
    if (order === "attention" && before !== undefined) return err(c, 400, "before is not supported with order=attention");

    let parsedCursor: { rank: number; id: number } | undefined;
    if (cursorStr !== undefined) {
      const parts = cursorStr.split(":");
      if (parts.length !== 2 || (parts[0] !== "0" && parts[0] !== "1")) {
        return err(c, 400, "invalid cursor format");
      }
      const rank = Number(parts[0]);
      const id = Number(parts[1]);
      if (!Number.isSafeInteger(id) || id < 1) {
        return err(c, 400, "invalid cursor id");
      }
      parsedCursor = { rank, id };
    }

    if (jobId !== undefined && (!Number.isSafeInteger(jobId) || jobId < 1)) return err(c, 400, "invalid jobId");
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      return err(c, 400, "invalid before cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err(c, 400, "invalid limit (1..100)");
    const reports = opts.store!.reports({ history, jobId, before, limit, order: order as "attention" | undefined, cursor: parsedCursor });

    let nextCursor: string | null = null;
    if (order === "attention" && reports.length === limit && reports.length > 0) {
      const last = reports[reports.length - 1];
      if (last) {
        const lastRank = last.status === "error" ? 0 : 1;
        nextCursor = `${lastRank}:${last.id}`;
      }
    }

    return c.json({
      reports,
      unreadCount: opts.store!.unreadCount(),
      ...(order === "attention" ? { nextCursor } : {}),
    });
  });

  app.post("/v1/cron/reports/read-all", (c) => {
    const no = cron(c);
    if (no) return no;
    try {
      const count = opts.store!.markAllReportsRead();
      return c.json({ ok: true, count, unreadCount: opts.store!.unreadCount() });
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });

  app.get("/v1/cron/runs", (c) => {
    const no = cron(c);
    if (no) return no;
    const history = c.req.query("history") === "1" || c.req.query("history") === "true";
    const jobId = c.req.query("jobId") !== undefined ? Number(c.req.query("jobId")) : undefined;
    const status = c.req.query("status") as any;
    const before = c.req.query("before") !== undefined ? Number(c.req.query("before")) : undefined;
    const limit = c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : 50;
    if (jobId !== undefined && (!Number.isSafeInteger(jobId) || jobId < 1)) return err(c, 400, "invalid jobId");
    if (status !== undefined && !["running", "ok", "error", "skipped"].includes(status))
      return err(c, 400, "invalid status");
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      return err(c, 400, "invalid before cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err(c, 400, "invalid limit (1..100)");
    const runs = opts.store!.queryRuns({ history, jobId, status, before, limit });
    return c.json({ runs });
  });

  app.get("/v1/cron/runs/:runId", (c) => {
    const no = cron(c);
    if (no) return no;
    const runId = Number(c.req.param("runId"));
    if (!Number.isSafeInteger(runId) || runId < 1) return err(c, 404, "no such run");
    const r = opts.store!.getRun(runId);
    if (!r) return err(c, 404, "no such run");
    return c.json(r);
  });

  app.patch("/v1/cron/reports/:runId", async (c) => {
    const no = cron(c);
    if (no) return no;
    const runId = Number(c.req.param("runId"));
    if (!Number.isSafeInteger(runId) || runId < 1) return err(c, 404, "no such run");
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.read !== "boolean" ||
      Object.keys(b).some((key) => key !== "read")
    )
      return err(c, 400, "read (boolean) required");
    try {
      const updated = opts.store!.markRead(runId, b.read);
      return c.json(updated);
    } catch (e) {
      return err(c, 404, (e as Error).message);
    }
  });

  // ---- memory ----
  app.get("/v1/memory", (c) => {
    if (!opts.memory) return err(c, 404, "memory disabled");
    return c.json({
      items: opts.memory.recall(c.req.query("q") ?? "", {
        limit: 50,
        includeArchived: c.req.query("archived") === "1",
      }),
    });
  });

  app.post("/v1/memory", async (c) => {
    if (!opts.memory) return err(c, 404, "memory disabled");
    const b = (await c.req.json().catch(() => ({}))) as { content?: string; key?: string; tags?: string[] };
    try {
      return c.json(opts.memory.remember({ content: b.content ?? "", key: b.key || undefined, tags: b.tags }), 201);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });

  app.delete("/v1/memory/:id", (c) => {
    if (!opts.memory) return err(c, 404, "memory disabled");
    return opts.memory.forget(Number(c.req.param("id"))) ? c.json({ ok: true }) : err(c, 404, "no such memory");
  });

  // ---- skills (read-only; the model edits them through the skill tool) ----
  app.get("/v1/skills", (c) => {
    if (!opts.skillDirs) return err(c, 404, "skills disabled");
    const off = opts.settings?.read().disabledSkills ?? [];
    return c.json({
      skills: scanSkills(opts.skillDirs).map((s) => ({
        name: s.name,
        description: s.description,
        tools: s.tools,
        path: s.path,
        disabled: off.includes(s.name),
      })),
    });
  });

  app.get("/v1/skills/:name", (c) => {
    if (!opts.skillDirs) return err(c, 404, "skills disabled");
    const s = scanSkills(opts.skillDirs).find((x) => x.name === c.req.param("name"));
    if (!s) return err(c, 404, "no such skill");
    return c.json({
      name: s.name,
      description: s.description,
      tools: s.tools,
      path: s.path,
      body: s.body,
      files: linkedFiles(s),
    });
  });
}
