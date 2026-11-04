// Authenticated fetch helpers. A 401 calls the registered handlers (the shell shows login).
import { ref } from "vue";

export const token = ref(localStorage.getItem("luna.token") || "");
/** Daemon origin. Empty means same origin (the browser build). The desktop shell sets it in the login form. */
export const serverUrl = ref(localStorage.getItem("luna.server") || "");
let connectionGeneration = 0;
export const isDesktop = "__TAURI_INTERNALS__" in window;
export function setServerUrl(value: string) {
  // Accept "host:port" and bare hosts; default to http and the daemon port.
  let v = value.trim().replace(/\/+$/, "");
  const bare = !!v && !/^https?:\/\//i.test(v);
  if (bare) v = "http://" + v;
  if (bare && /^https?:\/\/[^/:]+$/i.test(v) && v.startsWith("http://")) v += ":8787";
  if (v !== serverUrl.value) connectionGeneration++;
  serverUrl.value = v;
  try { localStorage.setItem("luna.server", serverUrl.value); } catch {}
}
export const url = (path: string) => serverUrl.value + path;
export function setToken(value: string) {
  if (value !== token.value) connectionGeneration++;
  token.value = value;
  try { localStorage.setItem("luna.token", value); } catch {}
}
const handlers: ((reason: string) => void)[] = [];
export function onUnauthorized(fn: (reason: string) => void) { handlers.push(fn); }

export type HttpError = Error & { status?: number };

export interface ApiOptions extends RequestInit {
  /** Request deadline in milliseconds. Defaults to 15000. 0 disables the deadline (e.g. for long-lived SSE streams). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;

/** Abort `controller` when `signal` aborts. Returns a cleanup that removes the listener. */
function linkAbort(signal: AbortSignal | null | undefined, controller: AbortController): (() => void) | undefined {
  if (!signal) return undefined;
  if (signal.aborted) { controller.abort(signal.reason); return undefined; }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export async function api(path: string, opts: ApiOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...((opts.headers as Record<string, string>) || {}) };
  const currentToken = token.value;
  if (currentToken) headers.authorization = "Bearer " + currentToken;
  const generation = connectionGeneration;
  const origin = serverUrl.value;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { timeoutMs: _timeoutMs, signal: callerSignal, ...fetchInit } = opts;

  let r: Response;
  if (timeoutMs === 0) {
    // When timeoutMs is 0, use caller signal directly without creating an intermediate controller
    r = await fetch(origin + path, { ...fetchInit, headers, signal: callerSignal });
  } else {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const callerAbortCleanup = linkAbort(callerSignal, controller);

    timer = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);

    try {
      r = await fetch(origin + path, { ...fetchInit, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      callerAbortCleanup?.();
    }
  }

  if (generation !== connectionGeneration) throw new DOMException("Connection address changed", "AbortError");
  if (token.value !== currentToken) throw new DOMException("Authentication token changed", "AbortError");
  if (r.status === 401) { for (const fn of handlers) fn("token rejected"); throw new Error("unauthorized"); }
  return r;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function json<T = any>(path: string, opts?: ApiOptions): Promise<T> {
  const generation = connectionGeneration;
  const currentToken = token.value;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callerAbortCleanup = linkAbort(opts?.signal, controller);

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
  }

  const apiOpts: ApiOptions = {
    ...opts,
    signal: controller.signal,
    // Disable inner fetch deadline so controller.signal spans headers AND body stream
    timeoutMs: 0,
  };

  try {
    const r = await api(path, apiOpts);
    if (!r.ok) {
      const error = await r.json().catch(err => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
        return {};
      });
      if (generation !== connectionGeneration) throw new DOMException("Connection address changed", "AbortError");
      if (token.value !== currentToken) throw new DOMException("Authentication token changed", "AbortError");
      throw Object.assign(new Error(error.error || r.statusText), { status: r.status });
    }
    const result = await r.json();
    if (generation !== connectionGeneration) throw new DOMException("Connection address changed", "AbortError");
    if (token.value !== currentToken) throw new DOMException("Authentication token changed", "AbortError");
    return result;
  } catch (error) {
    // Body reads can expose AbortError instead of the controller's TimeoutError.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerAbortCleanup?.();
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function post<T = any>(path: string, body?: unknown, method = "POST", opts?: ApiOptions): Promise<T> {
  return json<T>(path, { ...opts, method, body: JSON.stringify(body ?? {}) });
}
