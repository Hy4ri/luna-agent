import type { Hono, Context as HonoContext } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { UsageDoc, type Submission } from "@earendil-works/pi-durable";
import { openSessionFeed } from "../session-feed.js";
import type { AgentEvent } from "../session-feed-types.js";
import { admittedAction, BusyCommandError, DEFAULT_BUSY_INPUT, feedback, parseQueueCommand, queueCommand, type BusyMode } from "../busy-input.js";
import { readClaudeUsage, usageNotice } from "../claude-usage.js";
import { undoCommand } from "../undo.js";
import { REVIEW_DEFAULT_PROMPT } from "../review.js";
import { GRILL_USAGE, grillPrompt, parseGrill } from "../grill-command.js";
import { SKILLCRAFT_USAGE, parseSkillcraft, skillcraftPrompt } from "../skillcraft-command.js";
import { LEARN_USAGE, learnPrompt, parseLearn } from "../learn-command.js";
import { parseUploadInput as parseInput, type UploadInput } from "../upload-input.js";
import { projectAgentEvent, projectSnapshotImages } from "../session-images.js";
import { projectAgentEventForUi } from "../session-history-view.js";
import { context } from "../luna.js";
import { conversationStorage } from "../conversation-storage.js";
import { analyticsService } from "../analytics/index.js";
import { BackgroundCommandStore } from "../background-command.js";
import { isRunning } from "../session-status.js";
import { closeOpenSessionStatusWaits } from "../analytics/waits.js";
import type { SideInput } from "../side-commands.js";
import { type RouteCtx, textOf } from "./context.js";

// Carry placement identity with its entry so viewers can replace local pending input atomically.
// One entry can contain several steering submissions combined by the harness.
function withSubmissions(events: readonly AgentEvent[]) {
  const placements = events.filter((event) => event.type === "submission" && event.record.entry !== undefined);
  return events.map((event) =>
    event.type === "entry_appended"
      ? {
          ...event,
          submissions: placements.flatMap((p) =>
            p.type === "submission" && p.record.entry === event.entry.id ? [p.record] : [],
          ),
        }
      : event,
  );
}

export function registerMessages(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, sideCommands, err, getConv, baseAgent, serial, stop, draining, jobView, prepareAttachments } =
    ctx;

  // ---- messages ----
  // Non-streaming (default): waits for the answer and returns it.
  // Streaming (?stream=1 or Accept: text/event-stream): SSE of agent events until the submission settles.
  let send!: (
    c: HonoContext,
    sessionId: string,
    body: { content?: unknown; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" },
    asyncMode?: boolean,
  ) => Promise<Response>;
  send = ctx.send = async (
    c: HonoContext,
    sessionId: string,
    body: { content?: unknown; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" },
    asyncMode = false,
  ) => {
    const conv = await getConv(sessionId);
    if (!conv) return err(c, 404, "no such session");

    const content = parseInput(body.content);
    if (typeof content === "string" && typeof body.content !== "string") return err(c, 400, content);
    if (typeof body.content === "string" && !body.content.trim()) return err(c, 400, "content (string) required");

    if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim()))
      return err(c, 400, "requestId must be a nonempty string");
    if (body.whenBusy !== undefined && !["steer", "followUp", "reject"].includes(body.whenBusy))
      return err(c, 400, "invalid whenBusy");
    const commandText =
      typeof content === "string"
        ? content
        : content
            .filter((b) => b.type === "text")
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n");
    const side = /^\/(btw|bg|review)(?:\s+([\s\S]*))?$/.exec(commandText.trim());
    if (side) {
      const kind = side[1] as "btw" | "bg" | "review",
        prompt = (side[2] ?? "").trim() || (kind === "review" ? REVIEW_DEFAULT_PROMPT : "");
      if (kind !== "bg" && Array.isArray(content) && content.some((block) => block.type !== "text")) {
        return err(c, 400, "Send attachments in normal chat or /bg, not /btw or /review.");
      }
      if (!prompt) return err(c, 400, `Usage: /${kind} <${kind === "btw" ? "question" : "prompt"}>`);
      try {
        const job = await serial(String(conv.id), async () => {
          const prepared = await prepareAttachments(content as UploadInput, conv, c.req.raw.signal);
          return sideCommands.start(conv, kind, prompt, prepared as SideInput, body.requestId);
        });
        return c.json(
          { command: true, job: jobView(job), notice: `/${kind} started: ${prompt.slice(0, 60)} [${job.id}]` },
          202,
        );
      } catch (error) {
        return err(c, 400, (error as Error).message);
      }
    }
    if (draining.has(String(conv.id)))
      return c.json(
        { command: true, notice: "The current turn is stopping. Send the message again after it stops." },
        409,
      );
    const plain =
      typeof content === "string"
        ? content
        : content.every((block) => block.type === "text")
          ? content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
          : undefined;
    const slash =
      plain === undefined
        ? null
        : /^\/(usage|cost|tools|queue|steer|stop|model|compress|compact|retry|undo|schedule)(?:\s+([\s\S]*))?$/.exec(
            plain.trim(),
          );
    let input = content as UploadInput;
    let override: BusyMode | undefined;
    const learn = plain === undefined ? null : /^\/learn(?:\s+([\s\S]*))?$/.exec(plain.trim());
    if (learn) {
      const req = parseLearn(learn[1] ?? "");
      if (!req) return err(c, 400, LEARN_USAGE);
      input = learnPrompt(req);
    }
    const grill = plain === undefined ? null : /^\/grill(?:\s+([\s\S]*))?$/.exec(plain.trim());
    if (grill) {
      const topic = parseGrill(grill[1] ?? "");
      if (!topic) return err(c, 400, GRILL_USAGE);
      input = grillPrompt(topic);
    }
    const skillcraft = plain === undefined ? null : /^\/skillcraft(?:\s+([\s\S]*))?$/.exec(plain.trim());
    if (skillcraft) {
      const topic = parseSkillcraft(skillcraft[1] ?? "");
      if (!topic) return err(c, 400, SKILLCRAFT_USAGE);
      input = skillcraftPrompt(topic);
    }
    if (slash) {
      const command = slash[1]!,
        args = (slash[2] ?? "").trim();
      if (command === "usage" || command === "cost") {
        if (args) return err(c, 400, `Usage: /${command}`);
        const usage = (await harness.snapshot(UsageDoc, conv.id, context)) ?? { models: {}, tools: {} };
        try {
          const report = await readClaudeUsage(c.req.raw.signal);
          return c.json({ command: true, notice: usageNotice(usage, report) });
        } catch (error) {
          // Keep recorded session totals usable when login, network, or CLI support is absent.
          return c.json({ command: true, notice: `${usageNotice(usage)}\n${(error as Error).message}` });
        }
      }
      if (command === "tools") {
        if (args) return err(c, 400, "Usage: /tools");
        const a = await conv.agent(context);
        const active = a.tools.map((t) => t.name);
        const deferred = a.deferred.map((t) => t.name);
        const lines = [`Tools (${active.length}): ${active.length ? active.join(", ") : "(none)"}`];
        if (deferred.length) lines.push(`Deferred (${deferred.length}): ${deferred.join(", ")}`);
        return c.json({ command: true, notice: lines.join("\n") });
      }
      if (command === "undo") {
        if (!/^[1-9]\d*$/.test(args) || !Number.isSafeInteger(Number(args)))
          return err(c, 400, "Usage: /undo <positive integer>");
        return c.json(
          await serial(String(conv.id), () =>
            harness.commit(async (tx) => {
              if (draining.has(String(conv.id)))
                throw new BusyCommandError("The current turn is stopping. Try /undo after it stops.", 409);
              return undoCommand(tx, conv.id, Number(args), body.requestId);
            }, context),
          ),
        );
      }
      if (command === "stop") {
        await stop(conv);
        return c.json({ command: true, notice: "Stopped." });
      }
      if (command === "schedule") {
        const svc = opts.scheduledMessages;
        if (!svc) return err(c, 404, "scheduled messages disabled");
        if (args === "list") {
          const all = await harness.commit((tx) => svc.list(tx, Number(conv.id)), context);
          const pending = all.filter((s) => s.status === "scheduled" || s.status === "queued");
          const notice = pending.length
            ? pending.map((s) => `${s.id} [${s.status}] ${new Date(s.dueAt).toISOString()}: ${s.content.slice(0, 60)}`).join("\n")
            : "No scheduled messages.";
          return c.json({ command: true, schedules: pending, notice });
        }
        const cancelMatch = /^cancel\s+(\S+)$/.exec(args);
        if (cancelMatch) {
          const res = await serial(String(conv.id), () => svc.cancel(Number(conv.id), cancelMatch[1]!));
          if (res.status === "not_found") return err(c, 404, "no such scheduled message");
          const notice =
            res.status === "cancelled"
              ? `Cancelled ${cancelMatch[1]}.`
              : res.status === "already_delivered"
                ? `Already delivered: ${cancelMatch[1]}.`
                : `Already cancelled: ${cancelMatch[1]}.`;
          return c.json({ command: true, status: res.status, schedule: res.schedule, notice });
        }
        return err(c, 400, "Use /schedule <message> in the web composer picker, POST /v1/sessions/:id/scheduled-messages, /schedule list, or /schedule cancel <id>.");
      }
      if (["model", "compress", "compact", "retry"].includes(command)) {
        const busy = await harness.commit((tx) => isRunning(tx, conv.id), context);
        return err(
          c,
          busy ? 409 : 400,
          busy ? `/${command} is not available while busy.` : `Use the session controls for /${command}.`,
        );
      }
      if (command === "queue") {
        const mutation = parseQueueCommand(args || "list");
        if (mutation)
          return c.json(
            await serial(String(conv.id), () =>
              harness.commit((tx) => queueCommand(tx, conv.id, mutation, body.requestId), context),
            ),
          );
        if (/^(?:edit|remove|move)\s+\d+(?:\s|$)/.test(args))
          return err(c, 400, "Use /queue list, edit N text, remove N, move A B, or clear.");
      }
      if (!args) return err(c, 400, `/${command} needs a message.`);
      input = args;
      override = command as BusyMode;
    }
    const submit = () =>
      serial(String(conv.id), async () => {
        if (draining.has(String(conv.id)))
          throw new BusyCommandError("The current turn is stopping. Send the message again after it stops.", 409);
        const policy = opts.settings?.read().busyInput ?? opts.busyInput?.() ?? DEFAULT_BUSY_INPUT;
        const mode: BusyMode =
          override ?? (body.whenBusy === "steer" ? "steer" : body.whenBusy === "followUp" ? "queue" : policy.mode);
        const whenBusy = body.whenBusy === "reject" && !override ? "reject" : mode === "queue" ? "followUp" : "steer";
        const prepared = await prepareAttachments(input, conv, c.req.raw.signal);
        await opts.scheduledMessages?.cancelForConversation(Number(conv.id), "limit_recovery", "New input replaced automatic recovery.");
        // Admit and read the inbox in one commit, so the receipt names what the harness did.
        const admitted = await conv.commit(async (tx) => {
          const prior = body.requestId ? await tx.submissionByRequest(conv.id, body.requestId) : undefined;
          const id = await conv.submit(tx, { type: "input", content: prepared, requestId: body.requestId, whenBusy });
          if (!prior) {
            await closeOpenSessionStatusWaits(tx, conv.id, "answered");
          }
          const action = await admittedAction(tx, conv.id, id);
          return { id, action, ...(await feedback(tx, conv.id, policy, action)) };
        }, context);
        const sub = await harness.submission(admitted.id, context);
        if (!sub) throw new Error(`Admitted submission ${admitted.id} is missing.`);
        const { id: _id, ...receipt } = admitted;
        return { sub, ...receipt };
      });
    if (asyncMode) {
      const { sub, ...receipt } = await submit();
      return c.json({ submissionId: sub.id, ...receipt }, 202);
    }

    const wantsStream = c.req.query("stream") === "1" || (c.req.header("accept") ?? "").includes("text/event-stream");
    const settle = async (sub: Submission) => {
      const s = await sub.wait(context);
      if (s.status !== "done")
        return {
          submissionId: sub.id,
          status: s.status,
          reason: (s as { reason?: string }).reason ?? null,
          detail: (s as { detail?: unknown }).detail ?? null,
        };
      const ent = await conv.entries({}, 1, undefined, context); // newest first
      const answer =
        ent.items.find((e) => e.id === s.answer) ??
        (await harness.commit((tx) => tx.entry(s.answer as never), context).catch(() => undefined));
      return { submissionId: sub.id, status: "done", answer: textOf(answer) };
    };

    if (!wantsStream) {
      const { sub, ...receipt } = await submit();
      return c.json({ ...(await settle(sub)), ...receipt });
    }
    return streamSSE(c, async (stream) => {
      const feed = await openSessionFeed(harness, conv, undefined, context);
      let closed = false;
      const done = new Promise<void>((r) =>
        stream.onAbort(() => {
          closed = true;
          r();
        }),
      );
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify(projectSnapshotImages(feed.snapshot, conv.id)),
      });
      feed.start(async (events) => {
        if (closed) return;
        for (const e of withSubmissions(events)) {
          const projected = projectAgentEvent(e, conv.id);
          await stream.writeSSE({ event: (projected as { type: string }).type, data: JSON.stringify(projected) });
        }
      });
      try {
        const { sub, ...receipt } = await submit();
        await stream.writeSSE({ event: "submitted", data: JSON.stringify({ submissionId: sub.id, ...receipt }) });
        const result = await Promise.race([settle(sub), done.then(() => null)]);
        if (result) {
          // Explicit ordered flush of any queued frames before emitting terminal done frame
          await feed.flush();
          await stream.writeSSE({ event: "done", data: JSON.stringify(result) });
        }
      } finally {
        await feed.stop();
      }
    });
  };

  // These receipts fence commands whose side effects cannot be replayed after a lost response.
  // No source-session association is stored: the identity belongs to the destination only.
  const commands = new BackgroundCommandStore(conversationStorage(harness).db);
  app.get("/v1/sessions/:id/background-commands/:requestId", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const receipt = await harness.commit(() => commands.read(Number(conv.id), c.req.param("requestId")), context);
    return receipt ? c.json(receipt) : err(c, 404, "no such command receipt");
  });
  app.post("/v1/sessions/:id/background-commands", bodyLimit({ maxSize: 32 * 1024 * 1024,
    onError: c => err(c, 413, "message too large (32 MB max)") }), async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 200)
      return err(c, 400, "requestId required (at most 200 characters)");
    const parsed = parseInput(body.content);
    if (typeof parsed === "string" && typeof body.content !== "string") return err(c, 400, parsed);
    const text = typeof parsed === "string" ? parsed : parsed.filter(b => b.type === "text").map(b => b.text).join("\n");
    if (!text.trimStart().startsWith("/")) return err(c, 400, "slash command required");
    const sid = Number(conv.id), request = body.requestId;
    return serial(`background-command:${sid}:${request}`, async () => {
      let claimed: boolean;
      try { claimed = await harness.commit(() => commands.claim(sid, request, body.content), context); }
      catch (e) { return err(c, 409, (e as Error).message); }
      if (!claimed) {
        const receipt = commands.read(sid, request)!;
        if (receipt.state === "done") return c.json(receipt.result as object, receipt.status as 200);
        return err(c, 409, "Command delivery is uncertain. Open the destination session to inspect it; this command will not be repeated automatically.");
      }
      // Persist before returning. A crash leaves a non-replayable pending receipt.
      // Even a transport/response failure must never permit a command's effects to run twice.
      try {
        const response = await send(c, String(conv.id), body, true);
        const result: unknown = await response.clone().json();
        await harness.commit(() => commands.finish(sid, request, response.status, result), context);
        return response;
      } catch {
        const error = "Command delivery is uncertain. Open the destination session to inspect it; this command will not be repeated.";
        await harness.commit(() => commands.finish(sid, request, 500, { error }), context);
        return err(c, 500, error);
      }
    });
  });

  app.post("/v1/sessions/:id/messages", bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => err(c, 400, "message too large (32 MB max)") }), async (c) => {
    const asyncParam = c.req.query("async") === "1";
    return send(c, c.req.param("id"), await c.req.json().catch(() => ({})), asyncParam);
  });

  // Convenience: create-or-reuse session in one call. {message, sessionId?}
  app.post("/v1/chat", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      sessionId?: string;
      requestId?: string;
      whenBusy?: "steer" | "followUp" | "reject";
    };
    let id = b.sessionId;
    if (!id)
      id = (
        await harness.createConversation({ ownership: { kind: "ownerless" }, agent: baseAgent() }, context)
      ).id as unknown as string;
    return send(c, id, { content: b.message, requestId: b.requestId, whenBusy: b.whenBusy });
  });

  // Live viewers never own the run. Closing this connection only releases their observation.
  app.get("/v1/sessions/:id/events", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const isUi = c.req.query("view") === "ui";
    const afterParam = c.req.query("after");
    const afterId = afterParam !== undefined && Number.isSafeInteger(Number(afterParam)) ? Number(afterParam) : undefined;
    return streamSSE(c, async (stream) => {
      const feed = await openSessionFeed(
        harness,
        conv,
        afterId !== undefined ? { from: afterId + 1 } : undefined,
        context,
      );
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      stream.onAbort(finish);
      const stopSide = sideCommands.subscribe(String(conv.id), (job) => {
        void stream.writeSSE({ event: "side_job", data: JSON.stringify(jobView(job)) }).catch(finish);
      });
      const ping = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(finish);
      }, 15000);
      try {
        await stream.writeSSE({
          event: "side_jobs",
          data: JSON.stringify({ jobs: sideCommands.list(String(conv.id)).map(jobView) }),
        });
        // Drop hydrated entries before walking and validating their embedded image data.
        let snapshot = feed.snapshot;
        if (isUi && afterId !== undefined) {
          snapshot = { ...snapshot, entries: snapshot.entries.filter((e) => e.id > afterId) };
        }
        snapshot = projectSnapshotImages(snapshot, conv.id);
        if (isUi) snapshot = projectAgentEventForUi(snapshot) as typeof snapshot;
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify(snapshot),
        });
        feed.start(async (events) => {
          try {
            for (const event of withSubmissions(events)) {
              const source = isUi && event.type === "snapshot" && afterId !== undefined
                ? { ...event, entries: event.entries.filter(entry => entry.id > afterId) }
                : event;
              let projected = projectAgentEvent(source, conv.id);
              if (isUi) projected = projectAgentEventForUi(projected);
              await stream.writeSSE({ event: projected.type, data: JSON.stringify(projected) });
            }
          } catch {
            finish();
          }
        });
        await Promise.race([done, feed.closed, harness.closed]);
      } finally {
        stopSide();
        clearInterval(ping);
        await feed.stop();
      }
    });
  });

  // Cross-device list invalidations; payloads contain no transcript and writes are serialized/coalesced.
  app.get("/v1/events", (c) =>
    streamSSE(c, async (stream) => {
      let finish!: () => void,
        timer: ReturnType<typeof setTimeout> | undefined,
        dirty = false,
        boardDirty = false,
        analyticsDirty = false,
        writing = false,
        closed = false;
      const done = new Promise<void>((r) => (finish = r));
      stream.onAbort(finish);
      const flush = async () => {
        timer = undefined;
        if (closed || writing || (!dirty && !boardDirty && !analyticsDirty)) return;
        const sessions = dirty,
          board = boardDirty,
          analytics = analyticsDirty;
        dirty = boardDirty = analyticsDirty = false;
        writing = true;
        try {
          if (sessions) await stream.writeSSE({ event: "sessions_changed", data: "{}" });
          if (board) await stream.writeSSE({ event: "board_changed", data: "{}" });
          if (analytics) await stream.writeSSE({ event: "analytics_changed", data: "{}" });
        } catch {
          finish();
        } finally {
          writing = false;
          if ((dirty || boardDirty || analyticsDirty) && !closed) timer = setTimeout(flush, 100);
        }
      };
      const arm = () => {
        if (!timer && !writing && !closed) timer = setTimeout(flush, 100);
      };
      const changed = () => {
        dirty = true;
        arm();
      };
      const boardChanged = () => {
        boardDirty = true;
        arm();
      };
      // Register BEFORE the initial event, so creation during attachment cannot be missed.
      const observation = harness.observeCommits({
        advance(publication) {
          if (
            publication.changes.some(
              (change) =>
                change.type === "conversation" ||
                change.type === "entry" ||
                change.type === "task" ||
                change.type === "submission" ||
                (change.type === "document" &&
                  [
                    "luna.ask",
                    "luna.goal",
                    "luna.session-handoff",
                    "luna.session-review",
                    "luna.session-read",
                    "luna.scheduled-messages",
                    "luna.scheduled-recovery",
                  ].includes(change.record.kind)),
            )
          )
            changed();
        },
        end() {
          // Session lifecycle closed/failed
        },
      });
      const unsubscribeMeta = opts.conversations?.subscribeChanges(changed);
      const unsubscribeBoard = opts.conversations?.subscribeBoard(boardChanged);
      const unsubscribeAnalytics = analyticsService(harness).subscribe(() => { analyticsDirty = true; arm(); });
      const ping = setInterval(() => {
        if (!writing) void stream.writeSSE({ event: "ping", data: "{}" }).catch(finish);
      }, 15000);
      try {
        dirty = true;
        await flush();
        await Promise.race([done, harness.closed]);
      } finally {
        closed = true;
        clearInterval(ping);
        clearTimeout(timer);
        observation.detach();
        unsubscribeMeta?.();
        unsubscribeBoard?.();
        unsubscribeAnalytics();
      }
    }),
  );

  // ---- tools ----
  app.get("/v1/tools", async (c) => {
    const root = await harness.root(context);
    const a = await root.agent(context);
    const shape = (t: { name: string; description?: string; parameters?: unknown }) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? null,
    });
    return c.json({ tools: a.tools.map(shape), deferred: a.deferred.map(shape) });
  });
}
