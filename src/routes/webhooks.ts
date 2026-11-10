import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { context } from "../luna.js";
import { parseUploadInput as parseInput } from "../upload-input.js";
import type { RouteCtx } from "./context.js";
import { WebhookError, type Webhooks } from "../webhooks.js";

const tooLarge = (c: import("hono").Context) => c.json({ error: "webhook payload too large (1 MB max)" }, 413);

/** Public receiver: POST /hooks/<slug>. Outside /v1 auth; each hook's own secret protects it. */
export function registerHookReceiver(app: Hono, webhooks: Webhooks | undefined): void {
  app.post("/hooks/:slug", bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }), async (c) => {
    if (!webhooks) return c.json({ error: "no such webhook" }, 404);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const r = await webhooks.receive(c.req.param("slug"), raw, (k) => c.req.header(k), (k) => c.req.query(k));
    return c.json(r.body, r.status);
  });
}

/** Management API for inbound hooks and outbound subscriptions. Secrets appear only on create and rotate. */
function registerWebhookAdmin(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;
  // The middleware below answers 404 when webhooks are absent, so handlers can rely on them.
  const hooks = (_c: import("hono").Context) => opts.webhooks!;
  const num = (s: string) => { const n = Number(s); if (!Number.isSafeInteger(n) || n < 1) throw new WebhookError(404, "not found"); return n; };
  const body = async (c: import("hono").Context) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new WebhookError(400, "body must be a JSON object");
    return b as Record<string, unknown>;
  };
  const view = (w: Webhooks, id: number) => { const h = w.store.getInbound(id)!; return { ...h, path: `/hooks/${h.slug}` }; };
  app.use("/v1/webhooks/inbound*", async (c, next) => { if (!opts.webhooks) return err(c, 404, "webhooks disabled"); await next(); });
  app.use("/v1/webhooks/outbound*", async (c, next) => { if (!opts.webhooks) return err(c, 404, "webhooks disabled"); await next(); });

  app.get("/v1/webhooks/inbound", (c) => { const w = hooks(c); return c.json(w.store.listInbound().map(h => view(w, h.id))); });
  app.post("/v1/webhooks/inbound", async (c) => {
    const w = hooks(c), b = await body(c);
    await w.checkTarget(b.target);
    const { hook, secret } = w.store.createInbound(b as never);
    return c.json({ ...view(w, hook.id), secret }, 201);
  });
  app.patch("/v1/webhooks/inbound/:id", async (c) => {
    const w = hooks(c), b = await body(c), id = num(c.req.param("id"));
    if (b.target !== undefined) await w.checkTarget(b.target);
    w.store.updateInbound(id, b);
    return c.json(view(w, id));
  });
  app.post("/v1/webhooks/inbound/:id/rotate", (c) => {
    const w = hooks(c), id = num(c.req.param("id"));
    const secret = w.store.rotateInbound(id);
    return c.json({ ...view(w, id), secret });
  });
  app.get("/v1/webhooks/inbound/:id/secret", (c) => {
    const w = hooks(c), secret = w.store.inboundSecret(num(c.req.param("id")));
    return secret ? c.json({ secret }) : err(c, 404, "no such webhook");
  });
  app.delete("/v1/webhooks/inbound/:id", (c) => {
    const w = hooks(c);
    return w.store.removeInbound(num(c.req.param("id"))) ? c.json({ ok: true }) : err(c, 404, "no such webhook");
  });
  app.get("/v1/webhooks/inbound/:id/log", (c) => {
    const w = hooks(c), id = num(c.req.param("id"));
    if (!w.store.getInbound(id)) return err(c, 404, "no such webhook");
    return c.json(w.store.inboundLog(id));
  });

  app.get("/v1/webhooks/outbound", (c) => c.json(hooks(c).store.listSubs()));
  app.post("/v1/webhooks/outbound", async (c) => {
    const { sub, secret } = hooks(c).store.createSub((await body(c)) as never);
    return c.json({ ...sub, secret }, 201);
  });
  app.patch("/v1/webhooks/outbound/:id", async (c) => c.json(hooks(c).store.updateSub(num(c.req.param("id")), await body(c))));
  app.post("/v1/webhooks/outbound/:id/rotate", (c) => {
    const w = hooks(c), id = num(c.req.param("id"));
    const secret = w.store.rotateSub(id);
    return c.json({ ...w.store.getSub(id)!, secret });
  });
  app.get("/v1/webhooks/outbound/:id/secret", (c) => {
    const secret = hooks(c).store.subSecret(num(c.req.param("id")));
    return secret ? c.json({ secret }) : err(c, 404, "no such subscription");
  });
  app.delete("/v1/webhooks/outbound/:id", (c) =>
    hooks(c).store.removeSub(num(c.req.param("id"))) ? c.json({ ok: true }) : err(c, 404, "no such subscription"));
  app.post("/v1/webhooks/outbound/:id/test", (c) => c.json(hooks(c).test(num(c.req.param("id"))), 202));
  app.get("/v1/webhooks/outbound/:id/deliveries", (c) => {
    const w = hooks(c), id = num(c.req.param("id"));
    if (!w.store.getSub(id)) return err(c, 404, "no such subscription");
    return c.json(w.store.deliveries(id));
  });
  app.post("/v1/webhooks/deliveries/:id/redeliver", (c) => {
    const w = hooks(c), d = w.store.redeliver(num(c.req.param("id")));
    w.kick();
    return c.json(d, 202);
  });
}

export function registerWebhooks(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv } = ctx;
  // Registered before the session route so /v1/webhooks/inbound and /outbound never parse as a session id.
  registerWebhookAdmin(app, ctx);

  // ---- webhooks: POST any payload into a session as an input ----
  app.post("/v1/webhooks/:id", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => err(c, 413, "webhook payload too large (1 MB max)") }), async (c) => {
    const raw = await c.req.text();
    const source = c.req.query("source") ?? c.req.header("user-agent") ?? "webhook";
    let pretty = raw;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* keep raw */
    }
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    await opts.limitContinuer?.cancel(Number(conv.id), "New input replaced automatic recovery.");
    const sub = await conv.submit(
      {
        type: "input",
        content: `[webhook from ${source}]\n${pretty}`,
        requestId: c.req.header("x-request-id") ?? undefined,
      },
      context,
    );
    return c.json({ accepted: true, submissionId: sub.id }, 202); // fire-and-forget; poll GET /v1/submissions/:id
  });

  // Withdraw only this queued input before admitting it again as a steer of the current run.
  app.post("/v1/sessions/:id/submissions/:submission/steer", async (c) => {
    const sid = c.req.param("id"),
      submissionId = c.req.param("submission");
    const body = await c.req.json();
    {
      const sub = await harness.submission(submissionId as never, context);
      if (!sub) return err(c, 404, "no such submission");
      const record = await sub.status(context);
      if (String(record.conversationId) !== sid || record.type !== "input")
        return err(c, 404, "no such input submission");
      // Validate before withdrawing. The client keeps the content for safe retries.
      const content = parseInput(body.content);
      if (typeof content === "string" && (typeof body.content !== "string" || !content.trim()))
        return err(c, 400, "content required");
      if (Array.isArray(content) && content.some((block) => block.type === "audio"))
        return err(c, 400, "Audio attachments require /bg.");
      if (record.status === "queued") {
        if ((await sub.abort(context)) !== "aborted") return err(c, 409, "Message is already being delivered.");
      } else if (record.status !== "unanswered" || record.reason !== "aborted" || record.entry !== undefined) {
        return err(c, 409, "Message is already being delivered.");
      }
      return ctx.send!(c, sid, { content: body.content, requestId: `steer:${submissionId}`, whenBusy: "steer" }, true);
    }
  });

  app.get("/v1/submissions/:id", async (c) => {
    const sub = await harness.submission(c.req.param("id") as never, context);
    if (!sub) return err(c, 404, "no such submission");
    return c.json(await sub.status(context));
  });
}
