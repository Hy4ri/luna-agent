// Execution workers: other machines that run a session's file and shell tools.
// The main daemon keeps the agent loop, store, and every other tool. A worker dials in over WebSocket with its own token.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, type WebSocket } from "ws";
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, section, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { ExecutionError, FileError, type ExecutionEnv, type Result, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { CONNECT_PATH, PROTOCOL_VERSION, decodeResult, encode,
  type BrowserMethod, type Capabilities, WORKER_ENV_PREFIX, type EnvMethod, type MainMessage, type WorkerMessage } from "./worker-protocol.js";

/** Where a session's file and shell tools run. `worker: null` is the main host. Forks keep their source's machine. */
export const ExecTarget = defineDoc<{ worker: number | null }>({
  checkpointWhen: () => false,
  kind: "luna.exec-target", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ worker: null }),
});

export interface WorkerRow { id: number; name: string; createdAt: number; lastSeenAt: number | null; capabilities: Capabilities | null }
export class WorkerError extends Error { constructor(public status: 400 | 404 | 409, message: string) { super(message); } }

const hash = (token: string) => createHash("sha256").update(token).digest();

/** Registered workers. Tokens are stored only as SHA-256 hashes; the plain token is shown once at creation. */
export class WorkerStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS luna_workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, token_hash BLOB NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, capabilities TEXT)`);
  }
  private row(r: Record<string, unknown>): WorkerRow {
    return { id: Number(r.id), name: String(r.name), createdAt: Number(r.created_at), lastSeenAt: r.last_seen_at == null ? null : Number(r.last_seen_at),
      capabilities: typeof r.capabilities === "string" ? JSON.parse(r.capabilities) as Capabilities : null };
  }
  list(): WorkerRow[] { return (this.db.prepare("SELECT * FROM luna_workers ORDER BY name COLLATE NOCASE").all() as Record<string, unknown>[]).map(r => this.row(r)); }
  get(id: number): WorkerRow | undefined { const r = this.db.prepare("SELECT * FROM luna_workers WHERE id=?").get(id) as Record<string, unknown> | undefined; return r && this.row(r); }
  create(name: unknown): { worker: WorkerRow; token: string } {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name.trim())) throw new WorkerError(400, "name must be 1-40 letters, digits, space, dot, dash or underscore");
    if (name.trim().toLowerCase() === "main") throw new WorkerError(400, "\"main\" is reserved for this host");
    if (this.db.prepare("SELECT 1 FROM luna_workers WHERE name=? COLLATE NOCASE").get(name.trim())) throw new WorkerError(409, "a worker with this name exists");
    const token = `lw_${randomBytes(32).toString("base64url")}`;
    const r = this.db.prepare("INSERT INTO luna_workers(name, token_hash, created_at) VALUES (?,?,?)").run(name.trim(), hash(token), Date.now());
    return { worker: this.get(Number(r.lastInsertRowid))!, token };
  }
  remove(id: number) { return this.db.prepare("DELETE FROM luna_workers WHERE id=?").run(id).changes > 0; }
  /** Constant-time token check over every row. */
  authenticate(token: string): WorkerRow | undefined {
    const h = hash(token);
    for (const r of this.db.prepare("SELECT id, token_hash FROM luna_workers").all() as { id: number; token_hash: Uint8Array }[])
      if (r.token_hash.length === h.length && timingSafeEqual(Buffer.from(r.token_hash), h)) return this.get(Number(r.id));
    return undefined;
  }
  seen(id: number, capabilities?: Capabilities) {
    if (capabilities) this.db.prepare("UPDATE luna_workers SET last_seen_at=?, capabilities=? WHERE id=?").run(Date.now(), JSON.stringify(capabilities), id);
    else this.db.prepare("UPDATE luna_workers SET last_seen_at=? WHERE id=?").run(Date.now(), id);
  }
  close() { this.db.close(); }
}

type Pending = { method: EnvMethod | "handle" | "browser" | "mcp"; resolve: (r: Result<unknown, Error>) => void; onOutput?: ShellExecOptions["onOutput"]; context: Context };
const failure = (method: EnvMethod | "handle" | "browser" | "mcp", code: string, message: string): Result<never, Error> =>
  ({ ok: false, error: method === "exec" ? new ExecutionError(code as never, message) : new FileError(code as never, message) });

class Link {
  private pending = new Map<number, Pending>();
  private next = 1;
  private beat: ReturnType<typeof setInterval>;
  private alive = true;
  readonly connectedAt = Date.now();
  constructor(readonly worker: WorkerRow, readonly ws: WebSocket, readonly capabilities: Capabilities, private log: (m: string) => void) {
    ws.on("pong", () => { this.alive = true; });
    this.beat = setInterval(() => {
      if (!this.alive) { ws.terminate(); return; }
      this.alive = false; ws.ping();
    }, 15_000);
    this.beat.unref();
    ws.on("message", raw => {
      let m: WorkerMessage;
      try { m = JSON.parse(String(raw)) as WorkerMessage; } catch { return; }
      if (!m || typeof m !== "object") return;
      const p = "id" in m ? this.pending.get(m.id) : undefined;
      if (!p || !("id" in m)) return;
      try {
        if (m.t === "output") {
          if (typeof m.text !== "string" || !m.info || !["stdout", "stderr"].includes((m.info as { stream: string }).stream)) throw new Error("invalid output frame");
          p.onOutput?.(m.text, p.context, m.info as never);
        } else if (m.t === "result") {
          const result = decodeResult(m.result);
          this.pending.delete(m.id); p.resolve(result);
        }
      } catch {
        this.pending.delete(m.id);
        p.resolve(failure(p.method, "unknown", "Invalid worker response. The operation was not retried."));
        this.ws.close(4000, "invalid response");
      }
    });
  }
  call(method: EnvMethod | "handle" | "browser" | "mcp", message: (id: number) => MainMessage, context: Context, onOutput?: ShellExecOptions["onOutput"]): Promise<Result<unknown, Error>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return Promise.resolve(failure(method, "aborted", "aborted"));
    const id = this.next++;
    return new Promise(resolve => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.send({ t: "abort", id });
        resolve(failure(method, "aborted", "aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { method, context, onOutput, resolve: r => { signal?.removeEventListener("abort", abort); resolve(r); } });
      this.send(message(id));
    });
  }
  send(m: MainMessage) { this.ws.send(JSON.stringify(m)); }
  /** The link is gone. Fail in-flight calls; never rerun them on another machine. */
  drop(reason: string) {
    clearInterval(this.beat);
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve(failure(p.method, "unknown", `${reason} ${p.method === "exec" ? "The command was not rerun. Its state on the worker is unknown; check before you repeat it." : "The operation was not retried."}`));
    }
    this.log(`worker ${this.worker.name}: ${reason}`);
  }
}

export interface WorkerView extends WorkerRow { online: boolean; connectedAt: number | null }

/** Accepts worker links and builds remote execution environments for sessions. */
export class WorkerHub {
  private links = new Map<number, Link>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  private connectListeners = new Set<(id: number) => void>();
  private removeListeners = new Set<(id: number) => void>();
  constructor(readonly store: WorkerStore, private log: (m: string) => void = m => console.error(m)) {}
  onRemove(fn: (id: number) => void) { this.removeListeners.add(fn); return () => this.removeListeners.delete(fn); }
  onConnect(fn: (id: number) => void) { this.connectListeners.add(fn); return () => this.connectListeners.delete(fn); }

  /** Handle `GET /v1/workers/connect` upgrades on the daemon's HTTP server. Other upgrades are left alone. */
  attach(server: Pick<Server, "on">) { server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head)); }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (new URL(req.url ?? "/", "http://x").pathname !== CONNECT_PATH) return;
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const worker = m ? this.store.authenticate(m[1]!) : undefined;
    if (!worker) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    this.wss.handleUpgrade(req, socket, head, ws => this.accept(worker, ws));
  }
  private accept(worker: WorkerRow, ws: WebSocket) {
    ws.on("error", error => this.log(`worker ${worker.name}: socket error: ${error.message}`));
    const timer = setTimeout(() => ws.close(4000, "hello timeout"), 10_000);
    ws.once("close", () => clearTimeout(timer));
    ws.once("message", raw => {
      clearTimeout(timer);
      let hello: WorkerMessage;
      try { hello = JSON.parse(String(raw)) as WorkerMessage; } catch { ws.close(4000, "bad hello"); return; }
      if (!hello || hello.t !== "hello" || hello.protocol !== PROTOCOL_VERSION) { ws.close(4000, `protocol ${PROTOCOL_VERSION} required`); return; }
      if (!hello.capabilities || ["hostname", "platform", "arch", "node", "user", "home", "cwd"].some(k =>
        typeof (hello.capabilities as unknown as Record<string, unknown>)[k] !== "string")) {
        ws.close(4000, "invalid capabilities"); return;
      }
      const browser = hello.capabilities.browser;
      if (browser !== undefined && (!browser || typeof browser !== "object" ||
        !["disabled", "chromium", "camofox", "moli"].includes(browser.provider) || typeof browser.configured !== "boolean" ||
        (browser.reason !== undefined && typeof browser.reason !== "string"))) {
        ws.close(4000, "invalid browser capability"); return;
      }
      if (!this.store.get(worker.id)) { ws.close(4001, "worker removed"); return; }
      // Never let a second process take over a live execution machine. Heartbeats remove a stale link first.
      if (this.links.has(worker.id)) { ws.close(4009, "worker already connected"); return; }
      const link = new Link(worker, ws, hello.capabilities, this.log);
      this.links.set(worker.id, link);
      this.store.seen(worker.id, hello.capabilities);
      link.send({ t: "welcome", protocol: PROTOCOL_VERSION, workerId: worker.id, name: worker.name });
      this.log(`worker ${worker.name}: connected from ${hello.capabilities.hostname} (${hello.capabilities.platform}/${hello.capabilities.arch})`);
      for (const fn of this.connectListeners) try { fn(worker.id); } catch {}
      ws.on("close", () => {
        if (this.links.get(worker.id) === link) { this.links.delete(worker.id); this.store.seen(worker.id); }
        link.drop(`Worker "${worker.name}" disconnected.`);
      });
    });
  }
  list(): WorkerView[] {
    return this.store.list().map(w => { const l = this.links.get(w.id); return { ...w, online: !!l, connectedAt: l?.connectedAt ?? null }; });
  }
  view(id: number): WorkerView | undefined { return this.list().find(w => w.id === id); }
  remove(id: number) {
    const ok = this.store.remove(id);
    const l = this.links.get(id);
    if (l) { this.links.delete(id); l.drop("Worker was removed."); l.ws.close(4001, "worker removed"); }
    if (ok) for (const fn of this.removeListeners) try { fn(id); } catch {}
    return ok;
  }
  /** Environment for one session on one worker. `cwd` undefined: the worker's own default directory. */
  env(workerId: number, cwd: string | undefined): ExecutionEnv {
    // Typed loosely on the wire; the worker runs a real NodeExecutionEnv, so values keep its contract.
    return new RemoteExecutionEnv(this, workerId, cwd) as unknown as ExecutionEnv;
  }

  call(workerId: number, method: EnvMethod, cwd: string, args: unknown[], context: Context, onOutput?: ShellExecOptions["onOutput"]) {
    const link = this.links.get(workerId);
    if (!link) return Promise.resolve(failure(method, "unknown", this.offline(workerId)));
    return link.call(method, id => ({ t: "call", id, cwd, method, args: encode(args) as unknown[] }), context, onOutput);
  }
  handle(workerId: number, handle: number, op: string, args: unknown[], context: Context) {
    const link = this.links.get(workerId);
    if (!link) return Promise.resolve(failure("handle", "unknown", this.offline(workerId)));
    return link.call("handle", id => ({ t: "handle", id, handle, op, args: encode(args) as unknown[] }), context);
  }
  browserCall(workerId: number, method: BrowserMethod, args: unknown[], context: Context): Promise<Result<unknown, Error>> {
    const link = this.links.get(workerId);
    if (!link) return Promise.resolve(failure("browser", "unknown", this.offline(workerId)));
    return link.call("browser", id => ({ t: "browser", id, method, args: encode(args) as unknown[] }), context);
  }
  mcpList(workerId: number, context: Context): Promise<Result<unknown, Error>> {
    const link = this.links.get(workerId);
    if (!link) return Promise.resolve(failure("mcp", "unknown", this.offline(workerId)));
    return link.call("mcp", id => ({ t: "mcpList", id }), context);
  }
  mcpCall(workerId: number, server: string, tool: string, args: Record<string, unknown>, context: Context): Promise<Result<unknown, Error>> {
    const link = this.links.get(workerId);
    if (!link) return Promise.resolve(failure("mcp", "unknown", this.offline(workerId)));
    return link.call("mcp", id => ({ t: "mcpCall", id, server, tool, args: encode(args) as Record<string, unknown> } as MainMessage), context);
  }
  connection(workerId: number) { return this.links.get(workerId); }
  /** Only the worker's executable search path and home may enter review commands. */
  reviewEnvironment(workerId: number): Record<string, string> {
    const capabilities = this.links.get(workerId)?.capabilities;
    if (!capabilities) throw new Error(this.offline(workerId));
    if (typeof capabilities.path !== "string" || !capabilities.path) {
      throw new Error("The worker command environment is unavailable. Reconnect an updated worker.");
    }
    return { PATH: capabilities.path, HOME: capabilities.home };
  }
  defaultCwd(workerId: number) { return this.links.get(workerId)?.capabilities.cwd ?? this.store.get(workerId)?.capabilities?.cwd; }
  private offline(workerId: number) {
    const w = this.store.get(workerId);
    return w ? `Execution machine "${w.name}" is offline. Nothing ran. Start its worker, or move this session to another machine.`
      : `Execution machine ${workerId} no longer exists. Nothing ran. Move this session to another machine.`;
  }
  close() {
    for (const l of this.links.values()) { l.drop("Main daemon is stopping."); l.ws.close(1001, "main stopping"); }
    this.links.clear();
    this.wss.close();
  }
}

const READER_OPS = ["info", "read", "scanLines", "readLine", "next", "close"] as const;

/** ExecutionEnv whose every call runs on a worker. Results and errors keep the local contract. */
class RemoteExecutionEnv {
  readonly id: string;
  private explicitCwd: string | undefined;
  constructor(private hub: WorkerHub, private workerId: number, cwd: string | undefined) { this.id = `${WORKER_ENV_PREFIX}${workerId}`; this.explicitCwd = cwd; }
  get cwd() { return this.explicitCwd ?? this.hub.defaultCwd(this.workerId) ?? ""; }
  set cwd(value: string) { this.explicitCwd = value; }
  private call(method: EnvMethod, args: unknown[], context: Context, onOutput?: ShellExecOptions["onOutput"]) {
    return this.hub.call(this.workerId, method, this.cwd, args, context, onOutput);
  }
  private async reader(method: EnvMethod, args: unknown[], context: Context) {
    const connection = this.hub.connection(this.workerId);
    const r = await this.call(method, args, context);
    if (!r.ok) return r;
    const handle = (r.value as { handle: number }).handle, hub = this.hub, workerId = this.workerId;
    const reader: Record<string, unknown> = {};
    for (const op of READER_OPS) reader[op] = async (...a: unknown[]) => {
      const ctx = a.pop() as Context;
      // A reader handle belongs to exactly one connection. A replacement worker may reuse its numeric id.
      if (hub.connection(workerId) !== connection) return op === "close" ? undefined : failure("handle", "unknown", "Reader connection was lost. Open the file again.");
      const res = await hub.handle(workerId, handle, op, a, op === "close" ? withoutAbortSignal(ctx) : ctx);
      return op === "close" ? undefined : res;
    };
    return { ok: true, value: reader };
  }
  readConfined(path: string, policy: import("./confined-read.js").ConfinedReadPolicy, c: Context) {
    return this.call("readConfined", [path, policy], c) as Promise<Result<Uint8Array, Error>>;
  }
  writeGeneratedImage(bytes: Uint8Array, c: Context) {
    return this.call("writeGeneratedImage", [bytes], c) as Promise<Result<string, Error>>;
  }
  writeUpload(file: { data: Uint8Array; name: string; mimeType: string }, c: Context) {
    return this.call("writeUpload", [file], c) as Promise<Result<import("./uploads.js").UploadMetadata, Error>>;
  }
  absolutePath(path: string, c: Context) { return this.call("absolutePath", [path], c); }
  joinPath(parts: string[], c: Context) { return this.call("joinPath", [parts], c); }
  readTextFile(path: string, c: Context) { return this.call("readTextFile", [path], c); }
  readTextLines(path: string, options: unknown, c: Context) { return this.call("readTextLines", [path, options], c); }
  readBinaryFile(path: string, c: Context) { return this.call("readBinaryFile", [path], c); }
  writeFile(path: string, content: unknown, c: Context) { return this.call("writeFile", [path, content], c); }
  appendFile(path: string, content: unknown, c: Context) { return this.call("appendFile", [path, content], c); }
  truncateFile(path: string, size: number, c: Context) { return this.call("truncateFile", [path, size], c); }
  flushFile(path: string, c: Context) { return this.call("flushFile", [path], c); }
  renameFile(a: string, b: string, c: Context) { return this.call("renameFile", [a, b], c); }
  fileInfo(path: string, c: Context) { return this.call("fileInfo", [path], c); }
  listDir(path: string, c: Context) { return this.call("listDir", [path], c); }
  listFiles(path: string, options: unknown, c: Context) { return this.call("listFiles", [path, options], c); }
  canonicalPath(path: string, c: Context) { return this.call("canonicalPath", [path], c); }
  exists(path: string, c: Context) { return this.call("exists", [path], c); }
  createDir(path: string, options: unknown, c: Context) { return this.call("createDir", [path, options], c); }
  remove(path: string, options: unknown, c: Context) { return this.call("remove", [path, options], c); }
  createTempDir(prefix: unknown, c: Context) { return this.call("createTempDir", [prefix], c); }
  createTempFile(options: unknown, c: Context) { return this.call("createTempFile", [options], c); }
  openBinaryReader(path: string, options: unknown, c: Context) { return this.reader("openBinaryReader", [path, options], c); }
  openTextLineReader(path: string, c: Context) { return this.reader("openTextLineReader", [path], c); }
  openDirReader(path: string, c: Context) { return this.reader("openDirReader", [path], c); }
  exec(command: string | readonly string[], options: ShellExecOptions | undefined, c: Context) {
    const { onOutput, ...wire } = options ?? {};
    return this.call("exec", [command, wire], c, onOutput);
  }
  async watch() { return failure("handle", "not_supported", "File watching is not available on execution workers."); }
  /** Commands stop on the worker when their call is aborted or the link drops. Nothing to do per session. */
  async cleanup() {}
}
export type { RemoteExecutionEnv };

/** Shows every model the same machine and effective cwd used by its file and shell tools. */
export function createWorkersExtension(hub: () => WorkerHub | undefined): Extension {
  return defineExtension({ name: "workers", sections: [section("machine", async ({ conversationId, read, env }, ctx) => {
    const target = await read.snapshot(ExecTarget, conversationId as ConversationId, ctx);
    const directory = env?.cwd;
    const workingDirectory = directory
      ? ` Current working directory for this session: ${JSON.stringify(directory)}. Relative file paths and shell commands start here.`
      : " The session's working directory is unavailable; do not assume a directory on another machine.";
    const peers = hub()?.store.list().length ? ' The read-only `machine_files` tool lists and reads files, and `machine_exec` runs shell commands, on "main" or any worker, whichever machine this session uses.' : "";
    const authority = peers + " This is the authoritative execution location for Luna tools, not any provider or Claude CLI transport directory.";
    if (!target?.worker) return `bash, read, write, edit, and process tools run on the main Luna host (hostname ${hostname()}).${workingDirectory}${authority}`;
    // Stable text: last known capabilities only, never online state, so the prompt cache survives reconnects.
    const w = hub()?.store.get(target.worker);
    if (!w) return `This session targets execution machine ${target.worker}, which no longer exists. bash, read, write, edit, and process tools fail until the session moves to another machine.`;
    const c = w.capabilities;
    return `bash, read, write, edit, and process tools run on execution machine "${w.name}"` +
      (c ? ` (hostname ${c.hostname}, ${c.platform}/${c.arch}, user ${c.user}, default directory ${c.cwd}).` : ".") +
      workingDirectory + authority +
      " All paths in those tools are paths on that machine." +
      " Browser tools and worker-specific MCP tools (w<id>_<server>__*) run on that worker; main MCP servers remain available." +
      (c?.browser ? c.browser.configured
        ? ` Browser provider: ${c.browser.provider}, configured on this worker; runtime availability is checked when called.`
        : ` Browser tools are unavailable: ${c.browser.reason ?? "not configured"} Do not call browser tools until the worker configuration changes and it reconnects.`
        : " Browser availability is unknown; this worker does not report browser capabilities.") +
      " Vision reads remote files through the worker link.";
  })] });
}
