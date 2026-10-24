import { computed, ref, watch } from "vue";
import { serverUrl, token, url } from "./api";

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
export const connectionFailure = ref(false);
export const recoveryDismissed = ref(false);
watch(connectionFailure, failed => { if (!failed) recoveryDismissed.value = false; });
export const recoveryOpen = computed(() => connectionFailure.value && !!connection.value?.prompt && !recoveryDismissed.value && connection.value.addresses.some(a => a.url !== activeAddress()));
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
  localStorage.setItem(key, JSON.stringify(value));
  connection.value = value;
}
export function saveAddresses(addresses: ConnectionAddress[], prompt: boolean) {
  if (!connection.value) throw new Error("Connect to the daemon first.");
  const normalized = addresses.filter(a => a.url.trim()).map(a => ({ url: normalizeAddress(a.url), label: a.label.trim() || "Server" }));
  if (new Set(normalized.map(a => a.url)).size !== normalized.length) throw new Error("Each address must be different.");
  persist({ ...connection.value, addresses: normalized, prompt });
}
export async function rememberConnection() {
  try {
    const origin = serverUrl.value;
    const response = await fetch(url("/v1/connection"), { headers: token.value ? { authorization: "Bearer " + token.value } : {}, signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!response.ok) return;
    const info = await response.json();
    if (origin !== serverUrl.value) return;
    if (typeof info.id !== "string" || !Array.isArray(info.addresses)) return;
    const previous = connection.value?.id === info.id ? connection.value : null;
    const addresses: ConnectionAddress[] = previous ? [...previous.addresses] : [];
    const current = info.addresses.find((a: ConnectionAddress) => a.url === activeAddress()) ?? { url: activeAddress(), label: "Saved" };
    for (const address of previous ? [current] : [...info.addresses, current]) {
      if (typeof address.url === "string" && typeof address.label === "string" && !addresses.some(a => a.url === address.url)) addresses.push(address);
    }
    persist({ id: info.id, addresses, prompt: previous?.prompt ?? true });
    connectionFailure.value = false;
  } catch { /* Older daemons and unavailable browser storage do not prevent login. */ }
}
/** Check identity without credentials first. Never replay a failed mutation on another address. */
export async function checkAddress(address: string): Promise<string> {
  const target = normalizeAddress(address);
  if (!connection.value) throw new Error("This daemon has no saved identity. Reconnect after updating the daemon.");
  const expectedId = connection.value.id, bearer = token.value, origin = serverUrl.value;
  const unchanged = () => {
    if (connection.value?.id !== expectedId || token.value !== bearer || serverUrl.value !== origin) throw new Error("The active connection changed. Select the address again.");
  };
  if (location.protocol === "https:" && target.startsWith("http:")) throw new Error("This HTTPS page cannot connect to an HTTP address. Use HTTPS or the desktop app.");
  const health = await fetch(target + "/health", { signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error", credentials: "omit" });
  if (!health.ok || (await health.json()).daemonId !== expectedId) throw new Error("This address does not match the current daemon. No token was sent.");
  unchanged();
  const response = await fetch(target + "/v1/connection", { headers: bearer ? { authorization: "Bearer " + bearer } : {}, signal: AbortSignal.timeout(5000), cache: "no-store", redirect: "error", credentials: "omit" });
  if (!response.ok) throw new Error(response.status === 401 ? "The daemon rejected the token." : "The daemon is not available.");
  if ((await response.json()).id !== expectedId) throw new Error("Daemon identity changed. Connection was not switched.");
  unchanged();
  return target;
}
