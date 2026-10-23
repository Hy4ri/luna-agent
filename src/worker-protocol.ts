// Wire format between the main daemon and an execution worker. JSON text frames over one WebSocket.
// Main sends calls; the worker runs them on its own ExecutionEnv and sends output chunks and one result per call.
import { ExecutionError, FileError, type Result } from "@earendil-works/pi-durable/env";

/** Env id prefix of RemoteExecutionEnv. Local envs (pi-durable "node:local") never match. */
export const WORKER_ENV_PREFIX = "luna-worker:";
/** True only for a session env that runs on an execution worker. */
export const isWorkerEnv = (env: { id: string } | undefined): boolean => !!env && env.id.startsWith(WORKER_ENV_PREFIX);

export const PROTOCOL_VERSION = 1;

/** Worker-only operation: open once, check the policy on the opened file, read from it. Not an ExecutionEnv method. */
export interface ConfinedReader {
  readConfined(path: string, policy: import("./confined-read.js").ConfinedReadPolicy, context: import("@earendil-works/chord").Context): Promise<Result<Uint8Array, Error>>;
}
export const confinedReader = (env: unknown): ConfinedReader | undefined =>
  isWorkerEnv(env as { id: string }) && typeof (env as Partial<ConfinedReader>).readConfined === "function" ? env as ConfinedReader : undefined;
export const CONNECT_PATH = "/v1/workers/connect";

/** ExecutionEnv methods a worker serves. Anything else is refused on both sides. */
export const ENV_METHODS = [
  "absolutePath", "joinPath", "readTextFile", "readTextLines", "readBinaryFile", "writeFile", "appendFile", "truncateFile",
  "flushFile", "renameFile", "fileInfo", "listDir", "listFiles", "canonicalPath", "exists", "createDir", "remove",
  "createTempDir", "createTempFile", "exec", "openBinaryReader", "openTextLineReader", "openDirReader",
  "readConfined",
] as const;
export type EnvMethod = typeof ENV_METHODS[number];
/** Methods that return a reader object; the worker keeps it and main gets a handle. */
export const HANDLE_METHODS = new Set<EnvMethod>(["openBinaryReader", "openTextLineReader", "openDirReader"]);
export const HANDLE_OPS = new Set(["info", "read", "scanLines", "readLine", "next", "close"]);

export interface Capabilities { hostname: string; platform: string; arch: string; node: string; user: string; home: string; cwd: string; path?: string }

export type MainMessage =
  | { t: "welcome"; protocol: number; workerId: number; name: string }
  | { t: "call"; id: number; cwd: string; method: EnvMethod; args: unknown[] }
  | { t: "handle"; id: number; handle: number; op: string; args: unknown[] }
  | { t: "abort"; id: number };
export type WorkerMessage =
  | { t: "hello"; protocol: number; capabilities: Capabilities }
  | { t: "output"; id: number; text: string; info: unknown }
  | { t: "result"; id: number; result: unknown };

// Binary payloads (file contents, positional reads) travel as base64.
export function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.$undefined === true && Object.keys(o).length === 1) return undefined;
    if (typeof o.$b64 === "string" && Object.keys(o).length === 1) return new Uint8Array(Buffer.from(o.$b64, "base64"));
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

type WireError = { kind: "file" | "exec"; code: string; message: string; path?: string; spillPath?: string };
export function encodeResult(result: Result<unknown, Error>): unknown {
  if (result.ok) return { ok: true, value: encode(result.value) };
  const e = result.error as Error & { code?: string; path?: string; spillPath?: string };
  const error: WireError = { kind: e instanceof ExecutionError ? "exec" : "file", code: e.code ?? "unknown", message: e.message,
    ...(e.path !== undefined && { path: e.path }), ...(e.spillPath !== undefined && { spillPath: e.spillPath }) };
  return { ok: false, error };
}
export function decodeResult(raw: unknown): Result<unknown, Error> {
  if (!raw || typeof raw !== "object" || typeof (raw as { ok?: unknown }).ok !== "boolean") throw new Error("Invalid worker result");
  const r = raw as { ok: boolean; value?: unknown; error?: WireError };
  if (!r.ok && (!r.error || !["file", "exec"].includes(r.error.kind) || typeof r.error.message !== "string" || typeof r.error.code !== "string")) throw new Error("Invalid worker error");
  if (r.ok) return { ok: true, value: decode(r.value) };
  const w = r.error!;
  if (w.kind === "exec") {
    const e = new ExecutionError(w.code as never, w.message);
    if (w.spillPath !== undefined) e.spillPath = w.spillPath;
    return { ok: false, error: e };
  }
  return { ok: false, error: new FileError(w.code as never, w.message, w.path) };
}
