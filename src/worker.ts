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
import { WorkerServices } from "./worker-services.js";
import { ensureGeneratedDirectories, saveGeneratedImage, workerGeneratedRoot } from "./generated-files.js";
import { MAX_UPLOAD_BYTES, UploadStore, workerUploadRoot } from "./uploads.js";

export interface WorkerOptions {
  url: string; token: string; cwd?: string;
  log?: (message: string) => void;
  /** Called when main refuses the token. Default: stop reconnecting. */
  onUnauthorized?: () => void;
}

// Matches the image adapter's response byte ceiling. Buffer is also a Uint8Array.
const MAX_IMAGE_BYTES = 48 * 1024 * 1024;

function validateImageBytes(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Generated image must contain 1-${MAX_IMAGE_BYTES} bytes.`);
  }
  return bytes;
}

function validateUploadFile(file: unknown): { data: Uint8Array; name: string; mimeType: string } {
  if (!file || typeof file !== "object") throw new Error("Upload file must be an object.");
  const candidate = file as { data?: unknown; name?: unknown; mimeType?: unknown };
  if (!(candidate.data instanceof Uint8Array)) throw new Error("Upload data must be a Uint8Array.");
  if (candidate.data.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`Upload size ${candidate.data.byteLength} exceeds maximum allowed size ${MAX_UPLOAD_BYTES}.`);
  }
  if (typeof candidate.name !== "string" || !candidate.name.trim()) throw new Error("Upload name must be a non-empty string.");
  if (typeof candidate.mimeType !== "string" || !candidate.mimeType.trim()) throw new Error("Upload mimeType must be a non-empty string.");
  return {
    data: candidate.data,
    name: candidate.name,
    mimeType: candidate.mimeType,
  };
}

export function startWorker(o: WorkerOptions) {
  const log = o.log ?? ((m: string) => console.error(m));
  const cwd = o.cwd ?? homedir();
  const services = new WorkerServices();
  const workerHome = homedir();
  let generatedRootPath: string | undefined;
  try {
    const root = workerGeneratedRoot(workerHome, process.platform);
    ensureGeneratedDirectories(root);
    generatedRootPath = root;
  } catch (err) {
    log(`worker: failed to initialize generated directories under home: ${err instanceof Error ? err.message : String(err)}`);
    // Do not advertise generated storage or fall back to cwd/main after a startup failure.
  }

  let uploadStore: UploadStore | undefined;
  try {
    uploadStore = new UploadStore(workerUploadRoot(workerHome, process.platform));
  } catch (err) {
    log(`worker: failed to initialize upload store under home: ${err instanceof Error ? err.message : String(err)}`);
    // Do not advertise upload capability or fall back to cwd/main after a startup failure.
  }

  const capabilities: Capabilities = { hostname: hostname(), platform: process.platform, arch: process.arch, node: process.version,
    user: userInfo().username, home: workerHome, cwd, path: process.env.PATH, browser: services.browserCapability(),
    generatedFiles: generatedRootPath !== undefined,
    uploadFiles: uploadStore !== undefined };
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
          const provider = await services.browser();
          const req = (decode(m.args) as unknown[])[0] as never;
          const signal = controller.signal;
          const value = await ({
            open: () => provider.open(req, signal), navigate: () => provider.navigate(req, signal), close: () => provider.close(req, signal),
            snapshot: () => provider.snapshot(req, signal), click: () => provider.click(req, signal), type: () => provider.type(req, signal),
            scroll: () => provider.scroll(req, signal), screenshot: () => provider.screenshot(req, signal),
          } satisfies Record<BrowserMethod, () => Promise<unknown>>)[m.method]();
          result = { ok: true, value };
        } else if (m.t === "mcpList") {
          result = { ok: true, value: await services.mcpList() };
        } else if (m.t === "mcpCall") {
          result = { ok: true, value: await services.mcpCall(m.server, m.tool, decode(m.args) as Record<string, unknown>, controller.signal) };
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
          } else if (m.method === "writeGeneratedImage") {
            try {
              if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
              const bytes = validateImageBytes(args[0]);
              if (!generatedRootPath) throw new Error("Generated image storage is unavailable on this worker.");
              const path = await saveGeneratedImage(generatedRootPath, bytes, controller.signal);
              result = { ok: true, value: path };
            } catch (error) {
              if (controller.signal.aborted) throw error;
              result = { ok: false, error: new FileError("invalid", error instanceof Error ? error.message : String(error)) };
            }
          } else if (m.method === "writeUpload") {
            try {
              if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted");
              if (!uploadStore) throw new Error("Upload storage is unavailable on this worker.");
              const file = validateUploadFile(args[0]);
              const metadata = uploadStore.put(file);
              result = { ok: true, value: metadata };
            } catch (error) {
              if (controller.signal.aborted) throw error;
              result = { ok: false, error: new FileError("invalid", error instanceof Error ? error.message : String(error)) };
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
    async close() { stopped = true; clearTimeout(retry); await release(); socket?.close(); await services.close(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.LUNA_URL, token = process.env.LUNA_WORKER_TOKEN;
  if (!url || !token) { console.error("LUNA_URL and LUNA_WORKER_TOKEN are required"); process.exit(1); }
  const worker = startWorker({ url, token, cwd: process.env.LUNA_WORKER_CWD, onUnauthorized: () => process.exit(1) });
  const stop = () => { void worker.close().finally(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
