import type { Hono } from "hono";
import { isRunning } from "../session-status.js";
import { context } from "../luna.js";
import { AskDoc, checkAnswer } from "../ask.js";
import { GoalDoc } from "../goal-doc.js";
import { ExecTarget } from "../workers.js";
import { workerMediaResponse } from "../worker-media.js";
import { sideMedia, resolveMedia, mediaResponse } from "../side-media.js";
import { entryMedia } from "../media-directives.js";
import { getImageBlockAt } from "../session-images.js";
import type { RouteCtx } from "./context.js";

export function registerSessionOps(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, sideCommands, err, getConv, stop, jobView } = ctx;

  app.post("/v1/sessions/:id/reset", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    await conv.reset(undefined, context);
    return c.json({ ok: true });
  });

  app.post("/v1/sessions/:id/compact", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    if (await harness.commit((tx) => isRunning(tx, conv.id), context))
      return err(c, 409, "Cannot compress context while busy.");
    const task = await conv.compact(undefined, context);
    return c.json({ ok: true, taskId: task }, 202);
  });

  // Tasks parked by the crash-loop guard (restart_limit). Retry runs one again.
  app.get("/v1/tasks/parked", async (c) => {
    const { tasks } = await harness.inspect(context);
    return c.json({
      tasks: tasks
        .filter((t) => t.state.kind === "blocked" && t.state.reason === "restart_limit")
        .map((t) => ({
          id: t.record.id,
          kind: t.record.kind,
          conversationId: t.record.conversationId,
          restarts: t.record.restarts,
        })),
    });
  });

  app.post("/v1/tasks/:id/retry", async (c) => {
    const id = Number(c.req.param("id"));
    const { tasks } = await harness.inspect(context);
    const t = tasks.find((x) => Number(x.record.id) === id);
    if (!t || t.state.kind !== "blocked" || t.state.reason !== "restart_limit")
      return err(c, 404, "no such parked task");
    await harness.retryTask(t.record.id, context);
    return c.json({ ok: true });
  });

  app.post("/v1/sessions/:id/abort", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    await stop(conv);
    return c.json({ ok: true });
  });

  // ---- ask_user_question: answer an open questionnaire ----
  app.post("/v1/sessions/:id/questions/:callId", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const callId = c.req.param("callId");
    const body = await c.req.json().catch(() => null);
    const r = await harness.commit(async (tx) => {
      const doc = await tx.doc(AskDoc, conv.id);
      const p = doc.pending.find((x) => x.callId === callId);
      if (!p) return { status: 404 as const, error: "no open question with that id" };
      if (doc.answers[callId]) return { status: 409 as const, error: "already answered" };
      const res = checkAnswer(JSON.parse(JSON.stringify(p)), body);
      if (typeof res === "string") return { status: 400 as const, error: res };
      doc.answers[callId] = res as never;
      return { status: 200 as const };
    }, context);
    return r.status === 200 ? c.json({ ok: true }) : err(c, r.status, r.error!);
  });

  // ---- goal: pause, resume, clear from the UI ----
  app.patch("/v1/sessions/:id/goal", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = (await c.req.json().catch(() => ({}))) as { action?: string };
    if (!["pause", "resume", "clear"].includes(b.action ?? ""))
      return err(c, 400, "action must be pause, resume or clear");
    const r = await harness.commit(async (tx) => {
      const d = await tx.doc(GoalDoc, conv.id);
      if (!d.goal) return "no goal";
      if (b.action === "clear") {
        d.goal = null;
        return "ok";
      }
      if (d.goal.status === "complete") return "goal is complete";
      if (b.action === "pause") {
        d.goal.status = "paused";
        d.goal.statusReason = "paused by the user";
      } else {
        d.goal.status = "active";
        delete d.goal.statusReason;
        d.goal.runs = 0;
      }
      return "ok";
    }, context);
    if (r !== "ok") return err(c, 409, r);
    // Resuming an idle conversation needs a turn to start the work again.
    if (b.action === "resume")
      await conv.submit({ type: "input", content: "Resume the active goal.", whenBusy: "followUp" }, context);
    return c.json({ ok: true });
  });

  // Out-of-band job results: never model-visible entries or submissions in this chat.
  app.get("/v1/sessions/:id/side-jobs", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json({ jobs: sideCommands.list(String(conv.id)).map(jobView) });
  });

  app.get("/v1/sessions/:id/side-jobs/:jobId/media/:index", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const job = sideCommands.list(String(conv.id)).find((j) => j.id === c.req.param("jobId"));
    const index = Number(c.req.param("index"));
    if (!job || job.kind !== "bg" || job.status !== "complete" || !Number.isSafeInteger(index) || index < 0)
      return err(c, 404, "no such media");
    const child = job.conversationId && (await harness.conversation(job.conversationId as never, context));
    const cwd = child ? (await child.agent(context)).cwd : undefined;
    const media = sideMedia(job.text, cwd)[index];
    const worker = child && (await harness.snapshot(ExecTarget, child.id, context))?.worker;
    if (worker && media) {
      if (!opts.workers) return err(c, 404, "execution workers unavailable");
      return workerMediaResponse(c, opts.workers, worker, cwd, media);
    }
    return mediaResponse(c, media);
  });

  // Files named by MEDIA: directives in an assistant message of this conversation. The index counts
  // directives across the entry's assistant text blocks (see entryMedia); nothing else is served.
  app.get("/v1/sessions/:id/entries/:entryId/media/:index", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const entryId = Number(c.req.param("entryId")),
      index = Number(c.req.param("index"));
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(index) || index < 0)
      return err(c, 404, "no such media");
    const entry = await harness.commit((tx) => tx.entry(entryId as never), context).catch(() => undefined);
    if (!entry || String(entry.conversationId) !== String(conv.id)) return err(c, 404, "no such media");
    const directive = entryMedia(entry.model)[index];
    if (!directive) return err(c, 404, "no such media");
    // A transfer changes future execution only. Old answers keep their original machine and directory.
    const origin = await harness.commit(async (tx) => {
      let cursor;
      for (;;) {
        const page = await tx.scanEntries(
          { conversationId: conv.id, maxEntryId: entry.id, order: "descending" },
          100,
          cursor,
        );
        const marker = page.items.find((e) => e.kind === "luna.execution");
        if (marker) return marker.data as { worker: number | null; cwd: string | null };
        if (!page.next) return undefined;
        cursor = page.next;
      }
    }, context);
    const worker = origin ? origin.worker : (await harness.snapshot(ExecTarget, conv.id, context))?.worker;
    const cwd = origin ? origin.cwd ?? undefined : (await conv.agent(context)).cwd;
    if (worker) {
      if (!opts.workers) return err(c, 404, "execution workers unavailable");
      return workerMediaResponse(c, opts.workers, worker, cwd, directive);
    }
    return mediaResponse(c, resolveMedia(directive, cwd));
  });

  // Base64 images embedded in entry model blocks or tool results of this conversation/session.
  // The entry must be visible in conv.entries (lineage-aware fork history and reset-safe).
  // The index is the deterministic traversal index over all supported base64 image blocks.
  app.get("/v1/sessions/:id/entries/:entryId/images/:index", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const entryId = Number(c.req.param("entryId")),
      index = Number(c.req.param("index"));
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(index) || index < 0)
      return err(c, 404, "no such image");
    const page = await conv
      .entries({ minEntryId: entryId as never, maxEntryId: entryId as never }, 1, undefined, context)
      .catch(() => undefined);
    const entry = page?.items[0];
    if (!entry || entry.id !== entryId) return err(c, 404, "no such image");
    const block = getImageBlockAt(entry, index);
    if (!block) return err(c, 404, "no such image");
    const bytes = Buffer.from(block.data, "base64");
    return c.body(bytes, 200, {
      "content-type": block.mimeType,
      "content-length": String(bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
  });
}
