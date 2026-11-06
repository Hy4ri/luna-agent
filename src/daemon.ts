// Luna HTTP/SSE daemon: loads LUNA_CONFIG (default ./luna.config.json), starts the full runtime and serves the API.
// Env overrides: LUNA_DATA, LUNA_CWD, LUNA_PROVIDER, LUNA_MODEL, LUNA_HOST, LUNA_PORT. Secret: LUNA_TOKEN.
import { serve } from "@hono/node-server";
import { bindRefusal, loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { daemonConnection } from "./connection.js";
import { createApp } from "./server.js";

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); }
const { host, port, publicUrls } = cfg.server;
const token = process.env.LUNA_TOKEN;
const refusal = bindRefusal(host, token);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

const rt = await startRuntime(cfg);
const appConnection = daemonConnection(cfg.dataDir, host, port, publicUrls);
const app = createApp({
  connection: appConnection,
  harness: rt.harness, sideCommands: rt.sideCommands, titler: rt.titler, limitContinuer: rt.limitContinuer, push: rt.push, token, agent: { model: rt.model },
  settings: rt.settings, busyInput: rt.busyInput, sessionTalk: rt.sessionTalk, conversations: rt.conversations, projectExtensions: rt.projectExtensions,
  models: rt.models, providers: rt.providers, store: rt.store, scheduler: rt.scheduler, memory: rt.memory, skillDirs: rt.skillDirs, mcp: rt.mcp,
  workers: rt.workers, terminals: rt.terminals, uploads: rt.uploads, cwd: cfg.cwd,
  ...(rt.learn ? { learn: { store: rt.learn, improver: rt.improver!, scan: rt.learnScan } } : {}),
});
const desktopOrigins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
rt.terminals.setOriginPolicy((origin, requestHost) => {
  try { return new URL(origin).host === requestHost || desktopOrigins.includes(origin) || appConnection.allowsOrigin(origin); } catch { return false; }
});
const server = serve({ fetch: app.fetch, hostname: host, port }, (i) =>
  console.log(`luna listening on http://${i.address}:${i.port} provider=${cfg.provider} data=${cfg.dataDir} extensions=${cfg.extensions.join(",")} mcp=${rt.mcp.connections.map((c) => c.name).join(",") || "none"} auth=${token ? "on" : "off"}`));

// Workers dial in on the same port; their WebSocket upgrade bypasses the HTTP routes and uses per-worker tokens.
rt.workers.attach(server as import("node:http").Server);
// Terminal sockets authenticate with a single-use ticket from an authenticated HTTP call.
rt.terminals.attach(server as import("node:http").Server);

let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  server.close();
  await rt.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
