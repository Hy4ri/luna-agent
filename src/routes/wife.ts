import type { Hono } from "hono";
import { ConversationError } from "../conversations.js";
import { DISMISS_REASONS, WIFE_STATUSES, type DismissReason, type WifeStatus } from "../wife/store.js";
import { redact } from "../wife/redact.js";
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
  app.get("/v1/wife/stats", c => wife ? c.json(wife.stats()) : off(c));
  app.post("/v1/wife/scan", c => {
    if (!wife) return off(c);
    const q = c.req.query("session"); const session = q === undefined ? undefined : id(q);
    if (q !== undefined && !session) return err(c, 400, "bad session id");
    try { return c.json(wife.scan({ session })); } catch (e) { return err(c, 500, (e as Error).message); }
  });
  app.post("/v1/wife/:id/agree", async c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
    const b = await body(c);
    try { return c.json(await wife.agree(n, { confirm: b.confirm === true, targets: Array.isArray(b.targets) && b.targets.every(Number.isSafeInteger) ? b.targets as number[] : undefined })); }
    catch (e) {
      if (e instanceof WifeError || e instanceof ConversationError) return err(c, e.status, e.message);
      return err(c, 500, (e as Error).message);
    }
  });
  app.post("/v1/wife/:id/discuss", async c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
    try { return c.json({ sessionId: await wife.discuss(n) }); }
    catch (e) { return e instanceof WifeError ? err(c, e.status, e.message) : err(c, 500, (e as Error).message); }
  });
  app.post("/v1/wife/:id/undo", async c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
    try { return c.json(await wife.undo(n)); }
    catch (e) {
      if (e instanceof WifeError || e instanceof ConversationError) return err(c, e.status, e.message);
      return err(c, 500, (e as Error).message);
    }
  });
  app.post("/v1/wife/:id/dismiss", async c => {
    if (!wife) return off(c);
    const n = id(c.req.param("id")); const card = n ? wife.store.get(n) : undefined;
    if (!n || !card) return err(c, 404, "no such suggestion");
    if (card.status !== "open" && card.status !== "snoozed") return err(c, 409, `suggestion is ${card.status}`);
    const b = await body(c);
    if (b.reason !== undefined && !(DISMISS_REASONS as readonly unknown[]).includes(b.reason)) return err(c, 400, `reason must be one of ${DISMISS_REASONS.join(", ")}`);
    if (b.note !== undefined && typeof b.note !== "string") return err(c, 400, "note must be text");
    const note = typeof b.note === "string" ? redact(b.note.trim().slice(0, 500)) : undefined;
    wife.store.dismiss(n, b.reason as DismissReason | undefined, note);
    wife.onDismiss(card);
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
    wife.store.record(card, "snooze", null, `${days}d`);
    return c.json(wife.store.get(n));
  });
}
