import { ConversationError, type ConversationStore } from "./conversations.js";
// HTTP + SSE API over the durable Luna harness. Transport-only: all state lives in the harness (SQLite).
import { Hono, type Context as HonoContext } from "hono";
import { timingSafeEqual } from "node:crypto";
import { createWebApp } from "./web-assets.js";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { BusyCommandError, type BusyPolicy } from "./busy-input.js";
import { ProjectError } from "./projects.js";
import { BoardError } from "./board.js";
import type { McpManager } from "./mcp.js";
import type { SettingsStore } from "./settings.js";
import type { ProviderManager } from "./providers.js";
import { context, type MemoryStore } from "./luna.js";
import type { CronStore, Scheduler } from "./scheduler.js";
import { type WorkerHub } from "./workers.js";
import type { SessionTitler } from "./titles.js";
import type { ScheduledMessagesService } from "./scheduled-messages.js";
import { SideCommands } from "./side-commands.js";
import { UploadError, type UploadStore } from "./uploads.js";
import type { SessionTalkPolicy } from "./session-talk.js";
import { createRouteCtx } from "./routes/context.js";
import { registerUploads } from "./routes/uploads.js";
import { registerSettings } from "./routes/settings.js";
import { registerAnalytics } from "./routes/analytics.js";
import { registerWife } from "./routes/wife.js";
import { registerSessions } from "./routes/sessions.js";
import { registerSessionConfig } from "./routes/session-config.js";
import { registerSessionOps } from "./routes/session-ops.js";
import { registerHookReceiver, registerWebhooks } from "./routes/webhooks.js";
import { WebhookError, type Webhooks } from "./webhooks.js";
import { registerPush } from "./routes/push.js";
import { registerProjects } from "./routes/projects.js";
import { registerWorkers } from "./routes/workers.js";
import { registerGit } from "./routes/git.js";
import { registerTerminals } from "./routes/terminals.js";
import { registerBrowser } from "./routes/browser.js";
import { registerGithub } from "./routes/github.js";
import { registerMessages } from "./routes/messages.js";
import { registerScheduledMessages } from "./routes/scheduled-messages.js";
import { registerSubsystems } from "./routes/subsystems.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export interface ServerOptions {
  connection?: ReturnType<typeof import("./connection.js").daemonConnection>;
  harness: Harness;
  sideCommands?: SideCommands;
  /** Automatic and on-demand session titles. Absent: no title generation. */
  titler?: SessionTitler;
  /** Automatic continuation after usage limits (retired). */
  /** Durable one-shot scheduled messages. Absent: scheduled-message endpoints answer 404. */
  scheduledMessages?: ScheduledMessagesService;
  /** Registered Android push tokens. Absent: push is off and its endpoints answer 404. */
  push?: import("./push.js").DeviceStore;
  settings?: SettingsStore;
  /** Policy for a runtime without a file-backed settings store. */
  busyInput?: () => BusyPolicy;
  sessionTalk?: () => SessionTalkPolicy;
  conversations?: ConversationStore;
  /** Suggestion cards. Absent: the wife endpoints answer 404. */
  wife?: import("./wife/service.js").WifeService;
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
  /** Interactive user terminals. Absent: the terminal endpoints do not exist. */
  terminals?: import("./terminal/service.js").TerminalService;
  /** Live browser panel. Absent: the browser panel endpoints do not exist. */
  browserPanel?: import("./browser/panel.js").BrowserPanel;
  /** Persistent incoming files. Only paths and metadata enter durable conversation storage. */
  uploads?: UploadStore;
  /** Default working directory on this host, for `@file:` completion before a session exists. */
  cwd?: string;
  /** Webhooks in (POST /hooks/<slug>) and out (subscriptions). Absent: their endpoints answer 404. */
  webhooks?: Webhooks;
}

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

  const app = new Hono();
  const started = Date.now();
  const err = (c: HonoContext, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502 | 503 | 504, message: string) => c.json({ error: message }, status);

  app.onError((e, c) => {
    if (e instanceof BusyCommandError) return err(c, e.status, e.message);
    if (e instanceof ConversationError || e instanceof ProjectError || e instanceof BoardError || e instanceof UploadError || e instanceof WebhookError) return err(c, e.status, e.message);
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

  // ---- inbound webhooks (unauthenticated by the daemon token; every hook checks its own secret) ----
  registerHookReceiver(app, opts.webhooks);

  // ---- auth ----
  app.use("/v1/*", async (c, next) => {
    if (opts.token) {
      const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
      if (!m || !safeEq(m[1]!, opts.token)) return err(c, 401, "unauthorized");
    }
    await next();
  });

  app.get("/v1/connection", c => opts.connection ? c.json(opts.connection.info()) : c.json({ error: "Connection discovery unavailable" }, 404));

  const ctx = createRouteCtx(opts, err, sideCommands);

  registerUploads(app, ctx);
  registerSettings(app, ctx);
  registerAnalytics(app, ctx);
  registerWife(app, ctx);
  registerSessions(app, ctx);
  registerProjects(app, ctx);
  registerWorkers(app, ctx);
  registerGit(app, ctx);
  registerTerminals(app, ctx);
  registerBrowser(app, ctx);
  registerGithub(app, ctx);
  registerSessionConfig(app, ctx);
  registerSessionOps(app, ctx);
  registerMessages(app, ctx);
  registerScheduledMessages(app, ctx);
  registerSubsystems(app, ctx);
  registerWebhooks(app, ctx);
  registerPush(app, ctx);

  return app;
}
