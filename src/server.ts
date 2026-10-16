// HTTP + SSE API over the durable Luna harness. Transport-only: all state lives in the harness (SQLite).
import { Hono, type Context as HonoContext } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { watchEvents } from "@earendil-works/pi-durable";
import { context } from "./luna.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export interface ServerOptions {
  harness: Harness;
  /** Bearer token for /v1/*. When unset, auth is off (daemon then binds loopback only). */
  token?: string;
  /** Default agent choices for new sessions (model etc). */
  agent?: Parameters<Harness["createConversation"]>[0]["agent"];
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(opts: ServerOptions) {
  const { harness } = opts;
  const app = new Hono();
  const started = Date.now();
  const err = (c: HonoContext, status: 400 | 401 | 404 | 409 | 500, message: string) => c.json({ error: message }, status);

  app.onError((e, c) => {
    const name = (e as Error).name;
    if (name === "ConversationBusy") return err(c, 409, "conversation busy");
    return err(c, 500, (e as Error).message ?? String(e));
  });

  // ---- health (unauthenticated) ----
  app.get("/health", async (c) => {
    const inspection = await harness.inspect(context);
    return c.json({ ok: true, uptimeMs: Date.now() - started, live: inspection as unknown });
  });

  // ---- auth ----
  app.use("/v1/*", async (c, next) => {
    if (opts.token) {
      const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
      if (!m || !safeEq(m[1]!, opts.token)) return err(c, 401, "unauthorized");
    }
    await next();
  });

  const getConv = async (id: string) => harness.conversation(id as never, context);

  // ---- sessions ----
  app.get("/v1/sessions", async (c) => {
    const page = await harness.commit((tx) => tx.scanConversations({ order: "descending" }, 100), context);
    return c.json({ sessions: page.items.map((r) => ({ id: r.id, parent: r.parent ?? null })) });
  });

  app.post("/v1/sessions", async (c) => {
    const b = await c.req.json().catch(() => ({})) as { model?: { provider: string; modelId: string }; instructions?: string; cwd?: string };
    const agent = { ...(opts.agent ?? {}), ...(b.model && { model: b.model }), ...(b.instructions && { instructions: b.instructions }), ...(b.cwd && { cwd: b.cwd }) };
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    return c.json({ id: conv.id }, 201);
  });

  app.get("/v1/sessions/:id", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 500);
    const page = await conv.entries({ order: "descending" }, limit, undefined, context);
    const a = await conv.agent(context);
    return c.json({
      id: conv.id,
      agent: { model: a.model ?? null, thinkingLevel: a.thinkingLevel, cwd: a.cwd ?? null, tools: a.tools.map((t) => t.name) },
      entries: page.items,
    });
  });

  app.post("/v1/sessions/:id/abort", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    await conv.abort(context);
    return c.json({ ok: true });
  });

  // ---- messages ----
  // Non-streaming (default): waits for the answer and returns it.
  // Streaming (?stream=1 or Accept: text/event-stream): SSE of agent events until the submission settles.
  const send = async (c: HonoContext, sessionId: string, body: { content?: string; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" }) => {
    const conv = await getConv(sessionId);
    if (!conv) return err(c, 404, "no such session");
    if (typeof body.content !== "string" || !body.content) return err(c, 400, "content (string) required");
    const wantsStream = c.req.query("stream") === "1" || (c.req.header("accept") ?? "").includes("text/event-stream");
    const settle = async (sub: Awaited<ReturnType<typeof conv.submit>>) => {
      const s = await sub.wait(context);
      if (s.status !== "done") return { submissionId: sub.id, status: s.status, reason: (s as { reason?: string }).reason ?? null, detail: (s as { detail?: unknown }).detail ?? null };
      const ent = await conv.entries({}, 1, undefined, context); // newest first
      const answer = ent.items.find((e) => e.id === s.answer) ?? (await harness.commit((tx) => tx.entry(s.answer as never), context).catch(() => undefined));
      return { submissionId: sub.id, status: "done", answer: textOf(answer) };
    };

    if (!wantsStream) {
      const sub = await conv.submit({ type: "input", content: body.content, requestId: body.requestId, whenBusy: body.whenBusy }, context);
      return c.json(await settle(sub));
    }
    return streamSSE(c, async (stream) => {
      const ev = await watchEvents(harness, conv.id, context);
      let closed = false;
      const done = new Promise<void>((r) => stream.onAbort(() => { closed = true; r(); }));
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(ev.snapshot) });
      ev.start(async (events) => {
        if (closed) return;
        for (const e of events) await stream.writeSSE({ event: (e as { type: string }).type, data: JSON.stringify(e) });
      });
      try {
        const sub = await conv.submit({ type: "input", content: body.content!, requestId: body.requestId, whenBusy: body.whenBusy }, context);
        await stream.writeSSE({ event: "submitted", data: JSON.stringify({ submissionId: sub.id }) });
        const result = await Promise.race([settle(sub), done.then(() => null)]);
        if (result) {
          await new Promise((r) => setTimeout(r, 150)); // let the final commit's events flush
          await stream.writeSSE({ event: "done", data: JSON.stringify(result) });
        }
      } finally {
        await ev.stop();
      }
    });
  };

  app.post("/v1/sessions/:id/messages", async (c) => send(c, c.req.param("id"), await c.req.json().catch(() => ({}))));

  // Convenience: create-or-reuse session in one call. {message, sessionId?}
  app.post("/v1/chat", async (c) => {
    const b = await c.req.json().catch(() => ({})) as { message?: string; sessionId?: string; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" };
    let id = b.sessionId;
    if (!id) id = (await harness.createConversation({ ownership: { kind: "ownerless" }, agent: opts.agent }, context)).id as unknown as string;
    return send(c, id, { content: b.message, requestId: b.requestId, whenBusy: b.whenBusy });
  });

  // Live events only (no submit): attach to a running session.
  app.get("/v1/sessions/:id/events", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return streamSSE(c, async (stream) => {
      const ev = await watchEvents(harness, conv.id, context);
      const closed = new Promise<void>((r) => stream.onAbort(() => r()));
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(ev.snapshot) });
      ev.start(async (events) => {
        for (const e of events) await stream.writeSSE({ event: (e as { type: string }).type, data: JSON.stringify(e) });
      });
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 15000);
      await closed;
      clearInterval(ping);
      await ev.stop();
    });
  });

  // ---- tools ----
  app.get("/v1/tools", async (c) => {
    const root = await harness.root(context);
    const a = await root.agent(context);
    const shape = (t: { name: string; description?: string; parameters?: unknown }) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? null });
    return c.json({ tools: a.tools.map(shape), deferred: a.deferred.map(shape) });
  });

  // ---- webhooks: POST any payload into a session as an input ----
  app.post("/v1/webhooks/:id", async (c) => {
    const raw = await c.req.text();
    const source = c.req.query("source") ?? c.req.header("user-agent") ?? "webhook";
    let pretty = raw;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const sub = await conv.submit({ type: "input", content: `[webhook from ${source}]\n${pretty}`, requestId: c.req.header("x-request-id") ?? undefined }, context);
    return c.json({ accepted: true, submissionId: sub.id }, 202); // fire-and-forget; poll GET /v1/submissions/:id
  });

  app.get("/v1/submissions/:id", async (c) => {
    const sub = await harness.submission(c.req.param("id") as never, context);
    if (!sub) return err(c, 404, "no such submission");
    return c.json(await sub.status(context));
  });

  return app;
}

function textOf(entry: { model?: readonly unknown[] } | undefined): string {
  const msg = entry?.model?.[0] as { content?: unknown } | undefined;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("");
  return "";
}
