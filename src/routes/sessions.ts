import type { Hono } from "hono";
import {
  LiveDoc,
  UsageDoc,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { GENERAL_PROJECT } from "../projects.js";
import { isRunning, readSessionStatus, markSessionRead } from "../session-status.js";
import { Children, DELEGATE_CHILD, readChildReport, type ChildRow } from "../delegate-state.js";
import { crewLead } from "../crew-state.js";
import { readDelegationUsage } from "../delegate-usage.js";
import { GoalDoc } from "../goal-doc.js";
import { SpeedDoc } from "../speed.js";
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
import {
  SessionCreationDoc,
  sessionPayloadHash,
} from "../session-creation.js";
import type { ConversationMeta } from "../conversations.js";
import { projectEntryImages } from "../session-images.js";
import { projectEntryForUi, extractFullToolResult } from "../session-history-view.js";
import { activeContextTokens } from "../context-usage.js";
import { type RouteCtx, type ActiveConversation } from "./context.js";
import { createSessionRows } from "./session-rows.js";
import {
  type SessionItem,
  type GroupSummary,
  decodeCursor,
  encodeCursor,
  compareSessions,
  isAfterCursor,
} from "./session-list.js";

export function registerSessions(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv, baseAgent, resumeAt } = ctx;
  const { listRows } = createSessionRows(ctx);

  app.get("/v1/sessions", async (c) => {
    const rawQueries = c.req.queries();
    const queryKeys = Object.keys(rawQueries);
    const isPaginated = queryKeys.length > 0;

    // Parameter parsing and strict validation when any query param is provided
    let limit = 50;
    let archivedFilter: "0" | "1" | "all" = "0";
    let projectFilter: "all" | "none" | number = "all";
    let workerFilter: "all" | "main" | number = "all";
    let searchQuery: string | null = null;
    let cursorStr: string | null = null;
    let idsFilter: number[] | null = null;
    let runningFilter = false;
    let statusFilter: Set<string> | null = null;

    if (isPaginated) {
      const allowedParams = new Set(["limit", "archived", "project", "worker", "q", "cursor", "ids", "running", "status"]);
      for (const k of queryKeys) {
        if (rawQueries[k]!.length !== 1) return err(c, 400, `duplicate query parameter: ${k}`);
        if (!allowedParams.has(k)) {
          return err(c, 400, `unknown query parameter: ${k}`);
        }
      }

      if (c.req.query("limit") !== undefined) {
        const rawLimit = Number(c.req.query("limit"));
        if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
          return err(c, 400, "limit must be an integer between 1 and 100");
        }
        limit = rawLimit;
      }

      if (c.req.query("archived") !== undefined) {
        const rawArchived = c.req.query("archived");
        if (rawArchived !== "0" && rawArchived !== "1" && rawArchived !== "all") {
          return err(c, 400, "archived must be 0, 1, or all");
        }
        archivedFilter = rawArchived;
      }

      if (c.req.query("project") !== undefined) {
        const rawProject = c.req.query("project");
        if (rawProject === "none") {
          projectFilter = "none";
        } else {
          const num = Number(rawProject);
          if (!Number.isSafeInteger(num) || num <= 0) {
            return err(c, 400, "project must be none or a positive integer id");
          }
          projectFilter = num;
        }
      }

      if (c.req.query("worker") !== undefined) {
        const rawWorker = c.req.query("worker");
        if (rawWorker === "main") {
          workerFilter = "main";
        } else {
          const num = Number(rawWorker);
          if (!Number.isSafeInteger(num) || num <= 0) {
            return err(c, 400, "worker must be main or a positive integer id");
          }
          workerFilter = num;
        }
      }

      if (c.req.query("q") !== undefined) {
        searchQuery = c.req.query("q")!;
      }

      if (c.req.query("cursor") !== undefined) {
        cursorStr = c.req.query("cursor")!;
      }

      if (c.req.query("ids") !== undefined) {
        const rawIds = c.req.query("ids")!.split(",");
        const parsedIds: number[] = [];
        for (const item of rawIds) {
          const s = item.trim();
          if (!s) return err(c, 400, "ids contains empty element");
          const n = Number(s);
          if (!Number.isSafeInteger(n) || n <= 0) {
            return err(c, 400, "ids must be comma-separated positive integer ids");
          }
          parsedIds.push(n);
        }
        if (parsedIds.length === 0 || parsedIds.length > 100) {
          return err(c, 400, "ids must contain between 1 and 100 positive integer ids");
        }
        idsFilter = parsedIds;
      }

      if (c.req.query("running") !== undefined) {
        const rawRunning = c.req.query("running");
        if (rawRunning !== "1") {
          return err(c, 400, "running must be 1");
        }
        runningFilter = true;
      }

      if (c.req.query("status") !== undefined) {
        const list = c.req.query("status")!.split(",").map((x) => x.trim()).filter(Boolean);
        if (!list.length) return err(c, 400, "status must list at least one status");
        statusFilter = new Set(list);
      }
    }

    const cursor = cursorStr === null ? null : decodeCursor(cursorStr);
    if (cursorStr !== null && !cursor) return err(c, 400, "malformed cursor");

    // Title = first user message. Subagent children (delegate.child marker) are hidden from the list.
    const built = await listRows();
    const links = opts.conversations?.projects.links();
    const continuing = !!opts.limitContinuer?.enabled();
    const recoveryBudget = opts.limitContinuer?.attemptLimit();
    const sessions: SessionItem[] = [];
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
    sessions.sort(compareSessions);

    if (!isPaginated) {
      return c.json({ sessions });
    }

    // Compute groups over ALL visible metadata excluding delegate children
    // Groups ignore project, worker, and q filters.
    // They use archived filter for count, statuses, machines, lastActivity.
    // activity is max timestamp across BOTH archive modes for project ordering.
    // Group keys: named project id string, or 'none' for General (id 0) / unassigned / unknown project.
    const projectsList = opts.conversations?.projects.list() ?? [];
    const knownProjectIds = new Set<number>(projectsList.map((p) => p.id));

    const groups: Record<string, GroupSummary> = {};
    for (const s of sessions) {
      const pid = s.project;
      const groupKey = pid !== null && pid !== 0 && knownProjectIds.has(pid) ? String(pid) : "none";

      if (!groups[groupKey]) {
        groups[groupKey] = {
          count: 0,
          lastActivity: 0,
          activity: 0,
          statuses: {},
          machines: {},
        };
      }
      const g = groups[groupKey];
      const sessionAct = (s.lastActivity ?? s.createdAt ?? 0);
      if (sessionAct > g.activity) {
        g.activity = sessionAct;
      }

      const matchesArchived =
        archivedFilter === "all" ||
        (archivedFilter === "1" && s.archived) ||
        (archivedFilter === "0" && !s.archived);

      if (matchesArchived) {
        g.count++;
        if (sessionAct > g.lastActivity) {
          g.lastActivity = sessionAct;
        }
        g.statuses[s.status] = (g.statuses[s.status] ?? 0) + 1;
        const machineKey = s.worker === null ? "main" : String(s.worker);
        g.machines[machineKey] = (g.machines[machineKey] ?? 0) + 1;
      }
    }

    const projectNameMap = new Map<number, string>();
    for (const p of projectsList) {
      projectNameMap.set(p.id, p.name);
    }

    // Tokenized search preparation
    const searchTokens = searchQuery
      ? searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
      : [];

    // Filter matching sessions
    const matching: SessionItem[] = [];
    for (const s of sessions) {
      // 1. Archived filter
      if (archivedFilter === "0" && s.archived) continue;
      if (archivedFilter === "1" && !s.archived) continue;

      // 2. Background notification tracking: running and/or ids
      if (idsFilter && runningFilter) {
        const matchesId = idsFilter.includes(Number(s.id));
        const matchesRunning = s.running || s.status === "reviewing";
        if (!matchesId && !matchesRunning) continue;
      } else if (idsFilter) {
        if (!idsFilter.includes(Number(s.id))) continue;
      } else if (runningFilter) {
        if (!s.running && s.status !== "reviewing") continue;
      }

      if (statusFilter && !statusFilter.has(s.status)) continue;

      // 3. Project filter
      if (projectFilter !== "all") {
        const isGeneralOrUnknown = s.project === null || s.project === 0 || !knownProjectIds.has(s.project);
        if (projectFilter === "none") {
          if (!isGeneralOrUnknown) continue;
        } else {
          if (s.project !== projectFilter) continue;
        }
      }

      // 4. Worker filter
      if (workerFilter !== "all") {
        if (workerFilter === "main") {
          if (s.worker !== null) continue;
        } else {
          if (s.worker !== workerFilter) continue;
        }
      }

      // 5. Search query (q)
      if (searchTokens.length > 0) {
        const sidStr = String(s.id);
        const titleStr = (s.title || `Conversation ${s.id}`).toLowerCase();
        let projName = "";
        if (s.project !== null) {
          projName = (projectNameMap.get(s.project) ?? "").toLowerCase();
        }
        const matchesAll = searchTokens.every(
          (t) => sidStr.includes(t) || titleStr.includes(t) || projName.includes(t),
        );
        if (!matchesAll) continue;
      }

      matching.push(s);
    }

    const total = matching.length;

    // Apply cursor
    let startIndex = 0;
    if (cursor) {
      startIndex = matching.findIndex((s) => isAfterCursor(s, cursor));
      if (startIndex === -1) {
        startIndex = matching.length;
      }
    }

    const pagedSessions = matching.slice(startIndex, startIndex + limit);
    let nextCursor: string | null = null;
    if (startIndex + limit < matching.length && pagedSessions.length > 0) {
      const lastItem = pagedSessions[pagedSessions.length - 1]!;
      nextCursor = encodeCursor(lastItem);
    }

    return c.json({
      sessions: pagedSessions,
      nextCursor,
      total,
      groups,
    });
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
        Object.keys(b).some((k) => !["days", "includeArchived", "excludeIds", "projectId", ...(preview ? [] : ["ids"])].includes(k)) ||
        !Number.isSafeInteger(b.days) ||
        b.days < 1 ||
        !Number.isSafeInteger(b.days * 86400000) ||
        typeof b.includeArchived !== "boolean" ||
        !ids(b.excludeIds) ||
        ("projectId" in b && !(Number.isSafeInteger(b.projectId) && b.projectId > 0)) ||
        (!preview && !ids(b.ids))
      ) {
        return err(c, 400, "positive whole days, includeArchived, excludeIds, and confirmed ids for deletion required; projectId must be a positive integer");
      }
      const selected = await opts.conversations.prune(b, preview ? undefined : b.ids, async (id, tx) => {
        if (ctx.sideCommands.list(String(id)).some((job) => job.status === "running")) return true;
        const owner = (await tx.doc(ProcessOwner, id as ConversationId)).token;
        return harness.busyTools?.sessionProcesses(id as ConversationId, owner).some((p) => p.status === "running") ?? false;
      });
      if (!preview) await opts.limitContinuer?.reconcile();
      return c.json(preview ? selected : { deleted: selected.ids });
    });

  app.patch("/v1/sessions/:id/metadata", async (c) => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const b = await c.req.json().catch(() => null);
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      !Object.keys(b).length ||
      Object.keys(b).some((k) => !["title", "archived", "pinned", "project"].includes(k))
    )
      return err(c, 400, "title, archived, pinned or project required");
    if ("title" in b && (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > 200))
      return err(c, 400, "title must contain 1 to 200 characters");
    for (const k of ["archived", "pinned"])
      if (k in b && typeof b[k] !== "boolean") return err(c, 400, k + " must be a boolean");
    if ("project" in b && !(Number.isSafeInteger(b.project) && b.project > 0)) return err(c, 400, "project must be a positive integer");
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    if ("project" in b) {
      await opts.conversations.move(id, b.project);
      if (Object.keys(b).length === 1) return c.json({ ...opts.conversations.get(id), project: b.project });
    }
    const { project: _p, ...rest } = b;
    const changes = { ...rest, ...("title" in b ? { title: b.title.trim() } : {}) } as Partial<ConversationMeta>;
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

  app.get("/v1/session-creations/:requestId", async (c) => {
    const requestId = c.req.param("requestId");
    if (!requestId || !requestId.trim() || requestId.length > 200) {
      return err(c, 400, "requestId must be a nonempty string at most 200 characters");
    }
    const snap = await harness.snapshot(SessionCreationDoc, requestId, context);
    if (!snap || !snap.sessionId) {
      return err(c, 404, "no session creation found for this requestId");
    }
    const conv = await harness.conversation(snap.sessionId as ConversationId, context);
    if (!conv) {
      return c.json({ error: "session deleted", sessionId: snap.sessionId }, 410);
    }
    return c.json({ id: snap.sessionId });
  });

  app.get("/v1/sessions/:id/submissions/by-request/:requestId", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const requestId = c.req.param("requestId");
    if (!requestId || !requestId.trim() || requestId.length > 200) {
      return err(c, 400, "requestId must be a nonempty string at most 200 characters");
    }
    const record = await harness.commit((tx) => tx.submissionByRequest(conv.id, requestId), context);
    if (!record) {
      return err(c, 404, "submission not found");
    }
    return c.json(record);
  });

  app.post("/v1/sessions", async (c) => {
    const b = (await c.req.json().catch(() => null)) as SessionRequest | null;
    if (!b || typeof b !== "object" || Array.isArray(b)) return err(c, 400, "session parameters must be an object");
    if (b.requestId !== undefined && (typeof b.requestId !== "string" || !b.requestId.trim() || b.requestId.length > 200))
      return err(c, 400, "requestId must be a nonempty string at most 200 characters");
    let plan;
    try {
      plan = planSession(
        {
          base: baseAgent,
          thinking: ctx.thinkingDefaults,
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

    if (b.requestId !== undefined) {
      const { requestId, ...parameters } = b;
      const payloadHash = sessionPayloadHash(parameters);
      // The mapping and conversation are durable changes in the SAME storage transaction.
      const result = await harness.commit(async tx => {
        const doc = await tx.doc(SessionCreationDoc, requestId, { sessionId: 0, payloadHash });
        if (doc.sessionId) {
          if (doc.payloadHash !== payloadHash)
            return { error: "requestId already used with different session creation parameters", status: 409 as const };
          if (!await tx.conversation(doc.sessionId as ConversationId))
            return { error: "session previously created with this requestId has been deleted", status: 410 as const };
          return { id: doc.sessionId, created: false };
        }
        const id = await createPlannedSession(tx, plan);
        doc.sessionId = id;
        return { id: Number(id), created: true };
      }, context);
      if ("error" in result) return c.json({ error: result.error }, result.status);
      // Repair interrupted initial linkage on replay, but never undo a later user project move.
      const projects = opts.conversations?.projects;
      if (result.created || !projects?.links().has(result.id)) linkProject(projects, result.id, plan);
      return c.json({ id: result.id }, result.created ? 201 : 200);
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

  app.get("/v1/sessions/:id/entries/:entryId/tool-result", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const entryId = Number(c.req.param("entryId"));
    if (!Number.isSafeInteger(entryId) || entryId < 0) return err(c, 400, "invalid entryId");
    const page = await conv
      .entries({ minEntryId: entryId as never, maxEntryId: entryId as never }, 1, undefined, context)
      .catch(() => undefined);
    const entry = page?.items[0];
    if (!entry || entry.id !== entryId) return err(c, 404, "no such entry in this session");
    const toolCallId = c.req.query("toolCallId");
    const result = extractFullToolResult(entry, toolCallId);
    if (!result) return err(c, 404, "no tool result found in this entry");
    c.header("Cache-Control", "private, no-store");
    return c.json({
      entryId: entry.id,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      text: result.text,
      originalBytes: result.originalBytes,
      truncated: result.truncated,
    });
  });

  // Lightweight index of every user message, so the UI rail works before older entries are loaded.
  app.get("/v1/sessions/:id/user-messages", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const out: { id: number; label: string }[] = [];
    let cursor: { after: number; order: "descending" } | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = await conv.entries({ order: "descending" }, 500, cursor as never, context);
      for (const entry of page.items) {
        const user = (entry.model ?? []).find((m: any) => m.role === "user") as any;
        if (!user) continue;
        const text = (typeof user.content === "string" ? user.content
          : Array.isArray(user.content) ? user.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "")
          .replace(/\s+/g, " ").trim();
        if (entry.kind === "pi.user" && /^Background process [a-f0-9-]+ finished:/.test(text)) continue;
        out.push({ id: Number(entry.id), label: text.length > 80 ? text.slice(0, 80) + "…" : text || "Message" });
      }
      if (page.next === undefined) break;
      cursor = { after: page.next.after as number, order: "descending" };
    }
    c.header("Cache-Control", "private, no-store");
    return c.json({ messages: out.reverse() });
  });

  app.get("/v1/sessions/:id", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const requestedLimit = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), 500)) : 50;
    const beforeParam = c.req.query("before");
    const beforeId = beforeParam ? Number(beforeParam) : undefined;
    if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 0)) return err(c, 400, "invalid before cursor");
    const cursor = beforeId !== undefined && Number.isSafeInteger(beforeId)
      ? { after: beforeId, order: "descending" as const }
      : undefined;
    // Independent reads. Issue them together so one slow read does not queue the others behind it.
    const [page, a, usage, kids, todo, ask, goal, speed] = await Promise.all([
      conv.entries({ order: "descending" }, limit, cursor, context),
      conv.agent(context),
      harness.snapshot(UsageDoc, conv.id, context).catch(() => undefined),
      harness.snapshot(Children, conv.id, context).catch(() => undefined),
      harness.snapshot(TodoDoc, conv.id, context).catch(() => undefined),
      harness.snapshot(AskDoc, conv.id, context).catch(() => undefined),
      harness.snapshot(GoalDoc, conv.id, context).catch(() => undefined),
      harness.snapshot(SpeedDoc, conv.id, context).catch(() => undefined),
    ]);
    const { running, parentSessionId, ...sessionStatus } = await harness.commit(async (tx) => {
      const running = await isRunning(tx, conv.id);
      const status = await readSessionStatus(tx, conv.id, running);
      const record = await tx.conversation(conv.id);
      // Fork ancestry alone is not delegation. Read only this session's own creation entries.
      const head = await tx.scanEntries({ conversationId: conv.id, order: "ascending",
        ...(record?.parent ? { minEntryId: (Number(record.parent.at) + 1) as EntryId } : {}),
      }, 30);
      const marker = head.items.find(e => e.kind === DELEGATE_CHILD && e.conversationId === conv.id);
      const parent = (marker?.data as { parent?: number } | undefined)?.parent;
      const delegateParent = typeof parent === "number" && Number.isSafeInteger(parent) && parent > 0 && parent !== Number(conv.id)
        && await tx.conversation(parent as ConversationId) ? parent : null;
      const parentSessionId = delegateParent ?? (Number(await crewLead(tx, conv.id)) || null);
      // Mark read in the same commit. readSessionStatus reads the doc before the mark,
      // so this GET returns the completion status; subsequent reads see "ready".
      if (!running && ["finished", "review_finished"].includes(status.status)) await markSessionRead(tx, conv.id);
      return {
        running,
        parentSessionId,
        ...status,
        resumeAt: await resumeAt(tx, conv.id, running),
        recovery: running ? null : ((await opts.limitContinuer?.recovery(tx, conv.id)) ?? null),
      };
    }, context);

    const isUiView = c.req.query("view") === "ui";
    const mappedEntries = page.items.map((entry) => {
      const imgProjected = projectEntryImages(entry, conv.id);
      return isUiView ? projectEntryForUi(imgProjected) : imgProjected;
    });

    return c.json({
      id: conv.id,
      parentSessionId,
      project: opts.conversations?.projects.projectOf(Number(conv.id)) ?? null,
      running,
      status: sessionStatus.status,
      statusReason: sessionStatus.statusReason,
      resumeAt: sessionStatus.resumeAt,
      recovery: sessionStatus.recovery,
      agent: {
        model: a.model ?? null,
        thinkingLevel: a.thinkingLevel,
        speed: speed?.speed ?? null,
        cwd: a.cwd ?? null,
        instructions: a.instructions ?? null,
        tools: a.tools.map((t) => t.name),
      },
      machine: await machineOf(conv.id),
      usage: usage ?? null,
      // Context derivation scans the active transcript. UI clients fetch it separately after hydration.
      contextUsage: isUiView && c.req.query("context") !== "1" ? null : await contextUsage(conv),
      children: await childViews(conv.id, kids?.children ?? []),
      delegationUsage: kids?.children.length
        ? await harness.commit((tx) => readDelegationUsage(tx, conv.id), context)
        : null,
      processes: await processesOf(conv.id),
      todos: (todo?.tasks ?? []).filter((t) => t.status !== "deleted"),
      questions: ask?.pending ?? [],
      goal: goal?.goal ?? null,
      entries: mappedEntries,
      hasMore: page.next !== undefined,
      nextCursor: page.next ? (page.next.after as number) : null,
    });
  });
}
