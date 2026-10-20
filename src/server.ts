import { BusyCommandError, DEFAULT_BUSY_INPUT, feedback, interruptBlocked, parseQueueCommand, queueCommand, type BusyMode, type BusyPolicy } from "./busy-input.js";
import { ProjectError } from "./projects.js";
import { BoardError } from "./board.js";
import { ConversationError, type ConversationStore, type ConversationMeta } from "./conversations.js";
// HTTP + SSE API over the durable Luna harness. Transport-only: all state lives in the harness (SQLite).
import { Hono, type Context as HonoContext } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { createWebApp } from "./web-assets.js";
import { newestMessageTime, SessionCreated } from "./session-activity.js";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { LiveDoc, UsageDoc, watchEvents, type Tx, type ConversationId, type UserInput } from "@earendil-works/pi-durable";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { AskDoc, checkAnswer } from "./ask.js";
import { readSessionStatus, markSessionRead, type SessionState } from "./session-status.js";
import { Children } from "./delegate.js";
import { GoalDoc } from "./goal.js";
import type { McpManager } from "./mcp.js";
import type { SkillImprover } from "./improve.js";
import type { LearnStore } from "./learn.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderManager } from "./providers.js";
import { context, ProcessOwner, type MemoryStore } from "./luna.js";
import type { CronStore, Scheduler } from "./scheduler.js";
import { linkedFiles, scanSkills } from "./skills.js";
import { TodoDoc } from "./todo.js";
import { createAnalyticsCache, readAnalytics } from "./analytics.js";
import type { SessionTitler } from "./titles.js";
import { readLimitWait, type LimitContinuer } from "./limit-continue.js";
import { SideCommands, type SideInput, type SideJob } from "./side-commands.js";
import { sideMedia, resolveMedia, mediaResponse } from "./side-media.js";
import { entryMedia } from "./media-directives.js";
import { activeContextTokens } from "./context-usage.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export interface ServerOptions {
  harness: Harness;
  sideCommands?: SideCommands;
  /** Automatic and on-demand session titles. Absent: no title generation. */
  titler?: SessionTitler;
  /** Automatic continuation after usage limits. Absent: no waits are reported or cancelled. */
  limitContinuer?: LimitContinuer;
  settings?: SettingsStore;
  /** Policy for a runtime without a file-backed settings store. */
  compaction?: () => { enabled: boolean; triggerPercent: number };
  busyInput?: () => BusyPolicy;
  conversations?: ConversationStore;
  /** Extensions added to sessions created in a project (the board). */
  projectExtensions?: Extension[];
  /** Bearer token for /v1/*. When unset, auth is off (daemon then binds loopback only). */
  token?: string;
  /** Default agent choices for new sessions (model etc). */
  agent?: Parameters<Harness["createConversation"]>[0]["agent"];
  /** Optional subsystems; their endpoints answer 404 "disabled" when absent. */
  models?: Models;
  /** Provider connections (API keys, subscription logins, custom endpoints) and the default model. */
  providers?: ProviderManager;
  store?: CronStore;
  scheduler?: Scheduler;
  memory?: MemoryStore;
  skillDirs?: string[];
  /** MCP servers: list, add, enable, remove at runtime. */
  mcp?: McpManager;
  /** Session learning ledger and the improver that applies approved proposals. */
  learn?: { store: LearnStore; improver: SkillImprover; scan?: () => Promise<unknown> | undefined };
}

type Input = SideInput;
const AUDIO_MIME = /^audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|flac)$/;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
/** Validate text, image, and file-backed audio input (max 8 images, base64 data). */
function parseInput(v: unknown): Input | string {
  if (typeof v === "string") return v.trim() ? v : "content is empty";
  if (!Array.isArray(v) || !v.length) return "content (string or block array) required";
  let images = 0;
  for (const b of v) {
    if (b?.type === "text" && typeof b.text === "string") continue;
    if (b?.type === "image" && typeof b.data === "string" && IMAGE_MIME.test(b.mimeType) && /^[A-Za-z0-9+/=]+$/.test(b.data)) { images++; continue; }
    if (b?.type === "audio" && typeof b.data === "string" && AUDIO_MIME.test(b.mimeType) && /^[A-Za-z0-9+/=]+$/.test(b.data)) continue;
    return "invalid content block (text, image, or audio with base64 data)";
  }
  if (!images && !v.some(b => b.type === "text" && b.text.trim())) return "content is empty";
  if (images > 8) return "at most 8 images per message";
  return v as Input;
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function isRunning(tx: Tx, id: ConversationId) {
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    if ((await tx.scanTasks({ conversationId: id, status, background: false }, 1)).items.length) return true;
  }
  return false;
}

export function createApp(opts: ServerOptions) {
  const { harness } = opts;
  const sideCommands = opts.sideCommands ?? new SideCommands({ harness, models: opts.models });
  /** Epoch ms of the scheduled continuation, only while the setting is on and nothing runs. */
  const resumeAt = async (tx: Tx, id: ConversationId, running: boolean) =>
    !running && opts.limitContinuer?.enabled() ? (await readLimitWait(tx, id))?.resumeAt ?? null : null;
  const app = new Hono();
  const started = Date.now();
  const jobView = (job: SideJob) => ({ ...job, media: (job.kind === "bg" && job.status === "complete" ? sideMedia(job.text) : []).map(({ name, mimeType, type, directive }, index) => ({
    name, mimeType, type, directive, url: `/v1/sessions/${encodeURIComponent(job.sessionId)}/side-jobs/${encodeURIComponent(job.id)}/media/${index}`,
  })) });
  const draining = new Set<string>();
  const stops = new Map<string, Promise<void>>();
  const admissions = new Map<string, Promise<unknown>>();
  const serial = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const previous = admissions.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    admissions.set(id, next);
    try { return await next; } finally { if (admissions.get(id) === next) admissions.delete(id); }
  };
  const stop = async (conv: NonNullable<Awaited<ReturnType<Harness["conversation"]>>>) => {
    const id = String(conv.id);
    const pending = stops.get(id);
    if (pending) return pending;
    draining.add(id);
    const work = serial(id, () => conv.abort(context));
    stops.set(id, work);
    try { await work; }
    finally { draining.delete(id); stops.delete(id); }
  };
  const err = (c: HonoContext, status: 400 | 401 | 404 | 409 | 500, message: string) => c.json({ error: message }, status);

  app.onError((e, c) => {
    if (e instanceof BusyCommandError) return err(c, e.status, e.message);
    if (e instanceof ConversationError || e instanceof ProjectError || e instanceof BoardError) return err(c, e.status, e.message);
    const name = (e as Error).name;
    if (name === "ConversationBusy") return err(c, 409, "conversation busy");
    return err(c, 500, (e as Error).message ?? String(e));
  });

  // Session pages and catalogs are 100-400 KB of JSON; gzip cuts them ~5x on Wi-Fi and phones. SSE is never compressed.
  app.use("*", compress({ contentTypeFilter: /^(?:application\/json|text\/javascript|text\/css)/ }));

  // ---- web UI + health (unauthenticated; the page holds no data, every /v1 call needs the token) ----
  const webApp = createWebApp(new URL("../dist/web/", import.meta.url));
  app.route("/", webApp);
  app.get("/health", async c => {
    if (opts.token) return c.json({ ok: true, auth: true });
    const inspection = await harness.inspect(context);
    return c.json({ ok: true, auth: false, uptimeMs: Date.now() - started, live: inspection as unknown });
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
  /** Agent choices for a new conversation; the default model comes from the provider manager when present. */
  const baseAgent = () => {
    const c = opts.settings?.resolved();
    return { ...(opts.agent ?? {}), ...(opts.providers && { model: opts.providers.defaultModel() }),
      ...(c?.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}),
      ...(c?.instructions ? { instructions: c.instructions } : {}) };
  };

  app.get("/v1/settings", c => opts.settings ? c.json(opts.settings.view()) : err(c, 404, "settings disabled"));
  const analyticsCache = createAnalyticsCache(harness);
  app.get("/v1/analytics", async c => c.json(await readAnalytics(harness, opts.models, analyticsCache)));
  app.put("/v1/settings", async c => {
    if (!opts.settings) return err(c, 404, "settings disabled");
    try {
      const b = await c.req.json();
      if (!b || typeof b !== "object" || !b.config || typeof b.revision !== "string") return err(c, 400, "config and revision required");
      // Main and child defaults must name an available model when changed.
      const old = opts.settings.read();
      for (const [next, prev] of [[b.config, old], [b.config.subagents ?? {}, old.subagents]]) {
        if (old.providers.some(p => p.id === next.provider) && !b.config.providers?.some((p: { id: string }) => p.id === next.provider)) return err(c, 400, "Select another default before removing its provider");
        if (next.provider && next.model && (next.provider !== prev.provider || next.model !== prev.model) && !opts.models?.getModel(next.provider, next.model)) {
          const custom = b.config.providers?.find((p: {id: string}) => p.id === next.provider);
          if (!custom?.models?.some((m: {id: string}) => m.id === next.model)) return err(c, 400, "unknown default model");
        }
      }
      opts.settings.replace(b.config, b.revision);
      return c.json(opts.settings.view());
    } catch (e) { return err(c, (e as Error).message.includes("Reload before") ? 409 : 400, (e as Error).message); }
  });

  // ---- sessions ----
  // The list is refetched on every sessions_changed event, which fires on each committed entry while any session
  // runs. Rebuilding every row costs ~10 synchronous SQLite reads per conversation and blocked the event loop for
  // seconds. Cache the storage-derived part of each row and rebuild only conversations that a commit touched.
  // Metadata, project links and the limit-continue setting stay live: they are cheap and change outside commits.
  type SessionRow = SessionState & { hidden: boolean; parent: unknown; firstUser: string; running: boolean; wait: number | null; lastActivity: number | null; createdAt: number | null };
  const rows = new Map<string, SessionRow>();
  const generations = new Map<string, number>();
  let epoch = 0, caching = true;
  try { harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      const id = change.type === "conversation" ? change.value.id
        : change.type === "entry" || change.type === "task" || change.type === "submission" ? change.value.conversationId
        : change.conversationId;
      if (id === undefined) { rows.clear(); epoch++; continue; }
      const k = String(id); rows.delete(k); generations.set(k, (generations.get(k) ?? 0) + 1);
    }
  }); } catch { caching = false; } // No commit feed means no invalidation: rebuild every row instead.
  const buildRow = async (tx: Tx, r: { id: ConversationId; parent?: unknown }): Promise<SessionRow> => {
    const head = (await tx.scanEntries({ conversationId: r.id, order: "ascending" }, 30)).items;
    const firstUser = textOf(head.find((e) => e.kind === "pi.user")).replace(/\s+/g, " ").slice(0, 60);
    if (head.some((e) => e.kind === "delegate.child")) return { hidden: true, parent: null, firstUser, running: false, status: "ready", statusReason: null, wait: null, lastActivity: null, createdAt: null };
    const running = await isRunning(tx, r.id);
    return {
      hidden: false, parent: r.parent ?? null, firstUser, running, ...await readSessionStatus(tx, r.id, running),
      wait: running ? null : (await readLimitWait(tx, r.id))?.resumeAt ?? null,
      lastActivity: await newestMessageTime(tx, r.id),
      createdAt: (await tx.doc(SessionCreated, r.id)).at ?? null,
    };
  };
  // Concurrent requests (several tabs reacting to one event) share one storage pass.
  let listing: Promise<[ConversationId, SessionRow][]> | undefined;
  const listRows = () => listing ??= harness.commit(async (tx) => {
    const seen = new Set<string>(), out: [ConversationId, SessionRow][] = [];
    let cursor;
    do {
      const page = await tx.scanConversations({ order: "descending" }, 100, cursor);
      for (const r of page.items) {
        const k = String(r.id); seen.add(k);
        let row = rows.get(k);
        if (!row) {
          const gen = generations.get(k) ?? 0, at = epoch;
          row = await buildRow(tx, r);
          // A commit for this conversation during the read leaves the row uncached; the next request rereads it.
          if (caching && (generations.get(k) ?? 0) === gen && epoch === at) rows.set(k, row);
        }
        out.push([r.id, row]);
      }
      cursor = page.next;
    } while (cursor);
    for (const k of rows.keys()) if (!seen.has(k)) rows.delete(k);
    return out;
  }, context).finally(() => { listing = undefined; });
  app.get("/v1/sessions", async (c) => {
    // Title = first user message. Subagent children (delegate.child marker) are hidden from the list.
    const built = await listRows();
    const links = opts.conversations?.projects.links();
    const continuing = !!opts.limitContinuer?.enabled();
    const sessions: (SessionState & { id: unknown; parent: unknown; project: number | null; title: string; archived: boolean; pinned: boolean; running: boolean; resumeAt: number | null; lastActivity: number | null; createdAt: number | null })[] = [];
    for (const [id, row] of built) {
      if (row.hidden) continue;
      const { hidden: _hidden, firstUser, wait, ...rest } = row;
      const meta = opts.conversations?.get(id) ?? { title: null, archived: false, pinned: false };
      sessions.push({ ...rest, id, project: links?.get(id) ?? null, ...meta, title: meta.title ?? firstUser, resumeAt: continuing && !row.running ? wait : null });
    }
    sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) || Number(b.id) - Number(a.id));
    return c.json({ sessions });
  });

  app.patch("/v1/sessions/:id/metadata", async c => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b) || !Object.keys(b).length || Object.keys(b).some(k => !["title", "archived", "pinned"].includes(k))) return err(c, 400, "title, archived or pinned required");
    if ("title" in b && (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > 200)) return err(c, 400, "title must contain 1 to 200 characters");
    for (const k of ["archived", "pinned"]) if (k in b && typeof b[k] !== "boolean") return err(c, 400, k + " must be a boolean");
    const id = Number(c.req.param("id")); if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    const changes = { ...b, ...("title" in b ? { title: b.title.trim() } : {}) } as Partial<ConversationMeta>;
    return c.json(await opts.conversations.update(id, changes));
  });
  app.get("/v1/session-titles", c => c.json({ available: !!opts.titler?.available() }));
  app.post("/v1/sessions/:id/title", async c => {
    if (!opts.conversations || !opts.titler) return err(c, 404, "session titles disabled");
    const id = Number(c.req.param("id")); if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    try { return c.json({ title: await opts.titler.generate(id, true) }); }
    catch (e) { const m = (e as Error).message; return err(c, m === "no such session" ? 404 : m.startsWith("No session-title") || m.startsWith("The session needs") ? 409 : 500, m); }
  });
  app.delete("/v1/sessions/:id", async c => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const id = Number(c.req.param("id")); if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    return c.json({ deleted: await opts.conversations.delete(id) });
  });

  // ---- projects: a named working directory that new sessions inherit ----
  const projectId = (c: HonoContext) => { const n = Number(c.req.param("id")); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
  app.get("/v1/projects", (c) => opts.conversations ? c.json({ projects: opts.conversations.projects.list() }) : err(c, 404, "projects disabled"));
  app.post("/v1/projects", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const b = await c.req.json().catch(() => ({})) as { name?: unknown; cwd?: unknown };
    return c.json(opts.conversations.projects.create(b.name, b.cwd), 201);
  });
  app.patch("/v1/projects/:id", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const b = await c.req.json().catch(() => ({})) as { name?: unknown; cwd?: unknown };
    return c.json(opts.conversations.projects.update(projectId(c), b));
  });
  app.delete("/v1/projects/:id", (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    opts.conversations.projects.delete(projectId(c));
    opts.conversations.touch();
    return c.json({ ok: true });
  });

  // ---- project board: cards shared by the user and the project's sessions ----
  const boardOf = (c: HonoContext) => {
    const conv = opts.conversations; if (!conv) throw new ProjectError(404, "projects disabled");
    const id = projectId(c); if (!conv.projects.get(id)) throw new ProjectError(404, "no such project");
    return { conv, id };
  };
  const cardId = (c: HonoContext) => { const n = Number(c.req.param("cardId")); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
  // Writes go through a harness commit, like other stored metadata, so they never interleave with another transaction.
  const write = async <T,>(conv: NonNullable<typeof opts.conversations>, fn: () => T): Promise<T> => { const r = await harness.commit(async () => fn(), context); conv.touch(); return r; };
  app.get("/v1/projects/:id/board", (c) => {
    const { conv, id } = boardOf(c);
    return c.json({ cards: conv.board.list(id, { archived: c.req.query("archived") === "1" }) });
  });
  app.post("/v1/projects/:id/cards", async (c) => {
    const { conv, id } = boardOf(c);
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    return c.json(await write(conv, () => conv.board.create(id, b)), 201);
  });
  app.patch("/v1/projects/:id/cards/:cardId", async (c) => {
    const { conv, id } = boardOf(c);
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    return c.json(await write(conv, () => conv.board.update(id, cardId(c), b)));
  });
  app.delete("/v1/projects/:id/cards/:cardId", async (c) => {
    const { conv, id } = boardOf(c);
    await write(conv, () => conv.board.delete(id, cardId(c)));
    return c.json({ ok: true });
  });

  app.post("/v1/sessions", async (c) => {
    const b = await c.req.json().catch(() => ({})) as { model?: { provider: string; modelId: string }; instructions?: string; cwd?: string; project?: number };
    if (b.model && opts.models && !opts.models.getModel(b.model.provider, b.model.modelId)) return err(c, 400, "unknown model");
    // A project supplies the default cwd. An explicit cwd still wins. No project: nothing changes.
    let project;
    if (b.project !== undefined && b.project !== null) {
      project = opts.conversations?.projects.get(b.project);
      if (!project) return err(c, 400, "unknown project");
    }
    const cwd = b.cwd || project?.cwd;
    // Project sessions also get the board tool and prompt section; other sessions never do.
    const agent = { ...baseAgent(), ...(b.model && { model: b.model }), ...(b.instructions && { instructions: b.instructions }), ...(cwd && { cwd }), ...(project && opts.projectExtensions?.length && { extensions: { add: opts.projectExtensions } }) };
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    if (project) opts.conversations!.projects.link(Number(conv.id), project.id);
    return c.json({ id: conv.id }, 201);
  });

  const contextUsage = async (conv: NonNullable<Awaited<ReturnType<typeof getConv>>>) => {
    const agent = await conv.agent(context);
    const model = agent.model && opts.models?.getModel(agent.model.provider, agent.model.modelId);
    const capacity = model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
    const view = await conv.context(context);
    const usedTokens = activeContextTokens(view);
    const live = await harness.snapshot(LiveDoc, conv.id, context);
    const policy = opts.settings?.read().compaction ?? opts.compaction?.() ?? { enabled: true, triggerPercent: 75 };
    return {
      usedTokens, contextWindow: capacity, percent: capacity === null ? null : usedTokens / capacity * 100,
      estimated: true as const, triggerPercent: policy.triggerPercent, autoCompactionEnabled: policy.enabled,
      compacting: (live?.compactions?.length ?? 0) > 0,
    };
  };
  app.get("/v1/sessions/:id/context", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json(await contextUsage(conv));
  });

  // ---- session activity: background processes and subagents owned by one conversation ----
  const processOwner = async (id: ConversationId) => (await harness.snapshot(ProcessOwner, id, context).catch(() => undefined))?.token ?? "legacy";
  const processesOf = async (id: ConversationId) => harness.busyTools ? harness.busyTools.sessionProcesses(id, await processOwner(id)) : [];
  const childViews = (rows: { id: number; task: string }[]) => Promise.all(rows.map(async row => {
    const child = await harness.conversation(row.id as never, context).catch(() => undefined);
    if (!child) return { id: row.id, task: row.task, status: "deleted" as const, statusReason: null };
    const { status, statusReason } = await harness.commit(async tx => {
      const running = await isRunning(tx, child.id);
      return readSessionStatus(tx, child.id, running);
    }, context);
    return { id: row.id, task: row.task, status, statusReason };
  }));
  app.get("/v1/sessions/:id/processes/:pid", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const view = harness.busyTools?.sessionProcess(conv.id, await processOwner(conv.id), c.req.param("pid"));
    return view ? c.json(view) : err(c, 404, "no such background process in this session");
  });
  app.post("/v1/sessions/:id/processes/:pid/stop", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const view = harness.busyTools?.stopSessionProcess(conv.id, await processOwner(conv.id), c.req.param("pid"));
    return view ? c.json(view) : err(c, 404, "no such background process in this session");
  });

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
    const { running, ...sessionStatus } = await harness.commit(async tx => {
      const running = await isRunning(tx, conv.id);
      const status = await readSessionStatus(tx, conv.id, running);
      // Mark read in the same commit. readSessionStatus reads the doc before the mark,
      // so this GET returns "finished"; subsequent reads see "ready".
      if (!running && status.status === "finished") await markSessionRead(tx, conv.id);
      return { running, ...status, resumeAt: await resumeAt(tx, conv.id, running) };
    }, context);
    return c.json({
      id: conv.id,
      running,
      status: sessionStatus.status,
      statusReason: sessionStatus.statusReason,
      resumeAt: sessionStatus.resumeAt,
      agent: { model: a.model ?? null, thinkingLevel: a.thinkingLevel, cwd: a.cwd ?? null, instructions: a.instructions ?? null, tools: a.tools.map((t) => t.name) },
      usage: usage ?? null,
      contextUsage: await contextUsage(conv),
      children: await childViews(kids?.children ?? []),
      processes: await processesOf(conv.id),
      todos: (todo?.tasks ?? []).filter((t) => t.status !== "deleted"),
      questions: ask?.pending ?? [],
      goal: goal?.goal ?? null,
      entries: page.items,
    });
  });

  // Change a session's model, thinking level or instructions. null resets a field to the default.
  app.patch("/v1/sessions/:id", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = await c.req.json().catch(() => ({})) as { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null; instructions?: string | null };
    if (await harness.commit(tx => isRunning(tx, conv.id), context)) return err(c, 409, "Cannot change the model or agent settings while busy.");
    if (b.model && opts.models && !opts.models.getModel(b.model.provider, b.model.modelId)) return err(c, 400, "unknown model");
    if (b.thinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(b.thinkingLevel)) return err(c, 400, "invalid thinkingLevel");
    await conv.configure({
      ...(b.model !== undefined && { model: b.model }),
      ...(b.thinkingLevel !== undefined && { thinkingLevel: b.thinkingLevel as never }),
      ...(b.instructions !== undefined && { instructions: b.instructions || null }),
    }, context);
    return c.json({ ok: true });
  });

  app.delete("/v1/sessions/:id/limit-wait", async (c) => {
    if (!opts.limitContinuer) return err(c, 404, "auto-continue disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json({ cancelled: await opts.limitContinuer.cancel(Number(conv.id)) });
  });

  app.post("/v1/sessions/:id/reset", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    await conv.reset(undefined, context);
    return c.json({ ok: true });
  });

  app.post("/v1/sessions/:id/compact", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    if (await harness.commit(tx => isRunning(tx, conv.id), context)) return err(c, 409, "Cannot compress context while busy.");
    const task = await conv.compact(undefined, context);
    return c.json({ ok: true, taskId: task }, 202);
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
    const b = await c.req.json().catch(() => ({})) as { action?: string };
    if (!["pause", "resume", "clear"].includes(b.action ?? "")) return err(c, 400, "action must be pause, resume or clear");
    const r = await harness.commit(async (tx) => {
      const d = await tx.doc(GoalDoc, conv.id);
      if (!d.goal) return "no goal";
      if (b.action === "clear") { d.goal = null; return "ok"; }
      if (d.goal.status === "complete") return "goal is complete";
      if (b.action === "pause") { d.goal.status = "paused"; d.goal.statusReason = "paused by the user"; }
      else { d.goal.status = "active"; delete d.goal.statusReason; d.goal.runs = 0; }
      return "ok";
    }, context);
    if (r !== "ok") return err(c, 409, r);
    // Resuming an idle conversation needs a turn to start the work again.
    if (b.action === "resume") await conv.submit({ type: "input", content: "Resume the active goal.", whenBusy: "followUp" }, context);
    return c.json({ ok: true });
  });

  // Out-of-band job results: never model-visible entries or submissions in this chat.
  app.get("/v1/sessions/:id/side-jobs", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json({ jobs: sideCommands.list(String(conv.id)).map(jobView) });
  });
  app.get("/v1/sessions/:id/side-jobs/:jobId/media/:index", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const job = sideCommands.list(String(conv.id)).find(j => j.id === c.req.param("jobId"));
    const index = Number(c.req.param("index"));
    if (!job || job.kind !== "bg" || job.status !== "complete" || !Number.isSafeInteger(index) || index < 0) return err(c, 404, "no such media");
    const child = job.conversationId && await harness.conversation(job.conversationId as never, context);
    const cwd = child ? (await child.agent(context)).cwd : undefined;
    return mediaResponse(c, sideMedia(job.text, cwd)[index]);
  });
  // Files named by MEDIA: directives in an assistant message of this conversation. The index counts
  // directives across the entry's assistant text blocks (see entryMedia); nothing else is served.
  app.get("/v1/sessions/:id/entries/:entryId/media/:index", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const entryId = Number(c.req.param("entryId")), index = Number(c.req.param("index"));
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(index) || index < 0) return err(c, 404, "no such media");
    const entry = await harness.commit(tx => tx.entry(entryId as never), context).catch(() => undefined);
    if (!entry || String(entry.conversationId) !== String(conv.id)) return err(c, 404, "no such media");
    const directive = entryMedia(entry.model)[index];
    return mediaResponse(c, directive && resolveMedia(directive, (await conv.agent(context)).cwd));
  });

  // ---- messages ----
  // Non-streaming (default): waits for the answer and returns it.
  // Streaming (?stream=1 or Accept: text/event-stream): SSE of agent events until the submission settles.
  const send = async (c: HonoContext, sessionId: string, body: { content?: unknown; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" | "redirect" }, asyncMode = false) => {
    const conv = await getConv(sessionId);
    if (!conv) return err(c, 404, "no such session");
    const content = parseInput(body.content);
    if (typeof content === "string" && typeof body.content !== "string") return err(c, 400, content);
    if (typeof body.content === "string" && !body.content.trim()) return err(c, 400, "content (string) required");

    if (body.requestId !== undefined && (typeof body.requestId !== "string" || !body.requestId.trim())) return err(c, 400, "requestId must be a nonempty string");
    if (body.whenBusy !== undefined && !["steer", "followUp", "reject", "redirect"].includes(body.whenBusy)) return err(c, 400, "invalid whenBusy");
    const commandText = typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.type === "text" ? b.text : "").join("\n");
    const side = /^\/(btw|bg)(?:\s+([\s\S]*))?$/.exec(commandText.trim());
    if (side) {
      const kind = side[1] as "btw" | "bg", prompt = (side[2] ?? "").trim();
      if (!prompt) return err(c, 400, `Usage: /${kind} <${kind === "btw" ? "question" : "prompt"}>`);
      try {
        const job = await sideCommands.start(conv, kind, prompt, content as Input, body.requestId);
        return c.json({ command: true, job: jobView(job), notice: `/${kind} started: ${prompt.slice(0, 60)} [${job.id}]` }, 202);
      } catch (error) { return err(c, 400, (error as Error).message); }
    }
    if (Array.isArray(content) && content.some(b => b.type === "audio")) return err(c, 400, "Audio attachments require /bg.");
    if (draining.has(String(conv.id))) return c.json({ command: true, notice: "The current turn is stopping. Send the message again after it stops." }, 409);
    const plain = typeof content === "string" ? content : content.every(block => block.type === "text") ? content.map(block => block.type === "text" ? block.text : "").join("\n") : undefined;
    const slash = plain === undefined ? null : /^\/(queue|steer|redirect|stop|model|compress|compact|retry)(?:\s+([\s\S]*))?$/.exec(plain.trim());
    let input = content as Input;
    let override: BusyMode | undefined;
    if (slash) {
      const command = slash[1]!, args = (slash[2] ?? "").trim();
      if (command === "stop") {
        await stop(conv);
        return c.json({ command: true, notice: "Stopped." });
      }
      if (["model", "compress", "compact", "retry"].includes(command)) {
        const busy = await harness.commit(tx => isRunning(tx, conv.id), context);
        return err(c, busy ? 409 : 400, busy ? `/${command} is not available while busy.` : `Use the session controls for /${command}.`);
      }
      if (command === "queue") {
        const mutation = parseQueueCommand(args || "list");
        if (mutation) return c.json(await serial(String(conv.id), () => harness.commit(tx => queueCommand(tx, conv.id, mutation, body.requestId), context)));
        if (/^(?:edit|remove|move)\s+\d+(?:\s|$)/.test(args)) return err(c, 400, "Use /queue list, edit N text, remove N, move A B, or clear.");
      }
      if (!args) return err(c, 400, `/${command} needs a message.`);
      input = args;
      override = command === "redirect" ? "interrupt" : command as "queue" | "steer";
    }
    const submit = () => serial(String(conv.id), async () => {
      if (draining.has(String(conv.id))) throw new BusyCommandError("The current turn is stopping. Send the message again after it stops.", 409);
      const policy = opts.settings?.read().busyInput ?? opts.busyInput?.() ?? DEFAULT_BUSY_INPUT;
      let mode = override ?? (body.whenBusy === "steer" ? "steer" : body.whenBusy === "followUp" ? "queue" : body.whenBusy === "redirect" ? "interrupt" : policy.mode);
      if (mode === "interrupt" && await harness.commit(tx => interruptBlocked(tx, conv.id), context)) mode = "queue";
      const textOnly = typeof input === "string" || input.every(block => block.type === "text");
      const whenBusy = body.whenBusy === "reject" && !override ? "reject" : !textOnly || mode === "queue" ? "followUp" : mode === "steer" ? "steer" : "redirect";
      const sub = await conv.submit({ type: "input", content: input as UserInput, requestId: body.requestId, whenBusy }, context);
      if (sub.action === "steered" && mode === "interrupt") harness.busyTools.yield(conv.id);
      const action = sub.action ?? ((await sub.status(context)).status === "queued" ? "queued" : "started");
      const notices = await harness.commit(tx => feedback(tx, conv.id, policy, action), context);
      return { sub, action, ...notices };
    });
    if (asyncMode) {
      const { sub, ...receipt } = await submit();
      return c.json({ submissionId: sub.id, ...receipt }, 202);
    }

    const wantsStream = c.req.query("stream") === "1" || (c.req.header("accept") ?? "").includes("text/event-stream");
    const settle = async (sub: Awaited<ReturnType<typeof conv.submit>>) => {
      const s = await sub.wait(context);
      if (s.status !== "done") return { submissionId: sub.id, status: s.status, reason: (s as { reason?: string }).reason ?? null, detail: (s as { detail?: unknown }).detail ?? null };
      const ent = await conv.entries({}, 1, undefined, context); // newest first
      const answer = ent.items.find((e) => e.id === s.answer) ?? (await harness.commit((tx) => tx.entry(s.answer as never), context).catch(() => undefined));
      return { submissionId: sub.id, status: "done", answer: textOf(answer) };
    };

    if (!wantsStream) {
      const { sub, ...receipt } = await submit();
      return c.json({ ...await settle(sub), ...receipt });
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
        const { sub, ...receipt } = await submit();
        await stream.writeSSE({ event: "submitted", data: JSON.stringify({ submissionId: sub.id, ...receipt }) });
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

  app.post("/v1/sessions/:id/messages", bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => err(c, 400, "message too large (32 MB max)") }), async (c) => {
    const asyncParam = c.req.query("async") === "1";
    return send(c, c.req.param("id"), await c.req.json().catch(() => ({})), asyncParam);
  });

  // Convenience: create-or-reuse session in one call. {message, sessionId?}
  app.post("/v1/chat", async (c) => {
    const b = await c.req.json().catch(() => ({})) as { message?: string; sessionId?: string; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" | "redirect" };
    let id = b.sessionId;
    if (!id) id = (await harness.createConversation({ ownership: { kind: "ownerless" }, agent: baseAgent() }, context)).id as unknown as string;
    return send(c, id, { content: b.message, requestId: b.requestId, whenBusy: b.whenBusy });
  });

  // Live viewers never own the run. Closing this connection only releases their observation.
  app.get("/v1/sessions/:id/events", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return streamSSE(c, async stream => {
      const ev = await watchEvents(harness, conv.id, context);
      let finish!: () => void;
      const done = new Promise<void>(r => finish = r);
      stream.onAbort(finish);
      const stopSide = sideCommands.subscribe(String(conv.id), job => {
        void stream.writeSSE({ event: "side_job", data: JSON.stringify(jobView(job)) }).catch(finish);
      });
      const ping = setInterval(() => { void stream.writeSSE({ event: "ping", data: "{}" }).catch(finish); }, 15000);
      try {
        await stream.writeSSE({ event: "side_jobs", data: JSON.stringify({ jobs: sideCommands.list(String(conv.id)).map(jobView) }) });
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(ev.snapshot) });
        ev.start(async events => {
          try { for (const event of events) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }); }
          catch { finish(); }
        });
        await Promise.race([done, ev.closed, harness.closed]);
      } finally { stopSide(); clearInterval(ping); await ev.stop(); }
    });
  });

  // Cross-device list invalidations; payloads contain no transcript and writes are serialized/coalesced.
  app.get("/v1/events", c => streamSSE(c, async stream => {
    let finish!: () => void, timer: ReturnType<typeof setTimeout> | undefined, dirty = false, boardDirty = false, writing = false, closed = false;
    const done = new Promise<void>(r => finish = r);
    stream.onAbort(finish);
    const flush = async () => {
      timer = undefined;
      if (closed || writing || (!dirty && !boardDirty)) return;
      const sessions = dirty, board = boardDirty; dirty = boardDirty = false; writing = true;
      try {
        if (sessions) await stream.writeSSE({ event: "sessions_changed", data: "{}" });
        if (board) await stream.writeSSE({ event: "board_changed", data: "{}" });
      }
      catch { finish(); }
      finally { writing = false; if ((dirty || boardDirty) && !closed) timer = setTimeout(flush, 100); }
    };
    const arm = () => { if (!timer && !writing && !closed) timer = setTimeout(flush, 100); };
    const changed = () => { dirty = true; arm(); };
    const boardChanged = () => { boardDirty = true; arm(); };
    // Register BEFORE the initial event, so creation during attachment cannot be missed.
    const unsubscribe = harness.subscribeCommits(publication => {
      if (publication.changes.some(change => change.type === "conversation" || change.type === "entry" || change.type === "task" || change.type === "submission" || change.type === "document" && ["luna.ask", "luna.goal", "luna.session-handoff", "luna.session-read", "luna.limit-waits"].includes(change.record.kind))) changed();
    });
    const unsubscribeMeta = opts.conversations?.subscribeChanges(changed);
    const unsubscribeBoard = opts.conversations?.subscribeBoard(boardChanged);
    const ping = setInterval(() => { if (!writing) void stream.writeSSE({ event: "ping", data: "{}" }).catch(finish); }, 15000);
    try { dirty = true; await flush(); await Promise.race([done, harness.closed]); }
    finally { closed = true; clearInterval(ping); clearTimeout(timer); unsubscribe(); unsubscribeMeta?.(); unsubscribeBoard?.(); }
  }));

  // ---- tools ----
  app.get("/v1/tools", async (c) => {
    const root = await harness.root(context);
    const a = await root.agent(context);
    const shape = (t: { name: string; description?: string; parameters?: unknown }) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? null });
    return c.json({ tools: a.tools.map(shape), deferred: a.deferred.map(shape) });
  });

  // ---- models ----
  // Models of connected providers only (plus the default, so a session never shows an unknown value).
  app.get("/v1/models", async (c) => {
    if (!opts.models) return err(c, 404, "disabled");
    const cur = (opts.providers?.defaultModel() ?? opts.agent?.model) ?? null;
    const avail = opts.providers ? [...await opts.models.getAvailable()] : [...opts.models.getModels(cur?.provider)];
    if (cur && !avail.some((m) => m.provider === cur.provider && m.id === cur.modelId)) {
      const m = opts.models.getModel(cur.provider, cur.modelId); if (m) avail.unshift(m);
    }
    const list = avail.map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, input: m.input, contextWindow: m.contextWindow }));
    return c.json({ default: cur, models: list, refresh: opts.providers?.catalogStatus() ?? null });
  });
  app.post("/v1/models/refresh", async (c) => {
    if (!opts.providers) return err(c, 404, "providers disabled");
    return c.json({ refresh: await opts.providers.refreshCatalog() });
  });
  app.put("/v1/models/default", async (c) => {
    if (!opts.providers) return err(c, 404, "disabled");
    const b = await c.req.json().catch(() => ({})) as { provider?: string; modelId?: string };
    try { opts.providers.setDefaultModel({ provider: String(b.provider ?? ""), modelId: String(b.modelId ?? "") }); return c.json({ ok: true, default: opts.providers.defaultModel() }); }
    catch (e) { return err(c, 400, (e as Error).message); }
  });

  // ---- providers: API keys, subscription (OAuth) logins, custom OpenAI/Anthropic-compatible endpoints ----
  const prov = (c: HonoContext) => (opts.providers ? undefined : err(c, 404, "providers disabled"));
  const attempt = async (c: HonoContext, fn: () => Promise<unknown>, status: 200 | 201 = 200) => {
    try { return c.json((await fn()) ?? { ok: true }, status); } catch (e) { return err(c, 400, (e as Error).message); }
  };
  app.get("/v1/providers", async (c) => prov(c) ?? c.json({ providers: await opts.providers!.list(), default: opts.providers!.defaultModel() }));
  app.put("/v1/providers/:id/key", async (c) => {
    const no = prov(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as { key?: string };
    return attempt(c, () => opts.providers!.setApiKey(c.req.param("id"), String(b.key ?? "")));
  });
  app.delete("/v1/providers/:id/credential", async (c) => prov(c) ?? attempt(c, () => opts.providers!.logout(c.req.param("id"))));
  app.post("/v1/providers/custom", async (c) => {
    const no = prov(c); if (no) return no;
    const b = await c.req.json().catch(() => ({}));
    return attempt(c, () => opts.providers!.addCustom(b as never), 201);
  });
  app.delete("/v1/providers/custom/:id", async (c) => prov(c) ?? attempt(c, () => opts.providers!.removeCustom(c.req.param("id"))));
  app.post("/v1/providers/:id/login", async (c) => {
    const no = prov(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as { type?: string };
    const type = b.type === "api_key" ? "api_key" : "oauth";
    try { return c.json(opts.providers!.startLogin(c.req.param("id"), type), 201); } catch (e) { return err(c, 400, (e as Error).message); }
  });
  app.get("/v1/logins/:id", (c) => {
    const no = prov(c); if (no) return no;
    const l = opts.providers!.getLogin(c.req.param("id"));
    return l ? c.json(l) : err(c, 404, "no such login");
  });
  app.post("/v1/logins/:id/answer", async (c) => {
    const no = prov(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as { seq?: number; value?: string };
    try { opts.providers!.answerLogin(c.req.param("id"), Number(b.seq), String(b.value ?? "")); return c.json({ ok: true }); }
    catch (e) { return err(c, 409, (e as Error).message); }
  });
  // ---- MCP servers: daemon mutations use the shared settings file ----
  const mcpOff = (c: HonoContext) => (opts.mcp ? undefined : err(c, 404, "mcp disabled"));
  app.get("/v1/mcp", (c) => mcpOff(c) ?? c.json({ servers: opts.mcp!.list() }));
  app.post("/v1/mcp", async (c) => mcpOff(c) ?? attempt(c, async () => opts.mcp!.add(await c.req.json().catch(() => ({}))), 201));
  app.patch("/v1/mcp/:name", async (c) => {
    const no = mcpOff(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as { enabled?: unknown };
    if (typeof b.enabled !== "boolean") return err(c, 400, "enabled (boolean) required");
    return attempt(c, () => opts.mcp!.setEnabled(c.req.param("name"), b.enabled as boolean));
  });
  app.delete("/v1/mcp/:name", async (c) => mcpOff(c) ?? attempt(c, () => opts.mcp!.remove(c.req.param("name"))));

  app.delete("/v1/logins/:id", (c) => { const no = prov(c); if (no) return no; opts.providers!.cancelLogin(c.req.param("id")); return c.json({ ok: true }); });

  // ---- cron ----
  const cron = (c: HonoContext) => (opts.store ? undefined : err(c, 404, "cron disabled"));
  app.get("/v1/cron", (c) => {
    if (!opts.store) return err(c, 404, "cron disabled");
    const jobs = opts.store.listJobs().map(j => ({
      ...j,
      lastRun: opts.store!.lastRun(j.id) ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }));
    return c.json({ jobs, runs: c.req.query("summary") === "1" ? [] : opts.store.runs(undefined, 50), unreadCount: opts.store.unreadCount(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });
  app.post("/v1/cron", async (c) => {
    const no = cron(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as any;
    if (!b || typeof b !== "object" || Array.isArray(b)) return err(c, 400, "invalid body");
    const allowed = ["name", "expr", "prompt", "reportPolicy"];
    const keys = Object.keys(b);
    if (!keys.length || keys.some(k => !allowed.includes(k))) return err(c, 400, "invalid or unknown fields");
    if (!b.name || typeof b.name !== "string" || !b.name.trim() || !b.expr || typeof b.expr !== "string" || !b.prompt || typeof b.prompt !== "string" || !b.prompt.trim()) return err(c, 400, "name, expr and prompt required");
    if (b.reportPolicy !== undefined && !['always', 'changes', 'failures'].includes(b.reportPolicy)) return err(c, 400, "invalid report policy");
    if (opts.store!.listJobs().some((j) => j.name === b.name)) return err(c, 409, "a job with that name exists");
    try {
      const job = opts.store!.addJob(b.name, b.expr, b.prompt, undefined, Date.now(), b.reportPolicy);
      opts.scheduler?.rearm();
      return c.json(job, 201);
    } catch (e) { return err(c, 400, (e as Error).message); }
  });
  app.patch("/v1/cron/:id", async (c) => {
    const no = cron(c); if (no) return no;
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such job");
    const existing = opts.store!.getJob(id);
    if (!existing) return err(c, 404, "no such job");
    const b = await c.req.json().catch(() => ({})) as any;
    if (!b || typeof b !== "object" || Array.isArray(b)) return err(c, 400, "invalid body");
    const allowed = ["name", "expr", "prompt", "enabled", "reportPolicy"];
    const keys = Object.keys(b);
    if (!keys.length || keys.some(k => !allowed.includes(k))) return err(c, 400, "invalid or unknown fields");
    if ("name" in b && (typeof b.name !== "string" || !b.name.trim())) return err(c, 400, "invalid name");
    if ("expr" in b && (typeof b.expr !== "string" || !b.expr.trim())) return err(c, 400, "invalid expr");
    if ("prompt" in b && b.prompt !== undefined) {
      if (typeof b.prompt !== "string") return err(c, 400, "invalid prompt");
      if (!b.prompt.trim() && !existing.execution) {
        return err(c, 400, "prompt required");
      }
    }
    if ("enabled" in b && typeof b.enabled !== "boolean") return err(c, 400, "enabled must be boolean");
    if ("reportPolicy" in b && !['always', 'changes', 'failures'].includes(b.reportPolicy)) return err(c, 400, "invalid report policy");

    if ("name" in b && b.name !== existing.name) {
      if (opts.store!.listJobs().some(j => j.name === b.name && j.id !== id)) return err(c, 409, "a job with that name exists");
    }

    try {
      const updated = opts.store!.updateJob(id, b);
      opts.scheduler?.rearm();
      return c.json(updated);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("running")) return err(c, 409, msg);
      if (msg.includes("interval")) return err(c, 400, msg);
      return err(c, 400, msg);
    }
  });
  app.post("/v1/cron/:id/run", (c) => {
    const no = cron(c); if (no) return no;
    if (!opts.scheduler) return err(c, 404, "scheduler disabled");
    try {
      return c.json(opts.scheduler.runNow(Number(c.req.param("id"))), 202);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("already running")) return err(c, 409, msg);
      return err(c, 404, msg);
    }
  });
  app.delete("/v1/cron/:id", (c) => {
    const no = cron(c); if (no) return no;
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1 || !opts.store!.getJob(id)) return err(c, 404, "no such job");
    try {
      opts.store!.removeJob(id);
      opts.scheduler?.rearm();
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("running")) return err(c, 409, msg);
      return err(c, 400, msg);
    }
  });
  app.get("/v1/cron/reports", (c) => {
    const no = cron(c); if (no) return no;
    const history = c.req.query("history") === "1" || c.req.query("history") === "true";
    const jobId = c.req.query("jobId") !== undefined ? Number(c.req.query("jobId")) : undefined;
    const before = c.req.query("before") !== undefined ? Number(c.req.query("before")) : undefined;
    const limit = c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : 50;
    if (jobId !== undefined && (!Number.isSafeInteger(jobId) || jobId < 1)) return err(c, 400, "invalid jobId");
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return err(c, 400, "invalid before cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err(c, 400, "invalid limit (1..100)");
    const reports = opts.store!.reports({ history, jobId, before, limit });
    return c.json({ reports, unreadCount: opts.store!.unreadCount() });
  });
  app.get("/v1/cron/runs", (c) => {
    const no = cron(c); if (no) return no;
    const history = c.req.query("history") === "1" || c.req.query("history") === "true";
    const jobId = c.req.query("jobId") !== undefined ? Number(c.req.query("jobId")) : undefined;
    const status = c.req.query("status") as any;
    const before = c.req.query("before") !== undefined ? Number(c.req.query("before")) : undefined;
    const limit = c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : 50;
    if (jobId !== undefined && (!Number.isSafeInteger(jobId) || jobId < 1)) return err(c, 400, "invalid jobId");
    if (status !== undefined && !["running", "ok", "error"].includes(status)) return err(c, 400, "invalid status");
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return err(c, 400, "invalid before cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err(c, 400, "invalid limit (1..100)");
    const runs = opts.store!.queryRuns({ history, jobId, status, before, limit });
    return c.json({ runs });
  });
  app.get("/v1/cron/runs/:runId", (c) => {
    const no = cron(c); if (no) return no;
    const runId = Number(c.req.param("runId"));
    if (!Number.isSafeInteger(runId) || runId < 1) return err(c, 404, "no such run");
    const r = opts.store!.getRun(runId);
    if (!r) return err(c, 404, "no such run");
    return c.json(r);
  });
  app.patch("/v1/cron/reports/:runId", async (c) => {
    const no = cron(c); if (no) return no;
    const runId = Number(c.req.param("runId"));
    if (!Number.isSafeInteger(runId) || runId < 1) return err(c, 404, "no such run");
    const b = await c.req.json().catch(() => ({})) as any;
    if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.read !== "boolean" || Object.keys(b).some(key => key !== "read")) return err(c, 400, "read (boolean) required");
    try {
      const updated = opts.store!.markRead(runId, b.read);
      return c.json(updated);
    } catch (e) {
      return err(c, 404, (e as Error).message);
    }
  });

  // ---- memory ----
  app.get("/v1/memory", (c) => {
    if (!opts.memory) return err(c, 404, "memory disabled");
    return c.json({ items: opts.memory.recall(c.req.query("q") ?? "", { limit: 50, includeArchived: c.req.query("archived") === "1" }) });
  });
  app.post("/v1/memory", async (c) => {
    if (!opts.memory) return err(c, 404, "memory disabled");
    const b = await c.req.json().catch(() => ({})) as { content?: string; key?: string; tags?: string[] };
    try { return c.json(opts.memory.remember({ content: b.content ?? "", key: b.key || undefined, tags: b.tags }), 201); }
    catch (e) { return err(c, 400, (e as Error).message); }
  });
  app.delete("/v1/memory/:id", (c) => {
    if (!opts.memory) return err(c, 404, "memory disabled");
    return opts.memory.forget(Number(c.req.param("id"))) ? c.json({ ok: true }) : err(c, 404, "no such memory");
  });

  // ---- lessons: session learning review queue. Nothing is applied without approve. ----
  const lessonView = (l: ReturnType<LearnStore["lesson"]> & {}) => {
    const L = opts.learn!.store;
    return {
      ...l, needs_guard: !!l.needs_guard, tests: l.tests ? JSON.parse(l.tests) as string[] : [], sessions: L.sessions(l.id),
      current: l.status === "proposed" && l.scope === "skill" && l.skill ? opts.learn!.improver.read(l.skill) ?? null : null,
      evidence: L.evidence(l.id).map((s) => ({ id: s.id, kind: s.kind, session: s.conv, message: s.entry, summary: s.summary, ts: s.ts })),
    };
  };
  const learnOff = (c: HonoContext) => opts.learn ? undefined : err(c, 404, "learning disabled");
  app.get("/v1/lessons", (c) => learnOff(c) ?? c.json({
    lessons: opts.learn!.store.lessons().map(lessonView),
    unassigned: opts.learn!.store.unassigned(1000).length,
  }));
  app.post("/v1/lessons/scan", async (c) => { const no = learnOff(c); if (no) return no; await opts.learn!.scan?.(); return c.json({ ok: true }); });
  const lessonAction = (action: (id: number, body: Record<string, unknown>) => unknown) => async (c: HonoContext) => {
    const no = learnOff(c); if (no) return no;
    const id = Number(c.req.param("id"));
    if (!opts.learn!.store.lesson(id)) return err(c, 404, "no such lesson");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try { return c.json(lessonView(await action(id, body) as never)); }
    catch (e) { return err(c, 409, (e as Error).message); }
  };
  app.post("/v1/lessons/:id/approve", lessonAction((id) => opts.learn!.store.approve(id, opts.learn!.improver, opts.memory)));
  app.post("/v1/lessons/:id/reject", lessonAction((id, b) => opts.learn!.store.reject(id, typeof b.note === "string" ? b.note : "")));
  app.post("/v1/lessons/:id/rollback", lessonAction((id) => opts.learn!.store.rollback(id, opts.learn!.improver)));

  // ---- skills (read-only; the model edits them through skill_manage / skill_propose) ----
  app.get("/v1/skills", (c) => {
    if (!opts.skillDirs) return err(c, 404, "skills disabled");
    return c.json({ skills: scanSkills(opts.skillDirs).map((s) => ({ name: s.name, description: s.description, tools: s.tools, path: s.path })) });
  });
  app.get("/v1/skills/:name", (c) => {
    if (!opts.skillDirs) return err(c, 404, "skills disabled");
    const s = scanSkills(opts.skillDirs).find((x) => x.name === c.req.param("name"));
    if (!s) return err(c, 404, "no such skill");
    return c.json({ name: s.name, description: s.description, tools: s.tools, path: s.path, body: s.body, files: linkedFiles(s) });
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
