// Luna execution worker: dials the main daemon over WebSocket and runs file and shell calls for sessions that target it.
// Usage: LUNA_URL=http://main:8787 LUNA_WORKER_TOKEN=lw_... [LUNA_WORKER_CWD=/home/me] pnpm run worker
// The worker keeps no session state. When the link drops, it stops every running command and drops open readers.
import { homedir, hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CONNECT_PATH, ENV_METHODS, HANDLE_METHODS, HANDLE_OPS, PROTOCOL_VERSION, decode, encodeResult,
  type Capabilities, type MainMessage, type WorkerMessage } from "./worker-protocol.js";

export interface WorkerOptions {
  url: string; token: string; cwd?: string;
  log?: (message: string) => void;
  /** Called when main refuses the token. Default: stop reconnecting. */
  onUnauthorized?: () => void;
}

export function startWorker(o: WorkerOptions) {
  const log = o.log ?? ((m: string) => console.error(m));
  const cwd = o.cwd ?? homedir();
  const capabilities: Capabilities = { hostname: hostname(), platform: process.platform, arch: process.arch, node: process.version,
    user: userInfo().username, home: homedir(), cwd };
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
      const controller = new AbortController();
      calls.set(m.id, controller);
      const ctx = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      try {
        let result: unknown;
        if (m.t === "call") {
          if (!(ENV_METHODS as readonly string[]).includes(m.method)) throw new Error(`unsupported method ${m.method}`);
          const env = envFor(m.cwd || cwd);
          const args = decode(m.args) as unknown[];
          if (m.method === "exec") {
            const options = { ...(args[1] as object | undefined), onOutput: (text: string, _c: unknown, info: unknown) => send({ t: "output", id: m.id, text, info }) };
            result = await env.exec(args[0] as string, options, ctx);
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
        } else return;
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
