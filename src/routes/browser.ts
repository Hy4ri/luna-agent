import type { Hono } from "hono";
import { ExecTarget } from "../workers.js";
import { context } from "../luna.js";
import { BrowserPanelError } from "../browser/panel.js";
import type { RouteCtx } from "./context.js";

const OFF = "The browser panel is off. Turn on Settings > Tools > Browser control > panel (browser.panel), and select a browser provider.";

export function registerBrowser(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv } = ctx;
  const panel = opts.browserPanel;
  if (!panel) return;

  const sessionId = (raw: string) => { const n = Number(raw); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
  const fail = (c: Parameters<typeof err>[0], e: unknown) => {
    if (e instanceof BrowserPanelError) return err(c, e.status, e.message);
    throw e;
  };

  app.get("/v1/sessions/:sid/browser", async c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid || !await getConv(String(sid))) return err(c, 404, "No such session");
    return c.json({ enabled: panel.enabled(), tabs: panel.enabled() ? panel.list(sid) : [] });
  });

  // m57 opens a tab from the panel. It runs on the machine the session uses, like Luna's own tabs.
  app.post("/v1/sessions/:sid/browser", async c => {
    const sid = sessionId(c.req.param("sid"));
    const conv = sid ? await getConv(String(sid)) : undefined;
    if (!sid || !conv) return err(c, 404, "No such session");
    if (!panel.enabled()) return err(c, 403, OFF);
    const { url } = (await c.req.json().catch(() => ({}))) as { url?: unknown };
    if (typeof url !== "string" || !url.trim()) return err(c, 400, "url is required.");
    const worker = (await harness.snapshot(ExecTarget, conv.id, context))?.worker ?? null;
    if (worker !== null && !opts.workers?.view(worker)?.online) return err(c, 503, "Machine unavailable");
    try { return c.json(await panel.open(sid, worker, url.trim(), c.req.raw.signal), 201); } catch (e) { return fail(c, e); }
  });

  app.post("/v1/sessions/:sid/browser/:tab/ticket", c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid) return err(c, 404, "No such session");
    if (!panel.enabled()) return err(c, 403, OFF);
    try { return c.json(panel.issueTicket(sid, c.req.param("tab"))); } catch (e) { return fail(c, e); }
  });

  // take/give move the mouse and keyboard between m57 and Luna.
  app.post("/v1/sessions/:sid/browser/:tab/control", async c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid) return err(c, 404, "No such session");
    if (!panel.enabled()) return err(c, 403, OFF);
    const { action } = (await c.req.json().catch(() => ({}))) as { action?: unknown };
    if (action !== "take" && action !== "give") return err(c, 400, "action must be take or give.");
    try { return c.json(panel.control(sid, c.req.param("tab"), action)); } catch (e) { return fail(c, e); }
  });

  app.delete("/v1/sessions/:sid/browser/:tab", async c => {
    const sid = sessionId(c.req.param("sid"));
    if (!sid) return err(c, 404, "No such session");
    if (!panel.enabled()) return err(c, 403, OFF);
    try { await panel.close(sid, c.req.param("tab")); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  });
}
