import { DEFAULT_SESSION_TALK, XSESSION_APPROVED, extendSessionExchange, readSessionExchange, type SessionTalkPolicy } from "./session-talk.js";
import { getImageBlockAt, projectAgentEvent, projectEntryImages, projectSnapshotImages } from "./session-images.js";
import { readClaudeUsage, usageNotice } from "./claude-usage.js";
import { createGitControl, GitError, type Workspace } from "./git-control.js";
import { createGitStatusReader } from "./git-status.js";
import { undoCommand } from "./undo.js";
import { BusyCommandError, DEFAULT_BUSY_INPUT, feedback, interruptBlocked, parseQueueCommand, queueCommand, type BusyMode, type BusyPolicy } from "./busy-input.js";
import { GENERAL_PROJECT, ProjectError } from "./projects.js";
import { BoardError, MAX_ATTACHMENT_BYTES } from "./board.js";
import { answerEvent, cardEvents, deliverCardEvents, ownerSession, wakeEvents } from "./board-events.js";
import { ConversationError, type ConversationStore, type ConversationMeta } from "./conversations.js";
// HTTP + SSE API over the durable Luna harness. Transport-only: all state lives in the harness (SQLite).
import { Hono, type Context as HonoContext } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { completeFiles } from "./file-mentions.js";
import { createWebApp } from "./web-assets.js";
import { newestMessageTime, SessionCreated } from "./session-activity.js";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { configure, LiveDoc, UsageDoc, watchEvents, type Tx, type ConversationId, type ConversationRecord, type UserInput, type AgentEvent, type EntryId } from "@earendil-works/pi-durable";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { AskDoc, checkAnswer } from "./ask.js";
import { isRunning, readSessionStatus, markSessionRead, type SessionState } from "./session-status.js";
import { Children, readChildReport, type ChildRow } from "./delegate-state.js";
import { readDelegationUsage } from "./delegate-usage.js";
import { GoalDoc } from "./goal.js";
import { GRILL_USAGE, grillPrompt, parseGrill } from "./grill-command.js";
import { SKILLCRAFT_USAGE, parseSkillcraft, skillcraftPrompt } from "./skillcraft-command.js";
import { LEARN_USAGE, learnPrompt, parseLearn } from "./learn-command.js";
import type { McpManager } from "./mcp.js";
import type { SkillImprover } from "./improve.js";
import type { LearnStore } from "./learn.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderManager } from "./providers.js";
import { context, ProcessOwner, type MemoryStore } from "./luna.js";
import type { CronStore, Scheduler } from "./scheduler.js";
import { linkedFiles, scanSkills } from "./skills.js";
import { TodoDoc } from "./todo.js";
import { workerMediaResponse } from "./worker-media.js";
import { ExecTarget, WorkerError, type WorkerHub } from "./workers.js";
import { createPlannedSession, linkProject, planSession, SessionCreateError, THINKING_LEVELS as SESSION_THINKING_LEVELS, type SessionRequest } from "./session-create.js";
import { createAnalyticsReader } from "./analytics.js";
import type { SessionTitler } from "./titles.js";
import { readLimitWait, type LimitContinuer, type RecoverySummary } from "./limit-continue.js";
import { REVIEW_DEFAULT_PROMPT } from "./review.js";
import { SideCommands, type SideInput, type SideJob } from "./side-commands.js";
import { sideMedia, resolveMedia, mediaResponse } from "./side-media.js";
import { entryMedia } from "./media-directives.js";
import { GhError, REPO_PART, ghStatus, projectRepos, pullFiles } from "./github.js";
import { repoInfo, listItems } from "./github-list.js";
import { detail, commentsPage } from "./github-detail.js";
import { createGithubCache } from "./github-cache.js";
import * as ghActions from "./github-actions.js";
import { cardInput, itemUrl, linked } from "./github-board.js";
import { z } from "zod";
import { activeContextTokens } from "./context-usage.js";
import { MAX_UPLOAD_BYTES, UploadError, type UploadMetadata, type UploadStore } from "./uploads.js";
import { parseUploadInput as parseInput, prepareUploadInput, type UploadInput } from "./upload-input.js";
import { uploadWriter } from "./worker-protocol.js";
import { withAbortSignal } from "@earendil-works/chord/context";

// Carry placement identity with its entry so viewers can replace local pending input atomically.
// One entry can contain several steering submissions combined by the harness.
function withSubmissions(events: readonly AgentEvent[]) {
  const placements = events.filter(event => event.type === "submission" && event.record.entry !== undefined);
  return events.map(event => event.type === "entry_appended"
    ? { ...event, submissions: placements.flatMap(p => p.type === "submission" && p.record.entry === event.entry.id ? [p.record] : []) }
    : event);
}

const THINKING_LEVELS: readonly string[] = SESSION_THINKING_LEVELS;

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export interface ServerOptions {
  connection?: ReturnType<typeof import("./connection.js").daemonConnection>;
  harness: Harness;
  sideCommands?: SideCommands;
  /** Automatic and on-demand session titles. Absent: no title generation. */
  titler?: SessionTitler;
  /** Automatic continuation after usage limits. Absent: no waits are reported or cancelled. */
  limitContinuer?: LimitContinuer;
  settings?: SettingsStore;
  /** Policy for a runtime without a file-backed settings store. */
  busyInput?: () => BusyPolicy;
  sessionTalk?: () => SessionTalkPolicy;
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
  /** Execution workers. Absent: sessions run on this host only. */
  workers?: WorkerHub;
  /** Persistent incoming files. Only paths and metadata enter durable conversation storage. */
  uploads?: UploadStore;
  /** Default working directory on this host, for `@file:` completion before a session exists. */
  cwd?: string;
  /** Session learning ledger and the improver that applies approved proposals. */
  learn?: { store: LearnStore; improver: SkillImprover; scan?: () => Promise<unknown> | undefined };
}

type Input = UploadInput;

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(opts: ServerOptions) {
  const { harness } = opts;
  const sideCommands = opts.sideCommands ?? new SideCommands({
    harness,
    models: opts.models,
    remoteEnv: opts.workers ? (worker, cwd) => opts.workers!.env(worker, cwd) : undefined,
    reviewEnvironment: opts.workers ? worker => opts.workers!.reviewEnvironment(worker) : undefined,
    cwd: opts.cwd,
  });
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
    const work = serial(id, async () => {
      await opts.limitContinuer?.cancel(Number(conv.id), "Stopped by the user.");
      return conv.abort(context);
    });
    stops.set(id, work);
    try { await work; }
    finally { draining.delete(id); stops.delete(id); }
  };
  const err = (c: HonoContext, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503 | 504, message: string) => c.json({ error: message }, status);

  app.onError((e, c) => {
    if (e instanceof BusyCommandError) return err(c, e.status, e.message);
    if (e instanceof ConversationError || e instanceof ProjectError || e instanceof BoardError || e instanceof UploadError) return err(c, e.status, e.message);
    const name = (e as Error).name;
    if (name === "ConversationBusy") return err(c, 409, "conversation busy");
    return err(c, 500, (e as Error).message ?? String(e));
  });

  // Session pages and catalogs are 100-400 KB of JSON; gzip cuts them ~5x on Wi-Fi and phones. SSE is never compressed.
  app.use("*", compress({ contentTypeFilter: /^(?:application\/json|text\/javascript|text\/css)/ }));

  // The desktop shell (Tauri) loads the UI from its own origin and calls this daemon cross-origin. Bearer auth, no cookies.
  const desktopOrigins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
  const connectionOrigin = (origin: string) => desktopOrigins.includes(origin) || opts.connection?.allowsOrigin(origin) ? origin : undefined;
  app.use("/health", cors({ origin: connectionOrigin }));
  app.use("/v1/*", cors({ origin: connectionOrigin, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));

  // ---- web UI + health (unauthenticated; the page holds no data, every /v1 call needs the token) ----
  const webApp = createWebApp(new URL("../dist/web/", import.meta.url));
  app.route("/", webApp);
  app.get("/health", async c => {
    if (opts.token) return c.json({ ok: true, auth: true, daemonId: opts.connection?.id });
    const inspection = await harness.inspect(context);
    return c.json({ ok: true, auth: false, daemonId: opts.connection?.id, uptimeMs: Date.now() - started, live: inspection as unknown });
  });

  // ---- auth ----
  app.use("/v1/*", async (c, next) => {
    if (opts.token) {
      const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
      if (!m || !safeEq(m[1]!, opts.token)) return err(c, 401, "unauthorized");
    }
    await next();
  });

  app.get("/v1/connection", c => opts.connection ? c.json(opts.connection.info()) : c.json({ error: "Connection discovery unavailable" }, 404));

  const getConv = async (id: string) => harness.conversation(id as never, context);
  /** Agent choices for a new conversation; the default model comes from the provider manager when present. */
  const baseAgent = () => {
    const c = opts.settings?.resolved();
    return { ...(opts.agent ?? {}), ...(opts.providers && { model: opts.providers.defaultModel() }),
      ...(c?.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}),
      ...(c?.instructions ? { instructions: c.instructions } : {}) };
  };

  const prepareAttachments = async (input: Input, conv: NonNullable<Awaited<ReturnType<Harness["conversation"]>>>, signal: AbortSignal): Promise<UserInput> => {
    if (typeof input === "string" || input.every(block => block.type === "text")) return prepareUploadInput(input, opts.uploads);
    const worker = (await harness.snapshot(ExecTarget, conv.id, context))?.worker;
    let copy: ((file: UploadMetadata) => Promise<UploadMetadata>) | undefined;
    if (worker) {
      if (!opts.workers?.store.get(worker)?.capabilities?.uploadFiles) throw new UploadError(400, "This execution worker cannot store uploads. Update it to the same Luna version.");
      const env = opts.workers.env(worker, (await conv.agent(context)).cwd);
      const writer = uploadWriter(env);
      if (!writer) throw new UploadError(500, "Worker upload storage is unavailable.");
      copy = async file => {
        if (!opts.uploads) throw new UploadError(500, "Upload storage is unavailable.");
        const result = await writer.writeUpload({ name: file.name, mimeType: file.mimeType, data: new Uint8Array(opts.uploads.read(file.id)) }, withAbortSignal(signal, context));
        if (!result.ok) throw new UploadError(500, `Could not copy the upload to its execution worker: ${result.error.message}`);
        const local = result.value;
        if (local.id !== file.id || local.ref !== file.ref || local.name !== file.name || local.size !== file.size || typeof local.path !== "string") {
          throw new UploadError(500, "The execution worker returned an invalid upload receipt.");
        }
        return local;
      };
    }
    return prepareUploadInput(input, opts.uploads, copy, signal, file => harness.commit(() => {
      if (!opts.uploads) throw new UploadError(500, "Upload storage is unavailable.");
      return opts.uploads.put(file);
    }, context));
  };

  app.post("/v1/uploads", bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: c => err(c, 413, "file too large (32 MB max)") }), async c => {
    if (!opts.uploads) return err(c, 503, "upload storage unavailable");
    const name = c.req.query("name");
    if (!name?.trim()) return err(c, 400, "file name required");
    const data = new Uint8Array(await c.req.arrayBuffer());
    const metadata = await harness.commit(() => opts.uploads!.put({ name,
      mimeType: c.req.header("content-type") || "application/octet-stream", data }), context);
    return c.json(metadata, 201);
  });
  app.get("/v1/uploads/:id", c => {
    const file = opts.uploads?.get(c.req.param("id"));
    if (!file) return err(c, 404, "uploaded file not found");
    const bytes = opts.uploads!.read(file.id);
    return new Response(new Uint8Array(bytes), { headers: {
      "content-type": file.mimeType, "content-length": String(bytes.byteLength), "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    } });
  });

  app.get("/v1/settings", c => opts.settings ? c.json(opts.settings.view()) : err(c, 404, "settings disabled"));
  app.get("/v1/models/pins", c => opts.settings ? c.json({ pins: opts.settings.read().pinnedModels }) : err(c, 404, "settings disabled"));
  app.post("/v1/models/pins", async c => {
    if (!opts.settings) return err(c, 404, "settings disabled");
    const body = await c.req.json().catch(() => null);
    if (!body || !["import", "toggle", "move"].includes(body.action)) return err(c, 400, "Invalid pin action");
    if (body.action === "import" ? !Array.isArray(body.pins) || !body.pins.every((p: unknown) => typeof p === "string" && p.length > 0)
      : typeof body.key !== "string" || !body.key.length || (body.action === "move" && body.direction !== -1 && body.direction !== 1)) return err(c, 400, "Invalid pins");
    opts.settings.update(settings => {
      const pins = settings.pinnedModels;
      if (body.action === "import") settings.pinnedModels = [...new Set([...pins, ...body.pins])];
      else {
        const index = pins.indexOf(body.key);
        if (body.action === "toggle") { if (index < 0) pins.push(body.key); else pins.splice(index, 1); }
        else {
          const target = index + body.direction;
          if (index >= 0 && target >= 0 && target < pins.length) [pins[index], pins[target]] = [pins[target]!, pins[index]!];
        }
      }
    });
    return c.json({ pins: opts.settings.read().pinnedModels });
  });
  const analytics = createAnalyticsReader(harness, opts.models);
  app.get("/v1/analytics", async c => {
    const started = performance.now();
    const snapshot = await analytics(c.req.query("refresh") === "true");
    const readMs = performance.now() - started;
    const payload = c.req.query("view") === "overview"
      ? { ...snapshot, sessionsList: snapshot.sessionsList.slice(0, 5) } : snapshot;
    const serializeStarted = performance.now();
    const body = JSON.stringify(payload);
    c.header("Server-Timing", `analytics;dur=${readMs.toFixed(2)}, serialize;dur=${(performance.now() - serializeStarted).toFixed(2)}`);
    c.header("Cache-Control", "no-store");
    return c.body(body, 200, { "Content-Type": "application/json; charset=UTF-8" });
  });
  app.get("/v1/analytics/sessions", async c => {
    const pageRaw = c.req.query("page") ?? "0", limitRaw = c.req.query("limit") ?? "20";
    const page = Number(pageRaw), limit = Number(limitRaw);
    const sorts = ["title", "status", "tokens", "cost", "hitRate", "responses", "duration", "activity"]
      .flatMap(key => [key + "Asc", key + "Desc"]);
    const sort = c.req.query("sort") ?? "tokensDesc";
    if (!/^\d+$/.test(pageRaw) || !Number.isSafeInteger(page) || page < 0 ||
        !/^\d+$/.test(limitRaw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !sorts.includes(sort)) {
      return err(c, 400, "Invalid analytics pagination or sort");
    }
    const started = performance.now();
    const snapshot = await analytics(c.req.query("refresh") === "true");
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const status = c.req.query("status") ?? "";
    const rows = snapshot.sessionsList.filter(row => (!status || row.status === status) &&
      (!search || row.id.includes(search) || row.title?.toLowerCase().includes(search)));
    const sortValues: Record<string, (row: typeof rows[number]) => string | number | null> = {
      title: row => row.title || "Untitled session",
      status: row => row.status,
      tokens: row => row.usage.totalTokens,
      cost: row => row.usage.cost.total,
      hitRate: row => row.usage.cacheHitRate,
      responses: row => row.responses,
      duration: row => row.durationMs,
      activity: row => row.lastActivity,
    };
    const value = sortValues[sort.replace(/(Asc|Desc)$/, "")]!; // Validated against sorts above.
    rows.sort((a, b) => {
      const left = value(a), right = value(b);
      // Unknown values belong last, regardless of the requested direction.
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      const order = left == null || right == null ? 0
        : typeof left === "number" && typeof right === "number" ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true });
      return (sort.endsWith("Desc") ? -order : order) || a.id.localeCompare(b.id, undefined, { numeric: true });
    });
    const actualPage = Math.min(page, Math.max(0, Math.ceil(rows.length / limit) - 1));
    c.header("Server-Timing", `analytics;dur=${(performance.now() - started).toFixed(2)}`);
    c.header("Cache-Control", "no-store");
    return c.json({ generatedAt: snapshot.generatedAt, sessions: rows.slice(actualPage * limit, (actualPage + 1) * limit),
      total: rows.length, allTotal: snapshot.sessions, statusBreakdown: snapshot.statusBreakdown, page: actualPage, limit });
  });
  app.put("/v1/settings", async c => {
    if (!opts.settings) return err(c, 404, "settings disabled");
    try {
      const b = await c.req.json();
      if (!b || typeof b !== "object" || !b.config || typeof b.revision !== "string") return err(c, 400, "config and revision required");
      // Main and child defaults must name an available model when changed.
      const old = opts.settings.read();
      const roles = b.config.subagents?.profiles ?? {};
      const defaults = [[b.config, old], [b.config.subagents ?? {}, old.subagents],
        ...Object.entries(roles).map(([name, profile]) => [profile, old.subagents.profiles[name] ?? {}])];
      for (const [next, prev] of defaults as [Record<string, any>, Record<string, any>][]) {
        if (old.providers.some(p => p.id === next.provider) && !b.config.providers?.some((p: { id: string }) => p.id === next.provider)) return err(c, 400, "Select another default before removing its provider");
        if (next.provider && next.model && (next.provider !== prev.provider || next.model !== prev.model) && !opts.models?.getModel(next.provider, next.model)) {
          const custom = b.config.providers?.find((p: {id: string}) => p.id === next.provider);
          if (!custom?.models?.some((m: {id: string}) => m.id === next.model)) return err(c, 400, "unknown default model");
        }
      }
      opts.settings.replace(b.config, b.revision);
      const warnings = await opts.settings.apply(old);
      return c.json({ ...opts.settings.view(), warnings });
    } catch (e) { return err(c, (e as Error).message.includes("Reload before") ? 409 : 400, (e as Error).message); }
  });

  // ---- sessions ----
  // The list is refetched on every sessions_changed event, which fires on each committed entry while any session
  // runs. Rebuilding every row costs ~10 synchronous SQLite reads per conversation and blocked the event loop for
  // seconds. Cache the storage-derived part of each row and rebuild only conversations that a commit touched.
  // Metadata, project links and the limit-continue setting stay live: they are cheap and change outside commits.
  type SessionRow = SessionState & { hidden: boolean; parent: unknown; firstUser: string; running: boolean; wait: number | null; recovery: RecoverySummary | null; lastActivity: number | null; createdAt: number | null; worker: number | null };
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
  const buildRow = async (tx: Tx, r: Pick<ConversationRecord, "id" | "parent">): Promise<SessionRow> => {
    const head = (await tx.scanEntries({ conversationId: r.id, order: "ascending" }, 30)).items;
    const firstUser = textOf(head.find((e) => e.kind === "pi.user")).replace(/\s+/g, " ").slice(0, 60);
    const ownHead = r.parent ? (await tx.scanEntries({ conversationId: r.id, order: "ascending", minEntryId: (Number(r.parent.at) + 1) as never }, 30)).items : head;
    if (ownHead.some((e) => e.kind === "delegate.child")) return { hidden: true, parent: null, firstUser, running: false, status: "ready", statusReason: null, wait: null, recovery: null, lastActivity: null, createdAt: null, worker: null };
    const running = await isRunning(tx, r.id);
    return {
      hidden: false, parent: r.parent ?? null, firstUser, running, ...await readSessionStatus(tx, r.id, running),
      wait: running ? null : (await readLimitWait(tx, r.id))?.resumeAt ?? null,
      recovery: running ? null : await opts.limitContinuer?.recovery(tx, r.id) ?? null,
      lastActivity: await newestMessageTime(tx, r.id),
      createdAt: (await tx.doc(SessionCreated, r.id)).at ?? null,
      worker: (await tx.doc(ExecTarget, r.id)).worker,
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
    const recoveryBudget = opts.limitContinuer?.attemptLimit();
    const sessions: (SessionState & { id: unknown; parent: unknown; project: number | null; title: string; archived: boolean; pinned: boolean; running: boolean; resumeAt: number | null; recovery: RecoverySummary | null; lastActivity: number | null; createdAt: number | null; worker: number | null })[] = [];
    for (const [id, row] of built) {
      if (row.hidden) continue;
      const { hidden: _hidden, firstUser, wait, recovery, ...rest } = row;
      const meta = opts.conversations?.get(id) ?? { title: null, archived: false, pinned: false };
      sessions.push({ ...rest, id, project: links?.get(id) ?? (opts.conversations ? GENERAL_PROJECT.id : null), ...meta, title: meta.title ?? firstUser, resumeAt: continuing && !row.running ? wait : null, recovery: !row.running && (continuing || recovery?.pausedReason) && recovery
        ? { ...recovery, maxAttempts: recoveryBudget ?? recovery.maxAttempts } : null });
    }
    sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) || Number(b.id) - Number(a.id));
    return c.json({ sessions });
  });

  // POST preview avoids query-string coercion and shares strict validation with confirmation.
  for (const preview of [true, false]) app.post(preview ? "/v1/sessions/prune/preview" : "/v1/sessions/prune", async c => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const b = await c.req.json().catch(() => null);
    const ids = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => Number.isSafeInteger(n) && n > 0);
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some(k => !["days", "includeArchived", "excludeIds", ...(preview ? [] : ["ids"])].includes(k))
      || !Number.isSafeInteger(b.days) || b.days < 1 || !Number.isSafeInteger(b.days * 86400000)
      || typeof b.includeArchived !== "boolean" || !ids(b.excludeIds) || (!preview && !ids(b.ids))) {
      return err(c, 400, "positive whole days, includeArchived, excludeIds, and confirmed ids for deletion required");
    }
    const selected = await opts.conversations.prune(b, preview ? undefined : b.ids, async (id, tx) => {
      if (sideCommands.list(String(id)).some(job => job.status === "running")) return true;
      const owner = (await tx.doc(ProcessOwner, id as ConversationId)).token;
      return harness.busyTools?.sessionProcesses(id as ConversationId, owner).some(p => p.status === "running") ?? false;
    });
    if (!preview) await opts.limitContinuer?.reconcile();
    return c.json(preview ? { ids: selected } : { deleted: selected });
  });

  app.patch("/v1/sessions/:id/metadata", async c => {
    if (!opts.conversations) return err(c, 404, "conversation management disabled");
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b) || !Object.keys(b).length || Object.keys(b).some(k => !["title", "archived", "pinned"].includes(k))) return err(c, 400, "title, archived or pinned required");
    if ("title" in b && (typeof b.title !== "string" || !b.title.trim() || b.title.trim().length > 200)) return err(c, 400, "title must contain 1 to 200 characters");
    for (const k of ["archived", "pinned"]) if (k in b && typeof b[k] !== "boolean") return err(c, 400, k + " must be a boolean");
    const id = Number(c.req.param("id")); if (!Number.isSafeInteger(id) || id < 1) return err(c, 404, "no such session");
    const changes = { ...b, ...("title" in b ? { title: b.title.trim() } : {}) } as Partial<ConversationMeta>;
    if (changes.archived) await opts.limitContinuer?.cancel(id, "Session archived.");
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
    await opts.limitContinuer?.cancel(id, "Session deleted.");
    const deleted = await opts.conversations.delete(id);
    await opts.limitContinuer?.reconcile();
    return c.json({ deleted });
  });

  // ---- projects: a named working directory that new sessions inherit ----
  const projectId = (c: HonoContext) => { const n = Number(c.req.param("id")); return Number.isSafeInteger(n) && n >= 0 ? n : -1; };
  app.get("/v1/projects", (c) => opts.conversations ? c.json({ projects: opts.conversations.projects.list() }) : err(c, 404, "projects disabled"));
  app.post("/v1/projects", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const b = await c.req.json().catch(() => ({})) as { name?: unknown; cwd?: unknown; worker?: unknown; workerCwd?: unknown };
    const hasWorker = b.worker !== undefined || b.workerCwd !== undefined;
    if (hasWorker) {
      if (!Number.isSafeInteger(b.worker) || (b.worker as number) < 1) return err(c, 400, "invalid worker");
      const worker = b.worker as number;
      if (!opts.workers?.store.get(worker)) return err(c, 404, "no such worker");
      let hostCwd: unknown = b.cwd ?? ""; let workerCwd: unknown = b.workerCwd;
      if (workerCwd === undefined && typeof hostCwd === "string" && hostCwd.trim() !== "") { workerCwd = hostCwd; hostCwd = ""; }
      return c.json(opts.conversations.projects.create(b.name, hostCwd, { worker, workerCwd }), 201);
    }
    return c.json(opts.conversations.projects.create(b.name, b.cwd), 201);
  });
  app.patch("/v1/projects/:id", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const b = await c.req.json().catch(() => ({})) as { name?: unknown; cwd?: unknown; favorite?: unknown };
    return c.json(opts.conversations.projects.update(projectId(c), b));
  });
  // Link a project to a machine: one project, one board, a working directory per machine.
  const workerParam = (c: HonoContext) => { const n = Number(c.req.param("worker")); return Number.isSafeInteger(n) && n > 0 ? n : -1; };
  app.put("/v1/projects/:id/machines/:worker", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const w = workerParam(c); if (!opts.workers?.store.get(w)) return err(c, 404, "no such worker");
    const b = await c.req.json().catch(() => ({})) as { cwd?: unknown };
    const project = opts.conversations.projects.setWorkerDir(projectId(c), w, b.cwd);
    opts.conversations.touch();
    return c.json(project);
  });
  app.delete("/v1/projects/:id/machines/:worker", (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    // "main" is the host. Removing a machine never touches the board; only deleting the project does.
    const project = c.req.param("worker") === "main" ? opts.conversations.projects.removeHostDir(projectId(c)) : opts.conversations.projects.removeWorkerDir(projectId(c), workerParam(c));
    opts.conversations.touch();
    return c.json(project);
  });
  app.delete("/v1/projects/:id", (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    opts.conversations.projects.delete(projectId(c));
    opts.conversations.touch();
    return c.json({ ok: true });
  });

  // ---- per-project skill overrides: on, off, or inherit the global setting ----
  const skillsOf = (c: HonoContext) => {
    if (!opts.conversations) throw new ProjectError(404, "projects disabled");
    if (!opts.skillDirs) throw new ProjectError(404, "skills disabled");
    const id = projectId(c); if (!opts.conversations.projects.get(id)) throw new ProjectError(404, "no such project");
    return { conv: opts.conversations, id, dirs: opts.skillDirs };
  };
  app.get("/v1/projects/:id/skills", (c) => {
    const { conv, id, dirs } = skillsOf(c);
    const off = opts.settings?.read().disabledSkills ?? [];
    const over = conv.projectSkills.overrides(id);
    return c.json(scanSkills(dirs).map((s) => {
      const global = !off.includes(s.name), override = id === 0 ? null : over.get(s.name) ?? null;
      return { name: s.name, description: s.description, global, override, effective: override ?? global };
    }));
  });
  app.put("/v1/projects/:id/skills/:name", async (c) => {
    const { conv, id, dirs } = skillsOf(c);
    if (id === 0) throw new ProjectError(409, "The General project uses the global skill settings");
    const name = c.req.param("name");
    if (!scanSkills(dirs).some((s) => s.name === name)) throw new ProjectError(404, "no such skill");
    const b = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
    if (!b || (b.enabled !== null && typeof b.enabled !== "boolean")) throw new ProjectError(400, "enabled must be true, false, or null");
    conv.projectSkills.set(id, name, b.enabled);
    conv.touch();
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
    // A change through the HTTP API is a user change: the owner session gets an event (the model's board tool sends none for its own moves).
    const cid = cardId(c);
    const before = conv.board.get(id, cid);
    const answer = typeof b.answer === "string" && b.answer.trim() ? b.answer : undefined;
    if (b.answer !== undefined && typeof b.answer !== "string") throw new BoardError(400, "answer must be text");
    // `project` moves the card; the rest of the body applies as usual.
    const target = b.project;
    if (target !== undefined) {
      if (!Number.isSafeInteger(target) || (target as number) < 0) throw new BoardError(400, "project must be a project id");
      if (!conv.projects.get(target as number)) throw new BoardError(404, "no such project");
      delete b.project;
    }
    // Answering a blocked card unblocks it, unless the same request sets the reason.
    if (answer && before?.blocked && b.blocked === undefined) b.blocked = null;
    const card = await write(conv, () => {
      const updated = conv.board.update(id, cid, b);
      return target === undefined || target === id ? updated : conv.board.move(id, cid, target as number);
    });
    if (before) {
      const events = [...cardEvents(before, card), ...wakeEvents(conv.board, target === undefined ? id : target as number, before, card), ...(answer ? answerEvent({ ...card, blocked: before.blocked }, answer) : [])];
      if (answer) conv.board.log(cid, "user", `answer: ${answer.trim().slice(0, 200)}`);
      const dead = await deliverCardEvents(harness, events);
      if (dead.length) {
        for (const o of new Set([before.owner, card.owner])) if (o && dead.includes(ownerSession(o) ?? -1)) conv.board.clearOwner(id, cid, o);
        conv.touch();
      }
    }
    return c.json(conv.board.get(id, cid) ?? card);
  });
  app.get("/v1/projects/:id/cards/:cardId/activity", (c) => {
    const { conv, id } = boardOf(c);
    return c.json({ activity: conv.board.activity(id, cardId(c)) });
  });
  // Attachments: raw body upload (`?name=`, Content-Type kept), download, remove. Stored with the card.
  const attachmentId = (c: HonoContext) => { const n = Number(c.req.param("attachmentId")); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
  app.post("/v1/projects/:id/cards/:cardId/attachments", bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES, onError: (c) => err(c, 400, `file too large (${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB max)`) }), async (c) => {
    const { conv, id } = boardOf(c);
    const data = new Uint8Array(await c.req.arrayBuffer());
    const a = await write(conv, () => conv.board.attach(id, cardId(c), { name: c.req.query("name"), type: c.req.header("content-type"), data }));
    return c.json(a, 201);
  });
  app.get("/v1/projects/:id/cards/:cardId/attachments/:attachmentId", (c) => {
    const { conv, id } = boardOf(c);
    const f = conv.board.file(id, cardId(c), attachmentId(c));
    if (!f) throw new BoardError(404, "attachment not found");
    return new Response(f.data, { headers: {
      "content-type": f.type, "content-length": String(f.data.byteLength), "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    } });
  });
  app.delete("/v1/projects/:id/cards/:cardId/attachments/:attachmentId", async (c) => {
    const { conv, id } = boardOf(c);
    await write(conv, () => conv.board.detach(id, cardId(c), attachmentId(c)));
    return c.json({ ok: true });
  });
  app.delete("/v1/projects/:id/cards/:cardId", async (c) => {
    const { conv, id } = boardOf(c);
    await write(conv, () => conv.board.delete(id, cardId(c)));
    return c.json({ ok: true });
  });

  // ---- execution workers ----
  const machineOf = async (id: ConversationId) => {
    const worker = (await harness.snapshot(ExecTarget, id, context).catch(() => undefined))?.worker ?? null;
    if (worker === null) return null;
    const w = opts.workers?.view(worker);
    return w ? { id: w.id, name: w.name, online: w.online } : { id: worker, name: null, online: false };
  };
  const workerErr = (c: HonoContext, e: unknown) => { if (e instanceof WorkerError) return err(c, e.status, e.message); throw e; };
  app.get("/v1/workers", (c) => c.json({ workers: opts.workers?.list() ?? [] }));
  app.post("/v1/workers", async (c) => {
    if (!opts.workers) return err(c, 404, "workers disabled");
    const b = await c.req.json().catch(() => ({})) as { name?: unknown };
    try { return c.json(opts.workers.store.create(b.name), 201); } catch (e) { return workerErr(c, e); }
  });
  app.delete("/v1/workers/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!opts.workers || !Number.isSafeInteger(id) || !opts.workers.remove(id)) return err(c, 404, "no such worker");
    opts.conversations?.projects.forgetWorker(id);
    return c.json({ ok: true });
  });

  app.post("/v1/sessions", async (c) => {
    const b = await c.req.json().catch(() => ({})) as SessionRequest;
    let plan;
    try {
      plan = planSession({ base: baseAgent, models: opts.models, projects: opts.conversations?.projects, workers: opts.workers?.store, projectExtensions: opts.projectExtensions }, b);
    } catch (e) { if (e instanceof SessionCreateError) return err(c, e.status, e.message); throw e; }
    const id = await harness.commit(tx => createPlannedSession(tx, plan), context);
    linkProject(opts.conversations?.projects, Number(id), plan);
    return c.json({ id }, 201);
  });

  // Fork: a new session whose model context starts as of one visible entry of this session. The stored agent
  // state (model, thinking level, tools) rides along in the built-in `pi.agent` document (rewindable, fork asOf);
  // `ExecTarget` is fork `current`, so the worker target survives. Docs marked fork `initial` (goal, ask, ...) stay behind.
  app.post("/v1/sessions/:id/fork", async c => {
    if (!opts.conversations) return err(c, 404, "fork disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = await c.req.json().catch(() => ({})) as { at?: unknown };
    if (!Number.isSafeInteger(b.at)) return err(c, 400, "at must be an entry id");
    let badEntry: string | null = null;
    const forked = await harness.commit(async tx => {
      // One commit: fork at one visible entry. Visibility is pi-durable's rule, and it is fork-aware: an entry
      // inherited from a parent conversation (shown in this session's transcript) counts. The stored agent state
      // (model, thinking, tools) rides along via the built-in `pi.agent` document copies in this commit.
      try {
        return await tx.forkConversation(conv.id, b.at as EntryId, { ownership: { kind: "ownerless" } });
      } catch (e) {
        if (/not visible from conversation/.test((e as Error).message)) { badEntry = (e as Error).message; return undefined; }
        throw e;
      }
    }, context);
    if (badEntry !== null || !forked) return err(c, 404, "entry is not visible in this session");
    const project = opts.conversations.projects.projectOf(Number(conv.id));
    if (project) opts.conversations.projects.link(Number(forked.id), project);
    return c.json({ id: forked.id }, 201);
  });

  const contextUsage = async (conv: NonNullable<Awaited<ReturnType<typeof getConv>>>) => {
    const agent = await conv.agent(context);
    const model = agent.model && opts.models?.getModel(agent.model.provider, agent.model.modelId);
    const capacity = model && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
    const view = await conv.context(context);
    const usedTokens = activeContextTokens(view);
    const live = await harness.snapshot(LiveDoc, conv.id, context);
    return {
      usedTokens, contextWindow: capacity, percent: capacity === null ? null : usedTokens / capacity * 100,
      estimated: true as const,
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
  const childViews = (parent: ConversationId, rows: ChildRow[]) => harness.commit(async tx => Promise.all(rows.map(async row => {
    if (!await tx.conversation(row.id as ConversationId)) return { id: row.id, task: row.task, status: "deleted" as const, statusReason: null };
    const report = await readChildReport(tx, parent, row.id);
    const status = report.state === "done" ? "finished" : report.state === "idle" ? "ready" : report.state === "unanswered" ? "failed" : report.state;
    return { id: row.id, task: row.task, status, statusReason: report.reason ?? null,
      profile: row.profile ?? null, cwd: row.cwd ?? null, resultStatus: report.resultStatus };
  })), context);
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
      // so this GET returns the completion status; subsequent reads see "ready".
      if (!running && ["finished", "review_finished"].includes(status.status)) await markSessionRead(tx, conv.id);
      return { running, ...status, resumeAt: await resumeAt(tx, conv.id, running),
        recovery: running ? null : await opts.limitContinuer?.recovery(tx, conv.id) ?? null };
    }, context);
    return c.json({
      id: conv.id,
      project: opts.conversations?.projects.projectOf(Number(conv.id)) ?? null,
      running,
      status: sessionStatus.status,
      statusReason: sessionStatus.statusReason,
      resumeAt: sessionStatus.resumeAt,
      recovery: sessionStatus.recovery,
      agent: { model: a.model ?? null, thinkingLevel: a.thinkingLevel, cwd: a.cwd ?? null, instructions: a.instructions ?? null, tools: a.tools.map((t) => t.name) },
      machine: await machineOf(conv.id),
      usage: usage ?? null,
      contextUsage: await contextUsage(conv),
      children: await childViews(conv.id, kids?.children ?? []),
      delegationUsage: kids?.children.length ? await harness.commit(tx => readDelegationUsage(tx, conv.id), context) : null,
      processes: await processesOf(conv.id),
      todos: (todo?.tasks ?? []).filter((t) => t.status !== "deleted"),
      questions: ask?.pending ?? [],
      goal: goal?.goal ?? null,
      entries: page.items.map(entry => projectEntryImages(entry, conv.id)),
    });
  });

  const readGitStatus = createGitStatusReader();
  const gitControl = createGitControl();
  const sessionEnv = async (id: string): Promise<Workspace> => {
    const conv = await getConv(id);
    if (!conv) throw new GitError("No such session", 404);
    const worker = (await harness.snapshot(ExecTarget, conv.id, context))?.worker ?? null;
    const cwd = (await conv.agent(context)).cwd ?? undefined;
    if (worker !== null && !opts.workers?.view(worker)?.online) throw new GitError("Machine unavailable", 503);
    return { machine: worker === null ? 'main' : String(worker),
      env: worker === null ? new NodeExecutionEnv({ cwd: cwd ?? opts.cwd ?? process.cwd() }) : opts.workers!.env(worker, cwd),
      commandEnv: worker === null ? undefined : opts.workers!.reviewEnvironment(worker) };
  };
  app.get("/v1/sessions/:id/git", async c => {
    try { const w = await sessionEnv(c.req.param('id')); return c.json(await readGitStatus(`${w.machine}:${w.env.cwd}`, w.env, w.commandEnv)); }
    catch (e) { if (e instanceof GitError && e.status === 404) return err(c, 404, e.message); return c.json({ state: 'unavailable', message: 'Machine unavailable' }); }
  });
  const gitWorkspace = async (c: HonoContext): Promise<Workspace> => {
    const session = c.req.query('session'), project = c.req.query('project');
    if (session && project) throw new GitError('Select either a session or a project', 400);
    if (session) return sessionEnv(session);
    if (!project || !/^\d+$/.test(project)) throw new GitError('Select a session or a project', 400);
    const p = opts.conversations?.projects.get(Number(project));
    if (!p || p.general || !p.cwd) throw new GitError('Project has no main-host directory', 400);
    return { machine: 'main', env: new NodeExecutionEnv({ cwd: p.cwd }) };
  };
  const gitFail = (c: HonoContext, e: unknown) => e instanceof GitError ? err(c, e.status, e.message) : err(c, 500, 'Git operation failed');
  app.get('/v1/git/changes', async c => { try { return c.json(await gitControl.changes(await gitWorkspace(c))); } catch (e) { return gitFail(c, e); } });
  app.get('/v1/git/branches', async c => { try { return c.json(await gitControl.branches(await gitWorkspace(c))); } catch (e) { return gitFail(c, e); } });
  app.get('/v1/git/diff', async c => {
    try { const path = c.req.query('path'), staged = c.req.query('staged') ?? '0';
      if (!path || !['0','1'].includes(staged)) throw new GitError('Invalid diff selection', 400);
      return c.json(await gitControl.diff(await gitWorkspace(c), path, staged === '1'));
    } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/log', async c => {
    try {
      const scope = c.req.query('scope') ?? 'head', skip = Number(c.req.query('skip') ?? 0), limit = Number(c.req.query('limit') ?? 100);
      if (!['head', 'all'].includes(scope) || !Number.isSafeInteger(skip) || skip < 0 || skip > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new GitError('Invalid history selection', 400);
      return c.json(await gitControl.log(await gitWorkspace(c), { all: scope === 'all', skip, limit }));
    } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/commit', async c => {
    try { return c.json(await gitControl.commit(await gitWorkspace(c), c.req.query('oid') ?? '')); } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/compare', async c => {
    try { return c.json(await gitControl.compare(await gitWorkspace(c), c.req.query('base') ?? '', c.req.query('head') ?? '')); } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/range-diff', async c => {
    try {
      const q = (k: string) => c.req.query(k) ?? '';
      if (q('path').length > 4096 || q('original').length > 4096) throw new GitError('Invalid diff path', 400);
      return c.json(await gitControl.rangeDiff(await gitWorkspace(c), q('base'), q('head'), q('path'), q('original') || undefined));
    } catch (e) { return gitFail(c, e); }
  });
  const gitPaths = z.strictObject({ paths: z.array(z.string().min(1).max(4096)).min(1).max(500) });
  const gitSchemas = {
    stage: gitPaths, unstage: gitPaths,
    commit: z.strictObject({ message: z.string().trim().min(1).max(10000) }),
    switch: z.strictObject({ branch: z.string().min(1).max(255), create: z.boolean().optional(), from: z.string().min(1).max(255).optional() }),
    fetch: z.strictObject({}), pull: z.strictObject({}),
    push: z.strictObject({ expectedBranch: z.string().min(1).max(255), expectedHead: z.string().regex(/^[0-9a-f]{40}$/), setUpstream: z.boolean().optional(), confirmDefault: z.boolean().optional() }),
  };
  for (const action of Object.keys(gitSchemas) as (keyof typeof gitSchemas)[]) app.post(`/v1/git/${action}`, async c => {
    try {
      const b = gitSchemas[action].safeParse(await c.req.json().catch(() => null));
      if (!b.success) throw new GitError(b.error.issues.map(i => i.message).join('; ').slice(0, 300), 400);
      const w = await gitWorkspace(c);
      try { const r = await gitControl.mutate(w, action, b.data); r.changes.busy = false; return c.json(r); }
      finally { readGitStatus.invalidate(); }
    } catch (e) { return gitFail(c, e); }
  });

  // ---- GitHub endpoints ----
  const githubCache = createGithubCache();
  const freshGithub = (c: HonoContext) => c.req.query("fresh") === "1";
  const readDetail = (repo: string, n: number, fresh = false) => {
    const [owner, name] = repo.split("/");
    return githubCache.read(`${repo.toLowerCase()}|detail|${n}`, 15_000, () => detail(owner!, name!, n), fresh);
  };
  const ghFail = (c: HonoContext, e: unknown) => e instanceof GhError ? err(c, (e.status === 401 ? 502 : e.status) as 400 | 403 | 404 | 409 | 422 | 500 | 502 | 503 | 504, e.message) : err(c, 500, "GitHub request failed");
  const repoOfParam = (c: HonoContext) => {
    const o = c.req.param("owner") ?? "";
    const n = c.req.param("name") ?? "";
    return REPO_PART.test(o) && REPO_PART.test(n) && ![".", ".."].includes(o) && ![".", ".."].includes(n) ? `${o}/${n}` : null;
  };

  app.get("/v1/github/status", async (c) => {
    try {
      return c.json(await githubCache.read("status", 300_000, ghStatus, freshGithub(c), value => value.state === "ok"));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos", async (c) => {
    try {
      return c.json({ repos: await projectRepos(opts.conversations?.projects.list() ?? []) });
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos/:owner/:name", async (c) => {
    const repo = repoOfParam(c);
    if (!repo) return err(c, 400, "invalid repository name");
    const [owner, name] = repo.split("/");
    try {
      return c.json(await githubCache.read(`${repo.toLowerCase()}|info`, 600_000, () => repoInfo(owner!, name!), freshGithub(c)));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos/:owner/:name/items", async (c) => {
    const repo = repoOfParam(c);
    if (!repo) return err(c, 400, "invalid repository name");
    const kind = c.req.query("kind");
    if (kind !== "pr" && kind !== "issue") return err(c, 400, "kind must be pr or issue");
    const state = c.req.query("state") ?? "open";
    if (!["open", "closed", "all"].includes(state)) return err(c, 400, "invalid state");
    const q = c.req.query("q") ?? "";
    if (q.length > 256) return err(c, 400, "query too long (max 256 chars)");
    const after = c.req.query("after");
    if (after && after.length > 1000) return err(c, 400, "invalid cursor");

    try {
      return c.json(await githubCache.read(`${repo.toLowerCase()}|list|${JSON.stringify([kind, state, q, after ?? null])}`, 30_000,
        () => listItems(repo, kind, state as "open" | "closed" | "all", q, after), freshGithub(c)));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos/:owner/:name/items/:number", async (c) => {
    const repo = repoOfParam(c);
    if (!repo) return err(c, 400, "invalid repository name");
    const numStr = c.req.param("number");
    const n = Number(numStr);
    if (!Number.isSafeInteger(n) || n < 1) return err(c, 400, "invalid item number");
    try {
      return c.json(await readDetail(repo, n, freshGithub(c)));
    } catch (e) {
      return ghFail(c, e);
    }
  });


  const ghNumber = (c: HonoContext) => {
    const raw = c.req.param("number") ?? "";
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new GhError("invalid item number", 400);
    return n;
  };
  const ghRepo = (c: HonoContext) => { const repo = repoOfParam(c); if (!repo) throw new GhError("invalid repository name", 400); return repo; };
  app.get("/v1/github/repos/:owner/:name/pulls/:number/files", async c => {
    try {
      const repo = ghRepo(c), n = ghNumber(c), page = Number(c.req.query("page") ?? 1);
      // GitHub lists at most 3000 files: 30 pages of 100.
      if (!Number.isSafeInteger(page) || page < 1 || page > 30) throw new GhError("Invalid page", 400);
      return c.json(await githubCache.read(`${repo.toLowerCase()}|files|${n}|${page}`, 15_000, () => pullFiles(repo, n, page), freshGithub(c)));
    } catch (e) { return ghFail(c, e); }
  });
  const ghBody = async <T,>(c: HonoContext, schema: z.ZodType<T>): Promise<T> => {
    const result = schema.safeParse(await c.req.json().catch(() => null));
    if (!result.success) throw new GhError(result.error.issues.map(i => i.message).join("; ").slice(0, 300), 400);
    return result.data;
  };
  app.get("/v1/github/repos/:owner/:name/items/:number/comments", async c => {
    try {
      const repo = ghRepo(c), n = ghNumber(c), before = c.req.query("before");
      if (!before || before.length > 1000) throw new GhError("Invalid comments cursor", 400);
      const [owner, name] = repo.split("/");
      return c.json(await commentsPage(owner!, name!, n, before));
    } catch (e) { return ghFail(c, e); }
  });
  const githubWrite = async <T,>(c: HonoContext, action: () => Promise<T>): Promise<T> => {
    const repo = ghRepo(c);
    try { return await action(); }
    finally { githubCache.invalidateRepo(repo); }
  };
  const commentBody = z.strictObject({ body: z.string().trim().min(1).max(65536) });
  const stateBody = z.strictObject({ kind: z.enum(["pr", "issue"]), state: z.enum(["open", "closed"]), reason: z.enum(["completed", "not_planned"]).optional() });
  const shaBody = z.strictObject({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
  const mergeBody = shaBody.extend({ method: z.enum(["merge", "squash", "rebase"]) });
  app.post("/v1/github/repos/:owner/:name/items/:number/comments", async c => {
    try { const b = await ghBody(c, commentBody); return await githubWrite(c, async () => c.json(await ghActions.comment(ghRepo(c), ghNumber(c), b.body))); }
    catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/items/:number/state", async c => {
    try { const b = await ghBody(c, stateBody); return await githubWrite(c, async () => c.json(await ghActions.setState(ghRepo(c), b.kind, ghNumber(c), b.state, b.reason))); }
    catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/pulls/:number/merge", async c => {
    try { const b = await ghBody(c, mergeBody); return await githubWrite(c, async () => c.json(await ghActions.merge(ghRepo(c), ghNumber(c), b.method, b.sha))); }
    catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/pulls/:number/delete-branch", async c => {
    try { const b = await ghBody(c, shaBody); return await githubWrite(c, async () => c.json(await ghActions.deleteBranch(ghRepo(c), ghNumber(c), b.sha))); }
    catch (e) { return ghFail(c, e); }
  });
  app.delete("/v1/github/repos/:owner/:name/issues/:number", async c => {
    try { const b = await ghBody(c, z.strictObject({ confirm: z.number().int().positive() })); return await githubWrite(c, async () => c.json(await ghActions.deleteIssue(ghRepo(c), ghNumber(c), b.confirm))); }
    catch (e) { return ghFail(c, e); }
  });
  const ghProjects = async (repo: string) => {
    if (!opts.conversations) throw new GhError("projects disabled", 404);
    const repos = await projectRepos(opts.conversations.projects.list());
    return repos.find(r => r.repo.toLowerCase() === repo.toLowerCase())?.projects ?? [];
  };
  app.get("/v1/github/repos/:owner/:name/items/:number/cards", async c => {
    try {
      const repo = ghRepo(c), n = ghNumber(c), kind = c.req.query("kind");
      if (kind !== "pr" && kind !== "issue") throw new GhError("kind must be pr or issue", 400);
      const projects = await ghProjects(repo), url = itemUrl(repo, kind, n);
      const cards = projects.flatMap(p => [false, true].flatMap(archived => opts.conversations!.board.list(p.id, { archived })
        .filter(card => linked(card.description, url)).map(card => ({ project: p.id, id: card.id, status: card.status, archived: card.archived }))));
      return c.json({ projects, cards });
    } catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/items/:number/card", async c => {
    try {
      const repo = ghRepo(c), n = ghNumber(c), b = await ghBody(c, z.strictObject({ project: z.number().int().positive() }));
      return await githubWrite(c, () => ghActions.withItemLock(repo, n, async () => {
        const projects = await ghProjects(repo);
        if (!projects.some(p => p.id === b.project)) throw new GhError("Project does not use this repository", 400);
        const d = await readDetail(repo, n), url = itemUrl(repo, d.kind, n), conv = opts.conversations!;
        // Deduplication and creation share the serialized harness transaction.
        const result = await write(conv, () => {
          const existing = [false, true].flatMap(archived => conv.board.list(b.project, { archived })).find(card => linked(card.description, url));
          return existing ? { card: existing, created: false } : { card: conv.board.create(b.project, cardInput(repo, d)), created: true };
        });
        return c.json(result.card, result.created ? 201 : 200);
      }));
    } catch (e) { return ghFail(c, e); }
  });


  app.get("/v1/sessions/:id/machine", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json({ machine: await machineOf(conv.id), cwd: (await conv.agent(context)).cwd ?? null });
  });

  // `@file:` completion. Lists the working directory of the session's machine; a typed directory part (`~/x/`, `/etc/`,
  // `../`) lists that directory on the same machine. Without a session, `worker`/`project`/`cwd` describe a draft chat.
  app.get("/v1/files", async (c) => {
    const q = c.req.query("q") ?? "";
    const sid = c.req.query("session");
    let worker: number | null, cwd: string | undefined;
    if (sid) {
      const conv = await getConv(sid);
      if (!conv) return err(c, 404, "no such session");
      worker = (await harness.snapshot(ExecTarget, conv.id, context).catch(() => undefined))?.worker ?? null;
      cwd = (await conv.agent(context)).cwd ?? undefined;
    } else {
      const w = c.req.query("worker");
      worker = w ? Number(w) : null;
      if (worker !== null && (!Number.isSafeInteger(worker) || !opts.workers?.store.get(worker))) return err(c, 400, "unknown worker");
      const project = Number(c.req.query("project"));
      const selectedProject = Number.isSafeInteger(project) ? opts.conversations?.projects.get(project) : undefined;
      const projectCwd = selectedProject ? opts.conversations?.projects.dirFor(project, worker) : undefined;
      if (selectedProject && !selectedProject.general && !projectCwd) return err(c, 400, "project is not linked to this machine");
      cwd = c.req.query("cwd") || projectCwd;
    }
    let env, home: string | undefined;
    if (worker !== null) {
      if (!opts.workers) return err(c, 404, "workers disabled");
      env = opts.workers.env(worker, cwd);
      home = opts.workers.store.get(worker)?.capabilities?.home;
    } else {
      env = new NodeExecutionEnv({ cwd: cwd ?? opts.cwd ?? process.cwd() });
      home = homedir();
    }
    const { entries, error } = await completeFiles(env, home, q, context);
    return c.json({ cwd: env.cwd, entries, ...(error ? { error } : {}) });
  });

  // Move an idle session to another machine. `worker: null` is this host. The cwd is a path on the target machine;
  // omitted, it becomes the worker's default directory (or the project directory on this host).
  app.put("/v1/sessions/:id/machine", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = await c.req.json().catch(() => null) as { worker?: unknown; cwd?: unknown } | null;
    if (!b || !("worker" in b)) return err(c, 400, "worker required (a worker id, or null for this host)");
    if (b.worker !== null && typeof b.worker !== "number") return err(c, 400, "worker must be a numeric id or null");
    const worker = b.worker as number | null;
    if (worker !== null && (!Number.isSafeInteger(worker) || !opts.workers?.store.get(worker))) return err(c, 400, "unknown worker");
    if (b.cwd !== undefined && b.cwd !== null && (typeof b.cwd !== "string" || !b.cwd.trim())) return err(c, 400, "cwd must be a non-empty string");
    const project = opts.conversations?.projects.projectOf(Number(conv.id));
    const projectCwd = project === undefined ? undefined : opts.conversations?.projects.dirFor(project, worker) || undefined;
    if (project !== undefined && project !== 0 && !projectCwd) return err(c, 400, "project is not linked to this machine");
    const cwd = (b.cwd as string | undefined)?.trim() || projectCwd || null;
    const moved = await serial(String(conv.id), () => harness.commit(async tx => {
      if (await isRunning(tx, conv.id)) return "busy";
      // Check retained OS work at the same boundary as task admission, not before this transaction.
      const owner = (await tx.doc(ProcessOwner, conv.id)).token;
      if (harness.busyTools?.sessionProcesses(conv.id, owner).some(p => p.running)) return "processes";
      (await tx.doc(ExecTarget, conv.id)).worker = worker;
      await configure(tx, conv.id, { cwd });
      await tx.appendEntry(conv.id, { kind: "luna.execution", data: { worker, cwd } });
      return "moved";
    }, context));
    if (moved === "busy") return err(c, 409, "Cannot move a session while it runs.");
    if (moved === "processes") return err(c, 409, "Stop or finish background processes before moving execution.");
    return c.json({ machine: await machineOf(conv.id), cwd });
  });

  // Change a session's model, thinking level or instructions. null resets a field to the default.
  app.patch("/v1/sessions/:id", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = await c.req.json().catch(() => ({})) as { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null; instructions?: string | null };
    if (await harness.commit(tx => isRunning(tx, conv.id), context)) return err(c, 409, "Cannot change the model or agent settings while busy.");
    if (b.model && opts.models && !opts.models.getModel(b.model.provider, b.model.modelId)) return err(c, 400, "unknown model");
    if (b.thinkingLevel && !THINKING_LEVELS.includes(b.thinkingLevel)) return err(c, 400, "invalid thinkingLevel");
    if (b.model !== undefined) await opts.limitContinuer?.cancel(Number(conv.id), "Session model changed.");
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

  const sessionTalkPolicy = () => opts.sessionTalk?.() ?? opts.settings?.resolved().sessionTalk ?? DEFAULT_SESSION_TALK;
  const exchangeTarget = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  app.get("/v1/sessions/:id/exchanges/:to", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const to = exchangeTarget.safeParse(c.req.param("to"));
    if (!to.success || to.data === Number(conv.id)) return err(c, 400, "invalid peer session");
    return c.json(await harness.commit(tx => readSessionExchange(tx, conv.id, to.data, sessionTalkPolicy()), context));
  });
  app.post("/v1/sessions/:id/exchanges/:to/extend", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const to = exchangeTarget.safeParse(c.req.param("to"));
    const body = z.strictObject({ anchor: z.string().min(1), maxHops: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
      .safeParse(await c.req.json().catch(() => null));
    if (!to.success || !body.success) return err(c, 400, "invalid exchange extension");
    const result = await harness.commit(tx => extendSessionExchange(tx, conv.id, to.data, body.data.anchor, body.data.maxHops, sessionTalkPolicy()), context);
    if ("error" in result) return err(c, 409, result.error!);
    // A distinct input kind preserves the exchange. Ordinary human input would reset its hop count.
    // Stable submission identity also covers a retry after a committed grant but failed HTTP delivery.
    await conv.submit({ type: "input", whenBusy: "followUp", requestId: result.requestId,
      content: `m57 allowed up to ${result.maxHops} messages in the current exchange with session #${to.data}. Retry the blocked session_send if this exchange is still current. This approval does not grant merge, publish, or delete permission.`,
      entry: { kind: XSESSION_APPROVED, data: { to: to.data, anchor: body.data.anchor, maxHops: result.maxHops } },
    }, context);
    return c.json(result);
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

  // Tasks parked by the crash-loop guard (restart_limit). Retry runs one again.
  app.get("/v1/tasks/parked", async (c) => {
    const { tasks } = await harness.inspect(context);
    return c.json({ tasks: tasks.filter(t => t.state.kind === "blocked" && t.state.reason === "restart_limit")
      .map(t => ({ id: t.record.id, kind: t.record.kind, conversationId: t.record.conversationId, restarts: t.record.restarts })) });
  });
  app.post("/v1/tasks/:id/retry", async (c) => {
    const id = Number(c.req.param("id"));
    const { tasks } = await harness.inspect(context);
    const t = tasks.find(x => Number(x.record.id) === id);
    if (!t || t.state.kind !== "blocked" || t.state.reason !== "restart_limit") return err(c, 404, "no such parked task");
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
  app.get("/v1/sessions/:id/entries/:entryId/media/:index", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const entryId = Number(c.req.param("entryId")), index = Number(c.req.param("index"));
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(index) || index < 0) return err(c, 404, "no such media");
    const entry = await harness.commit(tx => tx.entry(entryId as never), context).catch(() => undefined);
    if (!entry || String(entry.conversationId) !== String(conv.id)) return err(c, 404, "no such media");
    const directive = entryMedia(entry.model)[index];
    if (!directive) return err(c, 404, "no such media");
    // A transfer changes future execution only. Old answers keep their original machine and directory.
    const origin = await harness.commit(async tx => {
      let cursor;
      for (;;) {
        const page = await tx.scanEntries({ conversationId: conv.id, maxEntryId: entry.id, order: "descending" }, 100, cursor);
        const marker = page.items.find(e => e.kind === "luna.execution");
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
  app.get("/v1/sessions/:id/entries/:entryId/images/:index", async c => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const entryId = Number(c.req.param("entryId")), index = Number(c.req.param("index"));
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(index) || index < 0) return err(c, 404, "no such image");
    const page = await conv.entries({ minEntryId: entryId as never, maxEntryId: entryId as never }, 1, undefined, context).catch(() => undefined);
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
    const side = /^\/(btw|bg|review)(?:\s+([\s\S]*))?$/.exec(commandText.trim());
    if (side) {
      const kind = side[1] as "btw" | "bg" | "review", prompt = (side[2] ?? "").trim() || (kind === "review" ? REVIEW_DEFAULT_PROMPT : "");
      if (kind !== "bg" && Array.isArray(content) && content.some(block => block.type !== "text")) {
        return err(c, 400, "Send attachments in normal chat or /bg, not /btw or /review.");
      }
      if (!prompt) return err(c, 400, `Usage: /${kind} <${kind === "btw" ? "question" : "prompt"}>`);
      try {
        const job = await serial(String(conv.id), async () => {
          const prepared = await prepareAttachments(content as Input, conv, c.req.raw.signal);
          return sideCommands.start(conv, kind, prompt, prepared as SideInput, body.requestId);
        });
        return c.json({ command: true, job: jobView(job), notice: `/${kind} started: ${prompt.slice(0, 60)} [${job.id}]` }, 202);
      } catch (error) { return err(c, 400, (error as Error).message); }
    }
    if (draining.has(String(conv.id))) return c.json({ command: true, notice: "The current turn is stopping. Send the message again after it stops." }, 409);
    const plain = typeof content === "string" ? content : content.every(block => block.type === "text") ? content.map(block => block.type === "text" ? block.text : "").join("\n") : undefined;
    const slash = plain === undefined ? null : /^\/(usage|cost|queue|steer|redirect|stop|model|compress|compact|retry|undo)(?:\s+([\s\S]*))?$/.exec(plain.trim());
    let input = content as Input;
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
      const command = slash[1]!, args = (slash[2] ?? "").trim();
      if (command === "usage" || command === "cost") {
        if (args) return err(c, 400, `Usage: /${command}`);
        const usage = await harness.snapshot(UsageDoc, conv.id, context) ?? { models: {}, tools: {} };
        try {
          const report = await readClaudeUsage(c.req.raw.signal);
          return c.json({ command: true, notice: usageNotice(usage, report) });
        } catch (error) {
          // Keep recorded session totals usable when login, network, or CLI support is absent.
          return c.json({ command: true, notice: `${usageNotice(usage)}\n${(error as Error).message}` });
        }
      }
      if (command === "undo") {
        if (!/^[1-9]\d*$/.test(args) || !Number.isSafeInteger(Number(args))) return err(c, 400, "Usage: /undo <positive integer>");
        return c.json(await serial(String(conv.id), () => harness.commit(async tx => {
          if (draining.has(String(conv.id))) throw new BusyCommandError("The current turn is stopping. Try /undo after it stops.", 409);
          return undoCommand(tx, conv.id, Number(args), body.requestId);
        }, context)));
      }
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
      const prepared = await prepareAttachments(input, conv, c.req.raw.signal);
      await opts.limitContinuer?.cancel(Number(conv.id), "New input replaced automatic recovery.");
      const sub = await conv.submit({ type: "input", content: prepared, requestId: body.requestId, whenBusy }, context);
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
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(projectSnapshotImages(ev.snapshot, conv.id)) });
      ev.start(async (events) => {
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
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(projectSnapshotImages(ev.snapshot, conv.id)) });
        ev.start(async events => {
          try {
            for (const event of withSubmissions(events)) {
              const projected = projectAgentEvent(event, conv.id);
              await stream.writeSSE({ event: projected.type, data: JSON.stringify(projected) });
            }
          }
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
      if (publication.changes.some(change => change.type === "conversation" || change.type === "entry" || change.type === "task" || change.type === "submission" || change.type === "document" && ["luna.ask", "luna.goal", "luna.session-handoff", "luna.session-review", "luna.session-read", "luna.limit-waits"].includes(change.record.kind))) changed();
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
    const allowed = ["name", "expr", "prompt", "reportPolicy", "graceMs", "timeoutMs", "retries"];
    const keys = Object.keys(b);
    if (!keys.length || keys.some(k => !allowed.includes(k))) return err(c, 400, "invalid or unknown fields");
    if (!b.name || typeof b.name !== "string" || !b.name.trim() || !b.expr || typeof b.expr !== "string" || !b.prompt || typeof b.prompt !== "string" || !b.prompt.trim()) return err(c, 400, "name, expr and prompt required");
    if (b.reportPolicy !== undefined && !['always', 'changes', 'failures'].includes(b.reportPolicy)) return err(c, 400, "invalid report policy");
    if (opts.store!.listJobs().some((j) => j.name === b.name)) return err(c, 409, "a job with that name exists");
    try {
      const job = opts.store!.addJob(b.name, b.expr, b.prompt, undefined, Date.now(), b.reportPolicy, { graceMs: b.graceMs, timeoutMs: b.timeoutMs, retries: b.retries });
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
    const allowed = ["name", "expr", "prompt", "enabled", "reportPolicy", "graceMs", "timeoutMs", "retries"];
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
    if (status !== undefined && !["running", "ok", "error", "skipped"].includes(status)) return err(c, 400, "invalid status");
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

  // ---- Evidence-backed proposals: only the user-facing routes approve or verify changes. ----
  const lessonView = (l: ReturnType<LearnStore["lesson"]> & {}) => {
    const L = opts.learn!.store;
    return {
      ...l, needs_guard: !!l.needs_guard, tests: l.tests ? JSON.parse(l.tests) as string[] : [], sessions: L.sessions(l.id),
      current: L.changes(l.id).at(-1)?.before_text ?? null,
      changes: L.changes(l.id), assessments: L.assessments(l.id), observations: L.observations(l.id),
      currentMatches: L.currentMatches(l.id, opts.learn!.improver, opts.memory),
      effect: l.status === "confirmed" ? "legacy confirmation; behavioral effect unknown" : l.status === "verified" ? "user-verified observation" : "not verified",
      evidence: L.evidence(l.id).map((s) => ({ id: s.id, kind: s.kind, session: s.conv, message: s.entry, summary: s.summary, ts: s.ts, context: JSON.parse(s.context) })),
    };
  };
  const learnOff = (c: HonoContext) => opts.learn ? undefined : err(c, 404, "learning disabled");
  app.get("/v1/lessons", (c) => learnOff(c) ?? c.json({
    lessons: opts.learn!.store.lessons().map(lessonView),
    unassigned: opts.learn!.store.pendingCount(),
    projection: opts.learn!.store.projectionState(opts.memory), metrics: opts.learn!.store.metrics(),
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
  app.post("/v1/lessons/:id/rollback", lessonAction((id) => opts.learn!.store.rollback(id, opts.learn!.improver, opts.memory)));
  app.post("/v1/lessons/:id/reconcile", lessonAction((id) => opts.learn!.store.reconcile(id, opts.learn!.improver, opts.memory)));
  app.post("/v1/lessons/:id/verify", lessonAction((id, b) => {
    if (!Number.isSafeInteger(b.observation) || Number(b.observation) < 1) throw new Error("observation id required");
    if (opts.learn!.store.currentMatches(id, opts.learn!.improver, opts.memory) !== true) throw new Error("applied target changed; cannot verify this revision");
    return opts.learn!.store.verify(id, Number(b.observation));
  }));

  // ---- skills (read-only; the model edits them through skill_manage / skill_propose) ----
  app.get("/v1/skills", (c) => {
    if (!opts.skillDirs) return err(c, 404, "skills disabled");
    const off = opts.settings?.read().disabledSkills ?? [];
    return c.json({ skills: scanSkills(opts.skillDirs).map((s) => ({ name: s.name, description: s.description, tools: s.tools, path: s.path, disabled: off.includes(s.name) })) });
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
    await opts.limitContinuer?.cancel(Number(conv.id), "New input replaced automatic recovery.");
    const sub = await conv.submit({ type: "input", content: `[webhook from ${source}]\n${pretty}`, requestId: c.req.header("x-request-id") ?? undefined }, context);
    return c.json({ accepted: true, submissionId: sub.id }, 202); // fire-and-forget; poll GET /v1/submissions/:id
  });

  // Withdraw only this queued input before admitting its redirect replacement.
  app.post("/v1/sessions/:id/submissions/:submission/send-now", async (c) => {
    const sid = c.req.param("id"), submissionId = c.req.param("submission");
    const body = await c.req.json();
    {
      const sub = await harness.submission(submissionId as never, context);
      if (!sub) return err(c, 404, "no such submission");
      const record = await sub.status(context);
      if (String(record.conversationId) !== sid || record.type !== "input") return err(c, 404, "no such input submission");
      // Validate before withdrawing. The client keeps the content for safe retries.
      const content = parseInput(body.content);
      if (typeof content === "string" && (typeof body.content !== "string" || !content.trim())) return err(c, 400, "content required");
      if (Array.isArray(content) && content.some(block => block.type === "audio")) return err(c, 400, "Audio attachments require /bg.");
      if (record.status === "queued") {
        if (await sub.abort(context) !== "aborted") return err(c, 409, "Message is already being delivered.");
      } else if (record.status !== "unanswered" || record.reason !== "aborted" || record.entry !== undefined) {
        return err(c, 409, "Message is already being delivered.");
      }
      return send(c, sid, { content: body.content, requestId: `send-now:${submissionId}`, whenBusy: "redirect" }, true);
    }
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
