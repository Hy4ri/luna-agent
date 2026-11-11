// Luna execution worker: dials the main daemon over WebSocket and runs file and shell calls for sessions that target it.
// Usage: LUNA_URL=http://main:8787 LUNA_WORKER_TOKEN=lw_... [LUNA_WORKER_CWD=/home/me] bun run worker
// The worker keeps no session state. When the link drops, it stops every running command and drops open readers.
import { homedir, hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { defaultShell, programInvocation, shellEnvironment, spawnBunPty, type PtyProcess } from "./terminal/pty-host.js";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError } from "@earendil-works/pi-durable/env";
import { BROWSER_METHODS, CONNECT_PATH, ENV_METHODS, HANDLE_METHODS, HANDLE_OPS, maxFrameBytes, PROTOCOL_VERSION, decode, encodeResult,
  type Capabilities, type MainMessage, type WorkerMessage } from "./worker-protocol.js";
import { WorkerServices } from "./worker-services.js";
import { ensureGeneratedDirectories, saveGeneratedImage, workerGeneratedRoot } from "./generated-files.js";
import { MAX_UPLOAD_BYTES, UploadStore, workerUploadRoot } from "./uploads.js";

export interface WorkerOptions {
  url: string; token: string; cwd?: string;
  log?: (message: string) => void;
  /** Called when main refuses the token. Default: stop reconnecting. */
  onUnauthorized?: () => void;
  /** Close the link after this long without a message or server ping. Default 45 s. */
  livenessMs?: number;
  /** Close a link that has not opened and been welcomed within this time. Default 15 s. */
  handshakeMs?: number;
  /** First reconnect delay; it doubles up to 30 s and resets only after a link stays up for 30 s. Default 1 s. */
  retryMs?: number;
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
    uploadFiles: uploadStore !== undefined, pty: true, ptyCommand: true };
  const target = o.url.replace(/\/$/, "").replace(/^http/, "ws") + CONNECT_PATH;
  const baseDelay = o.retryMs ?? 1000;
  let socket: WebSocket | undefined, stopped = false, delay = baseDelay, retry: ReturnType<typeof setTimeout> | undefined;
  let connected: (() => void) | undefined;
  /** Stops every command and reader of the current link. Runs on disconnect and on worker shutdown. */
  let release: () => Promise<void> = async () => {};
  const ready = new Promise<void>(resolve => { connected = resolve; });

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${o.token}` } });
    ws.binaryType = "arraybuffer";
    socket = ws;
    const envs = new Map<string, NodeExecutionEnv>();
    const ptys = new Map<number, PtyProcess>();
    const calls = new Map<number, AbortController>();
    const handles = new Map<number, Record<string, (...args: unknown[]) => Promise<unknown>>>();
    let nextHandle = 1, liveness: ReturnType<typeof setTimeout> | undefined, welcomedAt: number | undefined;
    // A hung connect or a main that never welcomes would otherwise wait for liveness, or forever before open.
    const handshake = setTimeout(() => ws.close(), o.handshakeMs ?? 15_000);
    const alive = () => { clearTimeout(liveness); liveness = setTimeout(() => ws.close(), o.livenessMs ?? 45_000); };
    let released: Promise<void> | undefined;
    release = () => released ??= (async () => {
      for (const p of ptys.values()) try { p.kill(); } catch { /* already gone */ }
      ptys.clear();
      for (const c of calls.values()) c.abort();
      calls.clear();
      await Promise.all([...handles.values()].map(h => h.close?.(BACKGROUND_CONTEXT).catch(() => {})));
      handles.clear();
      await Promise.all([...envs.values()].map(e => e.cleanup(BACKGROUND_CONTEXT).catch(() => {})));
    })();
    const send = (m: WorkerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const envFor = (dir: string) => { let e = envs.get(dir); if (!e) envs.set(dir, e = new NodeExecutionEnv({ cwd: dir })); return e; };

    ws.addEventListener("open", () => {
      alive();
      send({ t: "hello", protocol: PROTOCOL_VERSION, capabilities });
    });
    // Server pings count as liveness; an idle link has no other traffic.
    ws.addEventListener("ping", alive);
    ws.addEventListener("message", async event => {
      const raw = event.data;
      alive();
      let m: MainMessage;
      try { m = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8")) as MainMessage; } catch { return; }
      if (!m || typeof m !== "object") return;
      if (m.t === "welcome") { clearTimeout(handshake); welcomedAt = performance.now(); log(`worker: connected to ${o.url} as "${m.name}" (id ${m.workerId})`); connected?.(); return; }
      if (m.t === "abort") { calls.get(m.id)?.abort(); return; }
      if (m.t === "pty.open") {
        try {
          const shell = defaultShell(process.env);
          const { file, args } = typeof m.command === "string" && m.command ? programInvocation(shell.file, m.command) : shell;
          const p = spawnBunPty({ file, args, cwd: m.cwd || cwd, env: shellEnvironment(process.env), cols: m.cols, rows: m.rows });
          ptys.set(m.id, p);
          p.onData(d => send({ t: "pty.output", id: m.id, data: d.toString("base64") }));
          p.onExit(e => { if (ptys.delete(m.id)) send({ t: "pty.exit", id: m.id, exitCode: e.exitCode, ...(e.signal ? { signal: e.signal } : {}) }); });
          send({ t: "pty.opened", id: m.id, shell: file.split("/").pop() || "sh" });
        } catch (error) { send({ t: "pty.error", id: m.id, message: error instanceof Error ? error.message : String(error) }); }
        return;
      }
      if (m.t === "pty.input") { ptys.get(m.id)?.write(Buffer.from(m.data, "base64")); return; }
      if (m.t === "pty.resize") { try { ptys.get(m.id)?.resize(m.cols, m.rows); } catch { /* exited */ } return; }
      if (m.t === "pty.kill") { const p = ptys.get(m.id); ptys.delete(m.id); try { p?.kill(); } catch { /* exited */ } return; }
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
          const fn = (provider as unknown as Record<string, ((r: never, s: AbortSignal) => Promise<unknown>) | undefined>)[m.method];
          if (typeof fn !== "function") throw new Error(`This browser provider cannot ${m.method}. Nothing ran. The chromium and moli providers can.`);
          const value = await fn.call(provider, req, signal);
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
        const frame = JSON.stringify({ t: "result", id: m.id, result: encodeResult(result as never) } satisfies WorkerMessage);
        if (frame.length > maxFrameBytes()) {
          // Fail this call only. An oversized frame would close the whole link and kill every other command.
          const kind = m.t === "call" && m.method === "exec" ? "exec" : "file";
          send({ t: "result", id: m.id, result: { ok: false, error: { kind, code: "unknown", message: `Result is ${frame.length} bytes, over the ${maxFrameBytes()} byte frame limit. Read it in smaller parts.` } } });
        } else if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      } catch (error) {
        send({ t: "result", id: m.id, result: { ok: false, error: { kind: m.t === "call" && m.method === "exec" ? "exec" : "file", code: "unknown", message: String(error instanceof Error ? error.message : error) } } });
      } finally { calls.delete(m.id); }
    });
    ws.addEventListener("error", event => {
      const msg = (event as ErrorEvent).message || "WebSocket error";
      log(`worker: ${msg}`);
      if (/status code:\s*(401|403)/.test(msg)) { stopped = true; (o.onUnauthorized ?? (() => {}))(); }
    });
    ws.addEventListener("close", () => {
      clearTimeout(liveness); clearTimeout(handshake);
      // No replay: every command started for this link stops with it.
      void release();
      if (stopped) return;
      // An accepted socket is not a healthy link. Reset the backoff only after a welcomed link stayed up.
      if (welcomedAt !== undefined && performance.now() - welcomedAt >= 30_000) delay = baseDelay;
      // Jitter spreads many workers reconnecting to a restarted main.
      const wait = Math.round(delay * (0.5 + Math.random() / 2));
      log(`worker: disconnected; retrying in ${(wait / 1000).toFixed(1)}s`);
      retry = setTimeout(connect, wait);
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
  // Commands run in this process's environment. The link token must not be readable from them.
  delete process.env.LUNA_WORKER_TOKEN; delete process.env.LUNA_TOKEN;
  const worker = startWorker({ url, token, cwd: process.env.LUNA_WORKER_CWD, onUnauthorized: () => process.exit(1) });
  const stop = () => { void worker.close().finally(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
