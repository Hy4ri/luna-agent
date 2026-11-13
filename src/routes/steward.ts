import type { Hono } from "hono";
import { ConversationError } from "../conversations.js";
import { DISMISS_REASONS, STEWARD_STATUSES, type DismissReason, type StewardStatus } from "../steward/store.js";
import { StewardError } from "../steward/service.js";
import type { RouteCtx } from "./context.js";

export function registerSteward(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;
  const steward = opts.steward;
  const off = (c: Parameters<typeof err>[0]) => err(c, 404, "steward disabled");
  const id = (s: string) => { const n = Number(s); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
  const body = async (c: { req: { json: () => Promise<unknown> } }) => { try { const b = await c.req.json(); return b && typeof b === "object" ? b as Record<string, unknown> : {}; } catch { return {}; } };

  // deprecated: remove "/v1/wife" after next release
  for (const prefix of ["/v1/steward", "/v1/wife"]) {
    app.get(prefix, c => {
      if (!steward) return off(c);
      const status = c.req.query("status");
      if (status && !(STEWARD_STATUSES as readonly string[]).includes(status)) return err(c, 400, "unknown status");
      steward.store.expireSnoozed();
      return c.json({ suggestions: steward.store.list(status as StewardStatus | undefined) });
    });
    app.get(`${prefix}/count`, c => steward ? c.json({ open: steward.store.count("open") }) : off(c));
    app.get(`${prefix}/stats`, c => steward ? c.json(steward.stats()) : off(c));
    app.post(`${prefix}/scan`, c => {
      if (!steward) return off(c);
      const q = c.req.query("session"); const session = q === undefined ? undefined : id(q);
      if (q !== undefined && !session) return err(c, 400, "bad session id");
      try { return c.json(steward.scan({ session, manual: true })); } catch (e) { return err(c, 500, (e as Error).message); }
    });
    app.post(`${prefix}/:id/agree`, async c => {
      if (!steward) return off(c);
      const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
      const b = await body(c);
      try { return c.json(await steward.agree(n, { confirm: b.confirm === true, targets: Array.isArray(b.targets) && b.targets.every(Number.isSafeInteger) ? b.targets as number[] : undefined })); }
      catch (e) {
        if (e instanceof StewardError || e instanceof ConversationError) return err(c, e.status, e.message);
        return err(c, 500, (e as Error).message);
      }
    });
    app.post(`${prefix}/:id/discuss`, async c => {
      if (!steward) return off(c);
      const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
      try { return c.json({ sessionId: await steward.discuss(n) }); }
      catch (e) { return e instanceof StewardError ? err(c, e.status, e.message) : err(c, 500, (e as Error).message); }
    });
    app.post(`${prefix}/:id/undo`, async c => {
      if (!steward) return off(c);
      const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
      try { return c.json(await steward.undo(n)); }
      catch (e) {
        if (e instanceof StewardError || e instanceof ConversationError) return err(c, e.status, e.message);
        return err(c, 500, (e as Error).message);
      }
    });
    app.post(`${prefix}/:id/dismiss`, async c => {
      if (!steward) return off(c);
      const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
      const b = await body(c);
      if (b.reason !== undefined && !(DISMISS_REASONS as readonly unknown[]).includes(b.reason)) return err(c, 400, `reason must be one of ${DISMISS_REASONS.join(", ")}`);
      if (b.note !== undefined && typeof b.note !== "string") return err(c, 400, "note must be text");
      try { return c.json(steward.dismiss(n, b.reason as DismissReason | undefined, b.note as string | undefined)); }
      catch (e) { return e instanceof StewardError ? err(c, e.status, e.message) : err(c, 500, (e as Error).message); }
    });
    app.post(`${prefix}/:id/snooze`, async c => {
      if (!steward) return off(c);
      const n = id(c.req.param("id")); if (!n) return err(c, 404, "no such suggestion");
      try { return c.json(steward.snooze(n, Number((await body(c)).days))); }
      catch (e) { return e instanceof StewardError ? err(c, e.status, e.message) : err(c, 500, (e as Error).message); }
    });
  }
}
