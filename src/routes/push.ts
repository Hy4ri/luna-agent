import type { Hono } from "hono";
import type { RouteCtx } from "./context.js";

export function registerPush(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;
  const token = async (c: Parameters<typeof err>[0]) => {
    const body = await c.req.json().catch(() => ({})) as { token?: unknown };
    return typeof body.token === "string" && body.token.length >= 20 && body.token.length <= 4096 ? body.token : undefined;
  };
  // A phone registers its FCM token after login. The daemon then pushes session changes to it.
  app.get("/v1/push", (c) => c.json({ enabled: !!opts.push }));
  app.post("/v1/push/devices", async (c) => {
    if (!opts.push) return err(c, 404, "push disabled");
    const t = await token(c);
    if (!t) return err(c, 400, "token required");
    opts.push.add(t);
    return c.json({ ok: true });
  });
  app.delete("/v1/push/devices", async (c) => {
    if (!opts.push) return err(c, 404, "push disabled");
    const t = await token(c);
    if (!t) return err(c, 400, "token required");
    opts.push.remove(t);
    return c.json({ ok: true });
  });
}
