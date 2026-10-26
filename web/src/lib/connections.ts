import { computed, ref, watch } from "vue";
import { isDesktop, serverUrl, token, url } from "./api";

export interface ConnectionAddress { url: string; label: string }
interface Connection { id: string; addresses: ConnectionAddress[]; prompt: boolean }
const key = "luna.connection";
function load(): Connection | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (typeof value?.id !== "string" || !Array.isArray(value.addresses)) return null;
    return { id: value.id, prompt: value.prompt !== false, addresses: value.addresses.filter((a: ConnectionAddress) => typeof a?.label === "string" && typeof a?.url === "string") };
  } catch { return null; }
}
export const connection = ref<Connection | null>(load());
const failedSources = ref(new Set<symbol>());
export const connectionFailure = computed(() => failedSources.value.size > 0);
/** A healthy feed must not hide another feed's failure. Each owner clears only its own state. */
export function reportConnectionFailure(source: symbol, failed: boolean) {
  if (failed) failedSources.value.add(source); else failedSources.value.delete(source);
}
export const recoveryDismissed = ref(false);
/** A reachable preferred route; this does not mean the current connection failed. */
export const preferredAddress = ref<string | null>(null);
// Dismissing a healthy-route suggestion must not suppress a later real outage.
watch(connectionFailure, () => { recoveryDismissed.value = false; });
watch([serverUrl, token, connection], () => { preferredAddress.value = null; recoveryDismissed.value = false; });
export const recoveryOpen = computed(() => (connectionFailure.value || !!preferredAddress.value) && !!connection.value?.prompt && !recoveryDismissed.value && connection.value.addresses.some(a => a.url !== activeAddress()));
export const activeAddress = () => serverUrl.value || location.origin;
export function normalizeAddress(value: string): string {
  let address = value.trim();
  const bare = !/^https?:\/\//i.test(address);
  if (bare) address = "http://" + address;
  const parsed = new URL(address);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("Use an HTTP or HTTPS server address without a path, password, query, or fragment.");
  if (bare && !parsed.port && !/:80\/?$/.test(address)) parsed.port = "8787";
  return parsed.origin;
}
function persist(value: Connection) {
  const encoded = JSON.stringify(value);
  localStorage.setItem(key, encoded);
  if (JSON.stringify(connection.value) !== encoded) connection.value = value;
}
export function saveAddresses(addresses: ConnectionAddress[], prompt: boolean) {
  if (!connection.value) throw new Error("Connect to the daemon first.");
  const normalized = addresses.filter(a => a.url.trim()).map(a => ({ url: normalizeAddress(a.url), label: a.label.trim() || "Server" }));
  if (new Set(normalized.map(a => a.url)).size !== normalized.length) throw new Error("Each address must be different.");
  persist({ ...connection.value, addresses: normalized, prompt });
}
export async function rememberConnection() {
  try {
    const origin = serverUrl.value, bearer = token.value;
    const response = await fetch(url("/v1/connection"), { headers: bearer ? { authorization: "Bearer " + bearer } : {}, signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!response.ok) return;
    const info = await response.json();
    if (origin !== serverUrl.value || bearer !== token.value) return;
    if (typeof info.id !== "string" || !Array.isArray(info.addresses)) return;
    const previous = connection.value?.id === info.id ? connection.value : null;
    const addresses: ConnectionAddress[] = previous ? [...previous.addresses] : [];
    const current = info.addresses.find((a: ConnectionAddress) => a.url === activeAddress()) ?? { url: activeAddress(), label: "Saved" };
    for (const address of previous ? [current] : [...info.addresses, current]) {
      if (typeof address.url === "string" && typeof address.label === "string" && !addresses.some(a => a.url === address.url)) addresses.push(address);
    }
    persist({ id: info.id, addresses, prompt: previous?.prompt ?? true });
  } catch { /* Older daemons and unavailable browser storage do not prevent login. */ }
}
/** Check identity without credentials first. Never replay a failed mutation on another address. */
export async function checkAddress(address: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const target = normalizeAddress(address);
  if (!connection.value) throw new Error("This daemon has no saved identity. Reconnect after updating the daemon.");
  const saved = connection.value, expectedId = saved.id, bearer = token.value, origin = serverUrl.value;
  const unchanged = () => {
    if (connection.value !== saved || token.value !== bearer || serverUrl.value !== origin) throw new Error("The active connection changed. Select the address again.");
    options.signal?.throwIfAborted();
  };
  if (location.protocol === "https:" && !isDesktop && target.startsWith("http:")) throw new Error("This HTTPS page cannot connect to an HTTP address. Use HTTPS or the desktop app.");
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException("Address check timed out", "TimeoutError")), options.timeoutMs ?? 5000);
  try {
    const init = { signal: controller.signal, cache: "no-store", redirect: "error", credentials: "omit" } as const;
    const health = await fetch(target + "/health", init);
    if (!health.ok || (await health.json()).daemonId !== expectedId) throw new Error("This address does not match the current daemon. No token was sent.");
    unchanged(); controller.signal.throwIfAborted();
    const response = await fetch(target + "/v1/connection", { ...init, headers: bearer ? { authorization: "Bearer " + bearer } : {} });
    if (!response.ok) throw new Error(response.status === 401 ? "The daemon rejected the token." : "The daemon is not available.");
    if ((await response.json()).id !== expectedId) throw new Error("Daemon identity changed. Connection was not switched.");
    unchanged(); controller.signal.throwIfAborted();
    return target;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

/** Recovery selects the first working route. Preference respects the saved order. */
export async function findWorkingAddress(addresses: ConnectionAddress[], signal: AbortSignal, preferred = false): Promise<string | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const probes = addresses.filter(a => a.url !== activeAddress()).map(a => checkAddress(a.url, { signal: controller.signal, timeoutMs: preferred ? 2000 : 3000 }));
    if (!probes.length) return null;
    if (!preferred) return await Promise.any(probes).catch(() => null);
    const results = await Promise.all(probes.map(p => p.catch(() => null)));
    return results.find((v): v is string => !!v) ?? null;
  } finally {
    controller.abort();
    signal.removeEventListener("abort", cancel);
  }
}
