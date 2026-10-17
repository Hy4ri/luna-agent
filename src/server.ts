import { ProjectError } from "./projects.js";
import { BoardError } from "./board.js";
import { ConversationError, type ConversationStore, type ConversationMeta } from "./conversations.js";
// HTTP + SSE API over the durable Luna harness. Transport-only: all state lives in the harness (SQLite).
import { Hono, type Context as HonoContext } from "hono";
import { streamSSE } from "hono/streaming";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { UsageDoc, watchEvents, type Tx, type ConversationId } from "@earendil-works/pi-durable";
import { bodyLimit } from "hono/body-limit";
import { AskDoc, checkAnswer } from "./ask.js";
import { Children } from "./delegate.js";
import { GoalDoc } from "./goal.js";
import type { McpManager } from "./mcp.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderManager } from "./providers.js";
import { context, type MemoryStore } from "./luna.js";
import type { CronStore, Scheduler } from "./scheduler.js";
import { linkedFiles, scanSkills } from "./skills.js";
import { TodoDoc } from "./todo.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export interface ServerOptions {
  harness: Harness;
  settings?: SettingsStore;
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
}

type Input = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
/** Validate message content: a string, or text/image blocks (max 8 images, base64 data). */
function parseInput(v: unknown): Input | string {
  if (typeof v === "string") return v.trim() ? v : "content is empty";
  if (!Array.isArray(v) || !v.length) return "content (string or block array) required";
  let images = 0;
  for (const b of v) {
    if (b?.type === "text" && typeof b.text === "string") continue;
    if (b?.type === "image" && typeof b.data === "string" && IMAGE_MIME.test(b.mimeType) && /^[A-Za-z0-9+/=]+$/.test(b.data)) { images++; continue; }
    return "invalid content block (text, or image with png/jpeg/gif/webp base64 data)";
  }
  if (images > 8) return "at most 8 images per message";
  return v as Input;
}
const STATIC: Record<string, string> = { "/sync.js": "text/javascript", "/settings.js": "text/javascript", "/manifest.webmanifest": "application/manifest+json", "/icon.svg": "image/svg+xml" };

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function isRunning(tx: Tx, id: ConversationId) {
  for (const status of ["pending", "running", "waiting", "completing"] as const) {
    if ((await tx.scanTasks({ conversationId: id, status }, 1)).items.length) return true;
  }
  return false;
}

export function createApp(opts: ServerOptions) {
  const { harness } = opts;
  const app = new Hono();
  const started = Date.now();
  const err = (c: HonoContext, status: 400 | 401 | 404 | 409 | 500, message: string) => c.json({ error: message }, status);

  app.onError((e, c) => {
    if (e instanceof ConversationError || e instanceof ProjectError || e instanceof BoardError) return err(c, e.status, e.message);
    const name = (e as Error).name;
    if (name === "ConversationBusy") return err(c, 409, "conversation busy");
    return err(c, 500, (e as Error).message ?? String(e));
  });

  // ---- web UI + health (unauthenticated; the page holds no data, every /v1 call needs the token) ----
  const page = readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
  app.get("/", (c) => c.html(page, 200, { "cache-control": "no-cache", "x-frame-options": "DENY", "referrer-policy": "no-referrer" }));
  const swCode = stripTypeScriptTypes(readFileSync(new URL("./web/sw.ts", import.meta.url), "utf8"));
  app.get("/sw.js", (c) => c.body(swCode, 200, { "content-type": "text/javascript", "cache-control": "no-cache" }));
  for (const [path, type] of Object.entries(STATIC)) {
    const body = readFileSync(new URL("./web" + path, import.meta.url));
    app.get(path, (c) => c.body(body, 200, { "content-type": type, "cache-control": "no-cache" }));
  }
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
  app.get("/v1/sessions", async (c) => {
    // Title = first user message. Subagent children (delegate.child marker) are hidden from the list.
    const sessions = await harness.commit(async (tx) => {
      const links = opts.conversations?.projects.links();
      const out: ({ id: unknown; parent: unknown; project: number | null; title: string; archived: boolean; pinned: boolean; running: boolean })[] = [];
      let cursor;
      do {
        const page = await tx.scanConversations({ order: "descending" }, 100, cursor);
        for (const r of page.items) {
          const head = (await tx.scanEntries({ conversationId: r.id, order: "ascending" }, 30)).items;
          if (head.some((e) => e.kind === "delegate.child")) continue;
          const user = head.find((e) => e.kind === "pi.user");
          const meta = opts.conversations?.get(r.id) ?? { title: null, archived: false, pinned: false };
          const running = await isRunning(tx, r.id);
          out.push({ id: r.id, parent: r.parent ?? null, project: links?.get(r.id) ?? null, ...meta, title: meta.title ?? textOf(user).replace(/\s+/g, " ").slice(0, 60), running });
        }
        cursor = page.next;
      } while (cursor);
      return out.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    }, context);
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
    const running = await harness.commit(tx => isRunning(tx, conv.id), context);
    return c.json({
      id: conv.id,
      running,
      agent: { model: a.model ?? null, thinkingLevel: a.thinkingLevel, cwd: a.cwd ?? null, instructions: a.instructions ?? null, tools: a.tools.map((t) => t.name) },
      usage: usage ?? null,
      children: kids?.children ?? [],
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
    if (b.model && opts.models && !opts.models.getModel(b.model.provider, b.model.modelId)) return err(c, 400, "unknown model");
    if (b.thinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(b.thinkingLevel)) return err(c, 400, "invalid thinkingLevel");
    await conv.configure({
      ...(b.model !== undefined && { model: b.model }),
      ...(b.thinkingLevel !== undefined && { thinkingLevel: b.thinkingLevel as never }),
      ...(b.instructions !== undefined && { instructions: b.instructions || null }),
    }, context);
    return c.json({ ok: true });
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
    const task = await conv.compact(undefined, context);
    return c.json({ ok: true, taskId: task }, 202);
  });

  app.post("/v1/sessions/:id/abort", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    await conv.abort(context);
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

  // ---- messages ----
  // Non-streaming (default): waits for the answer and returns it.
  // Streaming (?stream=1 or Accept: text/event-stream): SSE of agent events until the submission settles.
  const send = async (c: HonoContext, sessionId: string, body: { content?: unknown; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" }, asyncMode = false) => {
    const conv = await getConv(sessionId);
    if (!conv) return err(c, 404, "no such session");
    const content = parseInput(body.content);
    if (typeof content === "string" && typeof body.content !== "string") return err(c, 400, content);
    if (typeof body.content === "string" && !body.content.trim()) return err(c, 400, "content (string) required");

    if (asyncMode) {
      const sub = await conv.submit({ type: "input", content: content as Input, requestId: body.requestId, whenBusy: body.whenBusy }, context);
      return c.json({ submissionId: sub.id }, 202);
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
      const sub = await conv.submit({ type: "input", content: content as Input, requestId: body.requestId, whenBusy: body.whenBusy }, context);
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
        const sub = await conv.submit({ type: "input", content: content as Input, requestId: body.requestId, whenBusy: body.whenBusy }, context);
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

  app.post("/v1/sessions/:id/messages", bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => err(c, 400, "message too large (32 MB max)") }), async (c) => {
    const asyncParam = c.req.query("async") === "1";
    return send(c, c.req.param("id"), await c.req.json().catch(() => ({})), asyncParam);
  });

  // Convenience: create-or-reuse session in one call. {message, sessionId?}
  app.post("/v1/chat", async (c) => {
    const b = await c.req.json().catch(() => ({})) as { message?: string; sessionId?: string; requestId?: string; whenBusy?: "steer" | "followUp" | "reject" };
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
      const ping = setInterval(() => { void stream.writeSSE({ event: "ping", data: "{}" }).catch(finish); }, 15000);
      try {
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(ev.snapshot) });
        ev.start(async events => {
          try { for (const event of events) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }); }
          catch { finish(); }
        });
        await Promise.race([done, ev.closed, harness.closed]);
      } finally { clearInterval(ping); await ev.stop(); }
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
      if (publication.changes.some(change => change.type === "conversation" || change.type === "entry" || change.type === "task" || change.type === "submission")) changed();
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
    return c.json({ default: cur, models: list });
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
  app.get("/v1/cron", (c) => cron(c) ?? c.json({ jobs: opts.store!.listJobs(), runs: opts.store!.runs(undefined, 50) }));
  app.post("/v1/cron", async (c) => {
    const no = cron(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as { name?: string; expr?: string; prompt?: string };
    if (!b.name || !b.expr || !b.prompt) return err(c, 400, "name, expr and prompt required");
    if (opts.store!.listJobs().some((j) => j.name === b.name)) return err(c, 409, "a job with that name exists");
    try { const job = opts.store!.addJob(b.name, b.expr, b.prompt); opts.scheduler?.rearm(); return c.json(job, 201); }
    catch (e) { return err(c, 400, (e as Error).message); }
  });
  app.patch("/v1/cron/:id", async (c) => {
    const no = cron(c); if (no) return no;
    const b = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    if (typeof b.enabled !== "boolean") return err(c, 400, "enabled (boolean) required");
    try { opts.store!.setEnabled(Number(c.req.param("id")), b.enabled); opts.scheduler?.rearm(); return c.json({ ok: true }); }
    catch (e) { return err(c, 404, (e as Error).message); }
  });
  app.post("/v1/cron/:id/run", (c) => {
    const no = cron(c); if (no) return no;
    if (!opts.scheduler) return err(c, 404, "scheduler disabled");
    try { return c.json(opts.scheduler.runNow(Number(c.req.param("id"))), 202); }
    catch (e) { return err(c, 404, (e as Error).message); }
  });
  app.delete("/v1/cron/:id", (c) => {
    const no = cron(c); if (no) return no;
    const id = Number(c.req.param("id"));
    if (!opts.store!.getJob(id)) return err(c, 404, "no such job");
    opts.store!.removeJob(id); opts.scheduler?.rearm();
    return c.json({ ok: true });
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

  // ---- skills (read-only; the model edits them through skill_propose) ----
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
