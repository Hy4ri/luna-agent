import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { context } from "../luna.js";
import { ScheduledMessageError } from "../scheduled-messages.js";
import type { RouteCtx } from "./context.js";

export function registerScheduledMessages(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv, serial } = ctx;

  app.get("/v1/sessions/:id/scheduled-messages", async (c) => {
    const svc = opts.scheduledMessages;
    if (!svc) return err(c, 404, "scheduled messages disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");

    const schedules = await harness.commit((tx) => svc.list(tx, Number(conv.id)), context);
    return c.json({ schedules });
  });

  app.post("/v1/sessions/:id/scheduled-messages", async (c) => {
    const svc = opts.scheduledMessages;
    if (!svc) return err(c, 404, "scheduled messages disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");

    let body: { content?: unknown; dueAt?: unknown; requestId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid json");
    }

    if (typeof body.content !== "string" || !body.content.trim()) {
      return err(c, 400, "content (nonempty string) required");
    }
    if (typeof body.dueAt !== "number" || !Number.isFinite(body.dueAt)) {
      return err(c, 400, "dueAt (epoch ms) required");
    }
    if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim())) {
      return err(c, 400, "requestId must be a nonempty string");
    }
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : randomUUID();

    try {
      const result = await serial(String(conv.id), async () => {
        const res = await harness.commit(
          (tx) =>
            svc.create(tx, {
              conversationId: Number(conv.id),
              content: body.content as string,
              dueAt: body.dueAt as number,
              requestId,
              source: { kind: "user" },
            }),
          context,
        );
        await svc.scheduleChanged();
        return res;
      });
      return c.json({ schedule: result.schedule }, result.created ? 201 : 200);
    } catch (e) {
      if (e instanceof ScheduledMessageError) return err(c, e.status, e.message);
      throw e;
    }
  });

  app.delete("/v1/sessions/:id/scheduled-messages/:scheduleId", async (c) => {
    const svc = opts.scheduledMessages;
    if (!svc) return err(c, 404, "scheduled messages disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");

    const scheduleId = c.req.param("scheduleId");
    const res = await serial(String(conv.id), () => svc.cancel(Number(conv.id), scheduleId));
    if (res.status === "not_found") return err(c, 404, "no such scheduled message");
    return c.json(res);
  });
}
