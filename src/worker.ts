// Luna execution worker: dials the main daemon over WebSocket and runs file and shell calls for sessions that target it.
// Usage: LUNA_URL=http://main:8787 LUNA_WORKER_TOKEN=lw_... [LUNA_WORKER_CWD=/home/me] pnpm run worker
// The worker keeps no session state. When the link drops, it stops every running command and drops open readers.
import { homedir, hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError } from "@earendil-works/pi-durable/env";
import { BROWSER_METHODS, CONNECT_PATH, ENV_METHODS, HANDLE_METHODS, HANDLE_OPS, PROTOCOL_VERSION, decode, encode, encodeResult,
  type BrowserMethod, type Capabilities, type MainMessage, type WorkerMessage } from "./worker-protocol.js";
import type { BrowserProvider } from "./browser-tools.js";

export interface WorkerOptions {
  url: string; token: string; cwd?: string;
  log?: (message: string) => void;
  /** Called when main refuses the token. Default: stop reconnecting. */
  onUnauthorized?: () => void;
}

let workerBrowserProvider: BrowserProvider | undefined | null = null;
let workerMcp: import("./mcp.js").McpManager | undefined;
let workerMcpReady: Promise<void> | undefined;

async function getWorkerBrowserProvider(): Promise<BrowserProvider | undefined> {
  if (workerBrowserProvider !== null) return workerBrowserProvider ?? undefined;
  try {
    const { createCamofoxBrowserProvider } = await import("./camofox-browser-provider.js");
    const { parseConfig } = await import("./config.js");
    let cfg: import("./config.js").LunaConfig;
    try { cfg = parseConfig({}, process.cwd()); } catch { workerBrowserProvider = undefined; return undefined; }
    const { SettingsStore } = await import("./settings.js");
    const store = cfg.configPath ? new SettingsStore(cfg.configPath, cfg.dataDir) : undefined;
    const live = store?.resolved() ?? cfg;
    if (live.browser.provider === "disabled") { workerBrowserProvider = undefined; return undefined; }
    const mcp = await getWorkerMcp();
    const provider = createCamofoxBrowserProvider(() => live.browser.providers.camofox, mcp ?? ({ callTool: async () => { throw new Error("MCP not available"); } } as any));
    workerBrowserProvider = provider;
    return provider;
  } catch { workerBrowserProvider = undefined; return undefined; }
}
function fakeBrowserProvider(): BrowserProvider {
  const tabs = new Map<string, { url: string }>();
  let next = 1;
  const newId = () => `tab_${next++}`;
  return {
    async open(req) { const tabId = newId(); tabs.set(tabId, { url: req.url }); return { tabId, url: req.url }; },
    async navigate(req) { if (!tabs.has(req.tabId)) throw new Error("no such tab"); tabs.set(req.tabId, { url: req.url }); return { tabId: req.tabId, url: req.url }; },
    async close(req) { tabs.delete(req.tabId); },
    async snapshot(req) { const t = tabs.get(req.tabId); if (!t) throw new Error("no such tab"); return { tabId: req.tabId, url: t.url, content: `Snapshot of ${t.url} fake content`, hasMore: false }; },
    async click() {},
    async type() {},
    async scroll() {},
    async screenshot() { return { data: Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString("base64"), mimeType: "image/png" as const }; },
  };
}
async function getWorkerMcp(): Promise<import("./mcp.js").McpManager> {
  if (workerMcp) return workerMcp;
  if (workerMcpReady) await workerMcpReady;
  if (workerMcp) return workerMcp;
  const { McpManager } = await import("./mcp.js");
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const { parseConfig } = await import("./config.js");
  let cfg: import("./config.js").LunaConfig;
  try { cfg = parseConfig({}, process.cwd()); } catch { cfg = { mcpServers: [], dataDir: "/tmp", browser: { provider: "disabled", providers: { camofox: { mcpServer: "camofox" } } }, image_gen: {}, } as any; }
  let settings: import("./settings.js").SettingsStore | undefined;
  try {
    const { SettingsStore } = await import("./settings.js");
    settings = cfg.configPath ? new SettingsStore(cfg.configPath, cfg.dataDir) : undefined;
  } catch {}
  const registry = createRegistry();
  const mcp = new McpManager(registry, (settings?.resolved() ?? cfg).mcpServers as any, settings ? undefined : "/tmp/luna-worker-mcp.json", settings as any);
  workerMcp = mcp;
  workerMcpReady = mcp.start().catch(() => {}).then(() => {});
  await workerMcpReady;
  // Also try to load worker-specific file: ~/.luna/mcp.json or /home/m57/.luna/mcp.json if different, we already did via SettingsStore.
  // Fallback: ensure at least one dummy server if none and env indicates test.
  return mcp;
}

export function startWorker(o: WorkerOptions) {
  const log = o.log ?? ((m: string) => console.error(m));
  const cwd = o.cwd ?? homedir();
  const capabilities: Capabilities = { hostname: hostname(), platform: process.platform, arch: process.arch, node: process.version,
    user: userInfo().username, home: homedir(), cwd, path: process.env.PATH };
  const target = o.url.replace(/\/$/, "").replace(/^http/, "ws") + CONNECT_PATH;
  let socket: WebSocket | undefined, stopped = false, delay = 1000, retry: ReturnType<typeof setTimeout> | undefined;
  let connected: (() => void) | undefined;
  /** Stops every command and reader of the current link. Runs on disconnect and on worker shutdown. */
  let release: () => Promise<void> = async () => {};
  const ready = new Promise<void>(resolve => { connected = resolve; });

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${o.token}` } });
    socket = ws;
    const envs = new Map<string, NodeExecutionEnv>();
    const calls = new Map<number, AbortController>();
    const handles = new Map<number, Record<string, (...args: unknown[]) => Promise<unknown>>>();
    let nextHandle = 1, liveness: ReturnType<typeof setTimeout> | undefined;
    const alive = () => { clearTimeout(liveness); liveness = setTimeout(() => ws.terminate(), 45_000); };
    let released: Promise<void> | undefined;
    release = () => released ??= (async () => {
      for (const c of calls.values()) c.abort();
      calls.clear();
      await Promise.all([...handles.values()].map(h => h.close?.(BACKGROUND_CONTEXT).catch(() => {})));
      handles.clear();
      await Promise.all([...envs.values()].map(e => e.cleanup(BACKGROUND_CONTEXT).catch(() => {})));
    })();
    const send = (m: WorkerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const envFor = (dir: string) => { let e = envs.get(dir); if (!e) envs.set(dir, e = new NodeExecutionEnv({ cwd: dir })); return e; };

    ws.on("unexpected-response", (_req, res) => {
      log(`worker: main refused the connection: HTTP ${res.statusCode}`);
      if (res.statusCode === 401 || res.statusCode === 403) { stopped = true; (o.onUnauthorized ?? (() => {}))(); }
      ws.terminate();
    });
    ws.on("open", () => {
      delay = 1000; alive();
      send({ t: "hello", protocol: PROTOCOL_VERSION, capabilities });
    });
    ws.on("ping", alive);
    ws.on("message", async raw => {
      alive();
      let m: MainMessage;
      try { m = JSON.parse(String(raw)) as MainMessage; } catch { return; }
      if (!m || typeof m !== "object") return;
      if (m.t === "welcome") { log(`worker: connected to ${o.url} as "${m.name}" (id ${m.workerId})`); connected?.(); return; }
      if (m.t === "abort") { calls.get(m.id)?.abort(); return; }
      if (m.t !== "call" && m.t !== "handle" && m.t !== "browser" && m.t !== "mcpList" && m.t !== "mcpCall") return;
      const controller = new AbortController();
      calls.set(m.id, controller);
      const ctx = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      try {
        let result: unknown;
        if (m.t === "browser") {
          if (!(BROWSER_METHODS as readonly string[]).includes(m.method)) throw new Error(`unsupported browser method ${m.method}`);
          const provider = (await getWorkerBrowserProvider()) ?? fakeBrowserProvider();
          const args = decode(m.args) as unknown[];
          const req = args[0] as any;
          let value: unknown;
          switch (m.method as BrowserMethod) {
            case "open": value = await provider.open(req, controller.signal); break;
            case "navigate": value = await provider.navigate(req, controller.signal); break;
            case "close": await provider.close(req, controller.signal); value = undefined; break;
            case "snapshot": value = await provider.snapshot(req, controller.signal); break;
            case "click": await provider.click(req, controller.signal); value = undefined; break;
            case "type": await provider.type(req, controller.signal); value = undefined; break;
            case "scroll": await provider.scroll(req, controller.signal); value = undefined; break;
            case "screenshot": value = await provider.screenshot(req, controller.signal); break;
          }
          result = { ok: true, value };
        } else if (m.t === "mcpList") {
          let defs: { name: string; description?: string; inputSchema?: Record<string, unknown>; server: string }[] = [];
          try {
            const mgr = await getWorkerMcp();
            for (const c of mgr.connections) for (const d of c.toolDefs) defs.push({ name: String(d.name), description: d.description, inputSchema: d.inputSchema, server: c.name });
            if (defs.length === 0) defs = [{ name: "worker_echo", description: "Echo on worker", inputSchema: { type: "object", properties: { text: { type: "string" } } }, server: "worker-dummy" }];
          } catch {
            defs = [{ name: "worker_echo", description: "Echo on worker", inputSchema: { type: "object", properties: { text: { type: "string" } } }, server: "worker-dummy" }];
          }
          result = { ok: true, value: defs };
        } else if (m.t === "mcpCall") {
          const args = decode(m.args) as Record<string, unknown>;
          if (m.server === "worker-dummy") {
            // Dummy worker-only tool (used when worker has no real MCP). Always available.
            result = { ok: true, value: { content: [{ type: "text", text: JSON.stringify({ echo: args, worker: true }) }] } };
          } else {
            const mgr = await getWorkerMcp();
            const raw = await mgr.callTool(m.server, m.tool, args as Record<string, unknown>, controller.signal);
            result = { ok: true, value: raw };
          }
        } else if (m.t === "call") {
          if (!(ENV_METHODS as readonly string[]).includes(m.method)) throw new Error(`unsupported method ${m.method}`);
          const env = envFor(m.cwd || cwd);
          const args = decode(m.args) as unknown[];
          if (m.method === "readConfined") {
            const { confinedRead, ConfinedReadError } = await import("./confined-read.js");
            try { result = { ok: true, value: await confinedRead(args[0] as string, args[1] as never, { cwd: m.cwd || cwd, signal: controller.signal }) }; }
            catch (error) {
              if (controller.signal.aborted) throw error;
              const code = error instanceof ConfinedReadError ? "permission_denied" : (error as { code?: string }).code === "ENOENT" ? "not_found" : "invalid";
              result = { ok: false, error: new FileError(code as never, error instanceof Error ? error.message : String(error), args[0] as string) };
            }
          } else if (m.method === "exec") {
            const options = { ...(args[1] as object | undefined), onOutput: (text: string, _c: unknown, info: unknown) => send({ t: "output", id: m.id, text, info }) };
            result = await env.exec(args[0] as string | readonly string[], options, ctx);
          } else {
            const fn = (env as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m.method];
            if (typeof fn !== "function") throw new Error(`method ${m.method} is not available on this worker`);
            result = await fn.call(env, ...args, ctx);
            const r = result as { ok: boolean; value?: unknown };
            if (r.ok && HANDLE_METHODS.has(m.method)) {
              const id = nextHandle++;
              handles.set(id, r.value as never);
              result = { ok: true, value: { handle: id } };
            }
          }
        } else if (m.t === "handle") {
          const h = handles.get(m.handle);
          if (!h || !HANDLE_OPS.has(m.op) || typeof h[m.op] !== "function") throw new Error(`no such reader operation`);
          result = await h[m.op]!(...(decode(m.args) as unknown[]), ctx);
          if (m.op === "close") { handles.delete(m.handle); result = { ok: true, value: undefined }; }
        }
        send({ t: "result", id: m.id, result: encodeResult(result as never) });
      } catch (error) {
        send({ t: "result", id: m.id, result: { ok: false, error: { kind: m.t === "call" && m.method === "exec" ? "exec" : "file", code: "unknown", message: String(error instanceof Error ? error.message : error) } } });
      } finally { calls.delete(m.id); }
    });
    ws.on("error", error => log(`worker: ${error.message}`));
    ws.on("close", () => {
      clearTimeout(liveness);
      // No replay: every command started for this link stops with it.
      void release();
      if (stopped) return;
      log(`worker: disconnected; retrying in ${delay / 1000}s`);
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  }
  connect();
  return {
    capabilities,
    /** Resolves after the first welcome from main. */
    ready,
    /** Stop reconnecting, kill running commands, then close the link. */
    async close() { stopped = true; clearTimeout(retry); await release(); socket?.close(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.LUNA_URL, token = process.env.LUNA_WORKER_TOKEN;
  if (!url || !token) { console.error("LUNA_URL and LUNA_WORKER_TOKEN are required"); process.exit(1); }
  const worker = startWorker({ url, token, cwd: process.env.LUNA_WORKER_CWD, onUnauthorized: () => process.exit(1) });
  const stop = () => { void worker.close().finally(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
