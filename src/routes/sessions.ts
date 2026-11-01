import type { Hono } from "hono";
import {
  LiveDoc,
  UsageDoc,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { GENERAL_PROJECT } from "../projects.js";
import { isRunning, readSessionStatus, markSessionRead, type SessionState } from "../session-status.js";
import { Children, readChildReport, type ChildRow } from "../delegate-state.js";
import { readDelegationUsage } from "../delegate-usage.js";
import { GoalDoc } from "../goal-doc.js";
import { context, ProcessOwner } from "../luna.js";
import { TodoDoc } from "../todo.js";
import { AskDoc } from "../ask.js";
import { ExecTarget } from "../workers.js";
import {
  createPlannedSession,
  linkProject,
  planSession,
  SessionCreateError,
  type SessionRequest,
} from "../session-create.js";
import type { ConversationMeta } from "../conversations.js";
import type { RecoverySummary } from "../limit-continue.js";
import { projectEntryImages } from "../session-images.js";
import { activeContextTokens } from "../context-usage.js";
import { type RouteCtx, type ActiveConversation } from "./context.js";
import { createSessionRows } from "./session-rows.js";

export function registerSessions(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv, baseAgent, resumeAt } = ctx;
  const { listRows } = createSessionRows(ctx);

  app.get("/v1/sessions", async (c) => {
    // Title = first user message. Subagent children (delegate.child marker) are hidden from the list.
    const built = await listRows();
    const links = opts.conversations?.projects.links();
    const continuing = !!opts.limitContinuer?.enabled();
    const recoveryBudget = opts.limitContinuer?.attemptLimit();
    const sessions: (SessionState & {
      id: unknown;
      parent: unknown;
      project: number | null;
      title: string;
      archived: boolean;
      pinned: boolean;
      running: boolean;
      resumeAt: number | null;
      recovery: RecoverySummary | null;
      lastActivity: number | null;
      createdAt: number | null;
      worker: number | null;
    })[] = [];
    for (const [id, row] of built) {
      if (row.hidden) continue;
      const { hidden: _hidden, firstUser, wait, recovery, ...rest } = row;
      const meta = opts.conversations?.get(id) ?? { title: null, archived: false, pinned: false };
      sessions.push({
        ...rest,
        id,
        project: links?.get(id) ?? (opts.conversations ? GENERAL_PROJECT.id : null),
        ...meta,
        title: meta.title ?? firstUser,
        resumeAt: continuing && !row.running ? wait : null,
        recovery:
          !row.running && (continuing || recovery?.pausedReason) && recovery
            ? { ...recovery, maxAttempts: recoveryBudget ?? recovery.maxAttempts }
            : null,
      });
    }
    sessions.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) ||
        Number(b.id) - Number(a.id),
    );
    return c.json({ sessions });
  });

  // POST preview avoids query-string coercion and shares strict validation with confirmation.
  for (const preview of [true, false]) app.post(preview ? "/v1/sessions/prune/preview" : "/v1/sessions/prune", async c => {
      if (!opts.conversations) return err(c, 404, "conversation management disabled");
      const b = await c.req.json().catch(() => null);
      const ids = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && n > 0);
      if (
        !b ||
        typeof b !== "object" ||
        Array.isArray(b) ||
        Object.keys(b).some((k) => !["days", "includeArchived", "excludeIds", ...(preview ? [] : ["ids"])].includes(k)) ||
        !Number.isSafeInteger(b.days) ||
        b.days < 1 ||
        !Number.isSafeInteger(b.days * 86400000) ||
        typeof b.includeArchived !== "boolean" ||
        !ids(b.excludeIds) ||
        (!preview && !ids(b.ids))
      ) {
        return err(c, 400, "positive whole days, includeArchived, excludeIds, and confirmed ids for deletion required");
      }
      const selected = await opts.conversations.prune(b, preview ? undefined : b.ids, async (id, tx) => {
        if (ctx.sideCommands.list(String(id)).some((job) => job.status === "running")) return true;
        const owner = (await tx.doc(ProcessOwner, id as ConversationId)).token;
        return harness.busyTools?.sessionProcesses(id as ConversationId, owner).some((p) => p.status === "running") ?? false;
      });
      if (!preview) await opts.limitContinuer?.reconcile();
      return c.json(preview ? { ids: selected } : { deleted: selected });
    });

  app.patch("/v1/sessions/:id/metadata", async (c) => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const b = await c.req.json().catch(() => null);
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      !Object.keys(b).length ||
      Object.keys(b).some((k) => !["title", "archived", "pinned"].includes(k))
    )
      return err(c, 400, "title, archived or pinned required");
    if ("title" in b && (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > 200))
      return err(c, 400, "title must contain 1 to 200 characters");
    for (const k of ["archived", "pinned"])
      if (k in b && typeof b[k] !== "boolean") return err(c, 400, k + " must be a boolean");
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    const changes = { ...b, ...("title" in b ? { title: b.title.trim() } : {}) } as Partial<ConversationMeta>;
    if (changes.archived) await opts.limitContinuer?.cancel(id, "Session archived.");
    return c.json(await opts.conversations.update(id, changes));
  });

  app.get("/v1/session-titles", (c) => c.json({ available: !!opts.titler?.available() }));

  app.post("/v1/sessions/:id/title", async (c) => {
    if (!opts.conversations || !opts.titler) return err(c, 404, "session titles disabled");
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    try {
      return c.json({ title: await opts.titler.generate(id, true) });
    } catch (e) {
      const m = (e as Error).message;
      return err(
        c,
        m === "no such session" ? 404 : m.startsWith("No session-title") || m.startsWith("The session needs") ? 409 : 500,
        m,
      );
    }
  });

  app.delete("/v1/sessions/:id", async (c) => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    await opts.limitContinuer?.cancel(id, "Session deleted.");
    const deleted = await opts.conversations.delete(id);
    await opts.limitContinuer?.reconcile();
    return c.json({ deleted });
  });

  app.post("/v1/sessions", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as SessionRequest;
    let plan;
    try {
      plan = planSession(
        {
          base: baseAgent,
          models: opts.models,
          projects: opts.conversations?.projects,
          workers: opts.workers?.store,
          projectExtensions: opts.projectExtensions,
        },
        b,
      );
    } catch (e) {
      if (e instanceof SessionCreateError) return err(c, e.status, e.message);
      throw e;
    }
    const id = await harness.commit((tx) => createPlannedSession(tx, plan), context);
    linkProject(opts.conversations?.projects, Number(id), plan);
    return c.json({ id }, 201);
  });

  // Fork: a new session whose model context starts as of one visible entry of this session. The stored agent
  // state (model, thinking level, tools) rides along in the built-in `pi.agent` document (rewindable, fork asOf);
  // `ExecTarget` is fork `current`, so the worker target survives. Docs marked fork `initial` (goal, ask, ...) stay behind.
  app.post("/v1/sessions/:id/fork", async (c) => {
    if (!opts.conversations) return err(c, 404, "fork disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = (await c.req.json().catch(() => ({}))) as { at?: unknown };
    if (!Number.isSafeInteger(b.at)) return err(c, 400, "at must be an entry id");
    let badEntry: string | null = null;
    const forked = await harness.commit(async (tx) => {
      // One commit: fork at one visible entry. Visibility is pi-durable's rule, and it is fork-aware: an entry
      // inherited from a parent conversation (shown in this session's transcript) counts. The stored agent state
      // (model, thinking, tools) rides along via the built-in `pi.agent` document copies in this commit.
      try {
        return await tx.forkConversation(conv.id, b.at as EntryId, { ownership: { kind: "ownerless" } });
      } catch (e) {
        if (/not visible from conversation/.test((e as Error).message)) {
          badEntry = (e as Error).message;
          return undefined;
        }
        throw e;
      }
    }, context);
    if (badEntry !== null || !forked) return err(c, 404, "entry is not visible in this session");
    const project = opts.conversations.projects.projectOf(Number(conv.id));
    if (project) opts.conversations.projects.link(Number(forked.id), project);
    return c.json({ id: forked.id }, 201);
  });

  const contextUsage = async (conv: ActiveConversation) => {
    const agent = await conv.agent(context);
    const model = agent.model && opts.models?.getModel(agent.model.provider, agent.model.modelId);
    const capacity =
      model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
    const view = await conv.context(context);
    const usedTokens = activeContextTokens(view);
    const live = await harness.snapshot(LiveDoc, conv.id, context);
    return {
      usedTokens,
      contextWindow: capacity,
      percent: capacity === null ? null : (usedTokens / capacity) * 100,
      estimated: true as const,
      compacting: (live?.compactions?.length ?? 0) > 0,
    };
  };

  app.get("/v1/sessions/:id/context", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json(await contextUsage(conv));
  });

  // ---- session activity: background processes and subagents owned by one conversation ----
  const processOwner = async (id: ConversationId) =>
    (await harness.snapshot(ProcessOwner, id, context).catch(() => undefined))?.token ?? "legacy";
  const processesOf = async (id: ConversationId) =>
    harness.busyTools ? harness.busyTools.sessionProcesses(id, await processOwner(id)) : [];
  const childViews = (parent: ConversationId, rows: ChildRow[]) =>
    harness.commit(
      async (tx) =>
        Promise.all(
          rows.map(async (row) => {
            if (!(await tx.conversation(row.id as ConversationId)))
              return { id: row.id, task: row.task, status: "deleted" as const, statusReason: null };
            const report = await readChildReport(tx, parent, row.id);
            const status =
              report.state === "done"
                ? "finished"
                : report.state === "idle"
                  ? "ready"
                  : report.state === "unanswered"
                    ? "failed"
                    : report.state;
            return {
              id: row.id,
              task: row.task,
              status,
              statusReason: report.reason ?? null,
              profile: row.profile ?? null,
              cwd: row.cwd ?? null,
              resultStatus: report.resultStatus,
            };
          }),
        ),
      context,
    );

  app.get("/v1/sessions/:id/processes/:pid", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const view = harness.busyTools?.sessionProcess(conv.id, await processOwner(conv.id), c.req.param("pid"));
    return view ? c.json(view) : err(c, 404, "no such background process in this session");
  });

  app.post("/v1/sessions/:id/processes/:pid/stop", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const view = harness.busyTools?.stopSessionProcess(conv.id, await processOwner(conv.id), c.req.param("pid"));
    return view ? c.json(view) : err(c, 404, "no such background process in this session");
  });

  const machineOf = async (id: ConversationId) => {
    const worker = (await harness.snapshot(ExecTarget, id, context).catch(() => undefined))?.worker ?? null;
    if (worker === null) return null;
    const w = opts.workers?.view(worker);
    return w ? { id: w.id, name: w.name, online: w.online } : { id: worker, name: null, online: false };
  };

  app.get("/v1/sessions/:id", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 500);
    const page = await conv.entries({ order: "descending" }, limit, undefined, context);
    const a = await conv.agent(context);
    const usage = await harness.snapshot(UsageDoc, conv.id, context).catch(() => undefined);
    const kids = await harness.snapshot(Children, conv.id, context).catch(() => undefined);
    const todo = await harness.snapshot(TodoDoc, conv.id, context).catch(() => undefined);
    const ask = await harness.snapshot(AskDoc, conv.id, context).catch(() => undefined);
    const goal = await harness.snapshot(GoalDoc, conv.id, context).catch(() => undefined);
    const { running, ...sessionStatus } = await harness.commit(async (tx) => {
      const running = await isRunning(tx, conv.id);
      const status = await readSessionStatus(tx, conv.id, running);
      // Mark read in the same commit. readSessionStatus reads the doc before the mark,
      // so this GET returns the completion status; subsequent reads see "ready".
      if (!running && ["finished", "review_finished"].includes(status.status)) await markSessionRead(tx, conv.id);
      return {
        running,
        ...status,
        resumeAt: await resumeAt(tx, conv.id, running),
        recovery: running ? null : ((await opts.limitContinuer?.recovery(tx, conv.id)) ?? null),
      };
    }, context);
    return c.json({
      id: conv.id,
      project: opts.conversations?.projects.projectOf(Number(conv.id)) ?? null,
      running,
      status: sessionStatus.status,
      statusReason: sessionStatus.statusReason,
      resumeAt: sessionStatus.resumeAt,
      recovery: sessionStatus.recovery,
      agent: {
        model: a.model ?? null,
        thinkingLevel: a.thinkingLevel,
        cwd: a.cwd ?? null,
        instructions: a.instructions ?? null,
        tools: a.tools.map((t) => t.name),
      },
      machine: await machineOf(conv.id),
      usage: usage ?? null,
      contextUsage: await contextUsage(conv),
      children: await childViews(conv.id, kids?.children ?? []),
      delegationUsage: kids?.children.length
        ? await harness.commit((tx) => readDelegationUsage(tx, conv.id), context)
        : null,
      processes: await processesOf(conv.id),
      todos: (todo?.tasks ?? []).filter((t) => t.status !== "deleted"),
      questions: ask?.pending ?? [],
      goal: goal?.goal ?? null,
      entries: page.items.map((entry) => projectEntryImages(entry, conv.id)),
    });
  });
}
