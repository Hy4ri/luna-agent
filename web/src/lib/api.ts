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
  token.value = value;
  try { localStorage.setItem("luna.token", value); } catch {}
}
const handlers: ((reason: string) => void)[] = [];
export function onUnauthorized(fn: (reason: string) => void) { handlers.push(fn); }

export type HttpError = Error & { status?: number };

export async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...((opts.headers as Record<string, string>) || {}) };
  if (token.value) headers.authorization = "Bearer " + token.value;
  const generation = connectionGeneration;
  const origin = serverUrl.value;
  const r = await fetch(origin + path, { ...opts, headers });
  if (generation !== connectionGeneration) throw new DOMException("Connection address changed", "AbortError");
  if (r.status === 401) { for (const fn of handlers) fn("token rejected"); throw new Error("unauthorized"); }
  return r;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function json<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const generation = connectionGeneration;
  const r = await api(path, opts);
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    if (generation !== connectionGeneration) throw new DOMException("Connection address changed", "AbortError");
    throw Object.assign(new Error(error.error || r.statusText), { status: r.status });
  }
  const result = await r.json();
  if (generation !== connectionGeneration) throw new DOMException("Connection address changed", "AbortError");
  return result;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function post<T = any>(path: string, body?: unknown, method = "POST"): Promise<T> {
  return json<T>(path, { method, body: JSON.stringify(body ?? {}) });
}
