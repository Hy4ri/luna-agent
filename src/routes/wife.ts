import type { Hono } from "hono";
import { ConversationError } from "../conversations.js";
import { WIFE_STATUSES, type WifeStatus } from "../wife/store.js";
import { WifeError } from "../wife/service.js";
import type { RouteCtx } from "./context.js";

export function registerWife(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;
  const wife = opts.wife;
  const off = (c: Parameters<typeof err>[0]) => err(c, 404, "wife disabled");
  const id = (s: string) => { const n = Number(s); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
  const body = async (c: { req: { json: () => Promise<unknown> } }) => { try { const b = await c.req.json(); return b && typeof b === "object" ? b as Record<string, unknown> : {}; } catch { return {}; } };

  app.get("/v1/wife", c => {
    if (!wife) return off(c);
    const status = c.req.query("status");
    if (status && !(WIFE_STATUSES as readonly string[]).includes(status)) return err(c, 400, "unknown status");
    wife.store.expireSnoozed();
    return c.json({ suggestions: wife.store.list(status as WifeStatus | undefined) });
  });
  app.get("/v1/wife/count", c => wife ? c.json({ open: wife.store.count("open") }) : off(c));
  app.post("/v1/wife/scan", c => {
    if (!wife) return off(c);
    try { return c.json(wife.scan()); } catch (e) { return err(c, 500, (e as Error).message); }
  });
  app.post("/v1/wife/:id/agree", async c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
    const b = await body(c);
    try { return c.json(await wife.agree(n, { confirm: b.confirm === true })); }
    catch (e) {
      if (e instanceof WifeError || e instanceof ConversationError) return err(c, e.status, e.message);
      return err(c, 500, (e as Error).message);
    }
  });
  app.post("/v1/wife/:id/dismiss", c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); const card = n ? wife.store.get(n) : undefined;
    if (!n || !card) return err(c, 404, "no such suggestion");
    if (card.status !== "open" && card.status !== "snoozed") return err(c, 409, `suggestion is ${card.status}`);
    wife.store.setStatus(n, "dismissed");
    return c.json(wife.store.get(n));
  });
  app.post("/v1/wife/:id/snooze", async c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); const card = n ? wife.store.get(n) : undefined;
    if (!n || !card) return err(c, 404, "no such suggestion");
    const days = Number((await body(c)).days);
    if (!Number.isInteger(days) || days < 1 || days > 365) return err(c, 400, "days must be 1 to 365");
    if (card.status !== "open" && card.status !== "snoozed") return err(c, 409, `suggestion is ${card.status}`);
    wife.store.setStatus(n, "snoozed", { snoozeUntil: Date.now() + days * 86_400_000 });
    return c.json(wife.store.get(n));
  });
}
