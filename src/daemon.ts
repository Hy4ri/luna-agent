// Luna HTTP/SSE daemon: loads LUNA_CONFIG (default ~/.luna/luna.config.json), starts the full runtime and serves the API.
// Env overrides: LUNA_DATA, LUNA_CWD, LUNA_PROVIDER, LUNA_MODEL, LUNA_HOST, LUNA_PORT. Secret: LUNA_TOKEN.
import type { ServerWebSocket } from "bun";
import { bindRefusal, loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { daemonConnection } from "./connection.js";
import { createApp } from "./server.js";
import type { WorkerWsData } from "./workers.js";
import type { TerminalWsData } from "./terminal/service.js";
import type { BrowserWsData } from "./browser/panel.js";

type LunaWsData = WorkerWsData | TerminalWsData | BrowserWsData;

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); }
const { host, port, publicUrls } = cfg.server;
const token = process.env.LUNA_TOKEN;
// Tool commands inherit this process's environment. Keep the API token out of it.
delete process.env.LUNA_TOKEN;
const refusal = bindRefusal(host, token);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const rt = await startRuntime(cfg);
const appConnection = daemonConnection(cfg.dataDir, host, port, publicUrls);
const app = createApp({
  connection: appConnection,
  harness: rt.harness, sideCommands: rt.sideCommands, titler: rt.titler, scheduledMessages: rt.scheduledMessages, push: rt.push, token, agent: { model: rt.model },
  settings: rt.settings, busyInput: rt.busyInput, sessionTalk: rt.sessionTalk, conversations: rt.conversations, projectExtensions: rt.projectExtensions,
  models: rt.models, providers: rt.providers, store: rt.store, scheduler: rt.scheduler, memory: rt.memory, skillDirs: rt.skillDirs, mcp: rt.mcp,
  workers: rt.workers, terminals: rt.terminals, browserPanel: rt.browserPanel, uploads: rt.uploads, webhooks: rt.webhooks, cwd: cfg.cwd,
});
const desktopOrigins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
rt.terminals.setOriginPolicy((origin, requestHost) => {
  try { return new URL(origin).host === requestHost || desktopOrigins.includes(origin) || appConnection.allowsOrigin(origin); } catch { return false; }
});
rt.browserPanel.setOriginPolicy((origin, requestHost) => {
  try { return new URL(origin).host === requestHost || desktopOrigins.includes(origin) || appConnection.allowsOrigin(origin); } catch { return false; }
});
const server = Bun.serve<LunaWsData>({
  hostname: host,
  port,
  idleTimeout: 0,
  fetch(req, srv) {
    // Workers dial in on the same port; their WebSocket upgrade bypasses the HTTP routes and uses per-worker tokens.
    const w = rt.workers.tryUpgrade(req, srv);
    if (w !== undefined) return w ?? undefined;
    // Terminal sockets authenticate with a single-use ticket from an authenticated HTTP call.
    const t = rt.terminals.tryUpgrade(req, srv);
    if (t !== undefined) return t ?? undefined;
    const b = rt.browserPanel.tryUpgrade(req, srv);
    if (b !== undefined) return b ?? undefined;
    return app.fetch(req);
  },
  websocket: {
    maxPayloadLength: 256 * 1024 * 1024,
    open(ws: ServerWebSocket<LunaWsData>) {
      if (ws.data.kind === "worker") rt.workers.wsOpen(ws as ServerWebSocket<WorkerWsData>);
      else if (ws.data.kind === "terminal") rt.terminals.wsOpen(ws as ServerWebSocket<TerminalWsData>);
      else if (ws.data.kind === "browser") rt.browserPanel.wsOpen(ws as ServerWebSocket<BrowserWsData>);
    },
    message(ws: ServerWebSocket<LunaWsData>, message: string | Buffer) {
      if (ws.data.kind === "worker") rt.workers.wsMessage(ws as ServerWebSocket<WorkerWsData>, message);
      else if (ws.data.kind === "terminal") rt.terminals.wsMessage(ws as ServerWebSocket<TerminalWsData>, message);
      else if (ws.data.kind === "browser") rt.browserPanel.wsMessage(ws as ServerWebSocket<BrowserWsData>, message);
    },
    pong(ws: ServerWebSocket<LunaWsData>) {
      if (ws.data.kind === "worker") rt.workers.wsPong(ws as ServerWebSocket<WorkerWsData>);
    },
    close(ws: ServerWebSocket<LunaWsData>) {
      if (ws.data.kind === "worker") rt.workers.wsClose(ws as ServerWebSocket<WorkerWsData>);
      else if (ws.data.kind === "terminal") rt.terminals.wsClose(ws as ServerWebSocket<TerminalWsData>);
      else if (ws.data.kind === "browser") rt.browserPanel.wsClose(ws as ServerWebSocket<BrowserWsData>);
    },
  },
});
console.log(`luna listening on http://${server.hostname}:${server.port} provider=${cfg.provider} data=${cfg.dataDir} extensions=${cfg.extensions.join(",")} mcp=${rt.mcp.connections.map((c) => c.name).join(",") || "none"} auth=${token ? "on" : "off"}`);

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  await server.stop(true);
  await rt.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
