import type { Hono } from "hono";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ExecTarget } from "../workers.js";
import { context } from "../luna.js";
import { TerminalError } from "../terminal/registry.js";
import type { RouteCtx } from "./context.js";

const OFF = "Terminals are off. Turn on Settings > Tools > Terminal (terminal.user) to use them.";

export function registerTerminals(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv } = ctx;
  const service = opts.terminals;
  if (!service) return;

  /** The session must exist, and a terminal named in the path must belong to it. */
  const owned = (session: number, id: string) => {
    const info = service.registry.get(id);
    if (!info) throw new TerminalError("No such terminal.", 404);
    if (info.session !== session) throw new TerminalError("That terminal belongs to another session.", 404);
    return info;
  };
  const fail = (c: Parameters<typeof err>[0], e: unknown) => {
    if (e instanceof TerminalError) return err(c, e.status, e.message);
    throw e;
  };
  const sessionId = (raw: string) => { const n = Number(raw); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };

  app.get("/v1/sessions/:sid/terminals", async c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid || !await getConv(String(sid))) return err(c, 404, "No such session");
    return c.json({ enabled: service.enabled(), agentEnabled: service.agentEnabled(), terminals: service.registry.list(sid).filter(t => service.viewable(t)) });
  });

  app.post("/v1/sessions/:sid/terminals", async c => {
    const sid = sessionId(c.req.param("sid"));
    const conv = sid ? await getConv(String(sid)) : undefined;
    if (!sid || !conv) return err(c, 404, "No such session");
    if (!service.enabled()) return err(c, 403, OFF);
    const body = (await c.req.json().catch(() => ({}))) as { cols?: unknown; rows?: unknown };
    const size = (v: unknown) => typeof v === "number" ? v : undefined;
    const worker = (await harness.snapshot(ExecTarget, conv.id, context))?.worker ?? null;
    const agentCwd = (await conv.agent(context)).cwd ?? undefined;
    if (worker !== null && !opts.workers?.view(worker)?.online) return err(c, 503, "Machine unavailable");
    const cwd = worker === null
      ? new NodeExecutionEnv({ cwd: agentCwd ?? opts.cwd ?? process.cwd() }).cwd
      : agentCwd ?? opts.workers!.view(worker)?.capabilities?.cwd ?? "/";
    try {
      return c.json(await service.registry.create({ session: sid, worker, cwd, cols: size(body.cols), rows: size(body.rows) }), 201);
    } catch (e) { return fail(c, e); }
  });

  app.post("/v1/sessions/:sid/terminals/:id/ticket", c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid) return err(c, 404, "No such session");
    try {
      if (!service.viewable(owned(sid, c.req.param("id")))) return err(c, 403, OFF);
      return c.json(service.issueTicket(c.req.param("id")));
    } catch (e) { return fail(c, e); }
  });

  // take/give move the keyboard between m57 and Luna; share/unshare decide whether Luna can see one of m57's terminals.
  app.post("/v1/sessions/:sid/terminals/:id/control", async c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid) return err(c, 404, "No such session");
    const { action } = (await c.req.json().catch(() => ({}))) as { action?: unknown };
    if (action !== "take" && action !== "give" && action !== "share" && action !== "unshare") return err(c, 400, "action must be take, give, share, or unshare.");
    try {
      const info = owned(sid, c.req.param("id"));
      if (!service.viewable(info)) return err(c, 403, OFF);
      if ((action === "give" || action === "share") && !service.agentEnabled())
        return err(c, 403, "Luna's terminal access is off. Turn on Settings > Tools > Terminal (terminal.agent) first.");
      return c.json(await service.registry.control(info.id, action));
    } catch (e) { return fail(c, e); }
  });

  app.delete("/v1/sessions/:sid/terminals/:id", c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid) return err(c, 404, "No such session");
    try {
      owned(sid, c.req.param("id"));
      service.registry.close(c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
}
