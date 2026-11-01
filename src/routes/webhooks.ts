import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { context } from "../luna.js";
import { parseUploadInput as parseInput } from "../upload-input.js";
import type { RouteCtx } from "./context.js";

export function registerWebhooks(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv } = ctx;

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

  // Withdraw only this queued input before admitting its redirect replacement.
  app.post("/v1/sessions/:id/submissions/:submission/send-now", async (c) => {
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
      return ctx.send!(c, sid, { content: body.content, requestId: `send-now:${submissionId}`, whenBusy: "redirect" }, true);
    }
  });

  app.get("/v1/submissions/:id", async (c) => {
    const sub = await harness.submission(c.req.param("id") as never, context);
    if (!sub) return err(c, 404, "no such submission");
    return c.json(await sub.status(context));
  });
}
