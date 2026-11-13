// Browser panel state. The server owns the tabs; this store lists them per session and remembers which one is shown.
import { reactive } from "vue";
import { json, post, serverUrl } from "@/lib/api";
import { sessionSignal } from "@/stores/chat";
import { dock } from "@/stores/dock";
import { terminal } from "@/stores/terminal";

export interface BrowserTabInfo {
  tabId: string;
  url: string;
  owner: "user" | "agent";
  /** You can click and type. False: view only. */
  input: boolean;
  /** Frames are pushed. False: a screenshot about once a second. */
  live: boolean;
}

export const browser = reactive({
  /** false: browser.panel is off or no provider is selected. The Browser pane stays hidden. */
  enabled: false,
  session: "",
  tabs: [] as BrowserTabInfo[],
  active: "",
  /** You pressed New tab: a blank tab shows until you enter an address. It does not start from the active tab's page. */
  draft: false,
  loading: false,
  error: "",
});

let epoch = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const message = (e: unknown) => (e as Error).message || "Browser request failed.";

export async function loadBrowser(session: string) {
  const mine = ++epoch;
  if (browser.session !== session) { browser.tabs = []; browser.active = ""; browser.enabled = false; browser.draft = false; }
  browser.session = session;
  browser.error = "";
  if (!session) return;
  browser.loading = true;
  try {
    const r = await json<{ enabled: boolean; tabs: BrowserTabInfo[] }>(`/v1/sessions/${session}/browser`, { signal: sessionSignal() });
    if (mine !== epoch) return;
    browser.enabled = r.enabled;
    browser.tabs = r.tabs;
    if (!r.tabs.some(t => t.tabId === browser.active)) browser.active = r.tabs[0]?.tabId ?? "";
    if (!r.enabled && dock.pane === "browser") dock.pane = "terminal";
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    if (mine === epoch) { browser.enabled = false; browser.error = message(e); }
  } finally {
    if (mine === epoch) browser.loading = false;
  }
}

/** Poll while the pane is on screen, so tabs Luna opens or closes show up. */
export function watchBrowser(on: boolean) {
  clearInterval(timer);
  timer = undefined;
  if (on) timer = setInterval(() => { if (browser.session && !document.hidden) void loadBrowser(browser.session); }, 3000);
}

export async function openBrowserTab(url: string) {
  const session = browser.session;
  if (!session) return;
  browser.error = "";
  try {
    const tab = await post<BrowserTabInfo>(`/v1/sessions/${session}/browser`, { url });
    if (browser.session !== session) return;
    browser.tabs.push(tab);
    selectBrowserTab(tab.tabId);
  } catch (e) { browser.error = message(e); }
}

/** Show one tab. Leaves a blank new tab. */
export function selectBrowserTab(tabId: string) {
  browser.active = tabId;
  browser.draft = false;
}

/** You asked to see a tab from the transcript: open the dock on the Browser pane and select the tab when it still exists. */
export async function showBrowserTab(session: string, tabId?: string) {
  if (!session || browser.session !== session) return;
  dock.pane = "browser";
  terminal.open = true;
  await loadBrowser(session);
  if (browser.session !== session || !browser.enabled) return;
  if (tabId && browser.tabs.some(t => t.tabId === tabId)) selectBrowserTab(tabId);
  else browser.draft = false;
}

export async function closeBrowserTab(tabId: string) {
  const session = browser.session;
  try { await post(`/v1/sessions/${session}/browser/${tabId}`, undefined, "DELETE"); }
  catch (e) { if ((e as { status?: number }).status !== 404) { browser.error = message(e); return; } }
  dropBrowserTab(tabId);
}

export function dropBrowserTab(tabId: string) {
  const index = browser.tabs.findIndex(t => t.tabId === tabId);
  if (index < 0) return;
  browser.tabs.splice(index, 1);
  if (browser.active === tabId) browser.active = (browser.tabs[index] ?? browser.tabs[index - 1])?.tabId ?? "";
}

/** The socket reported a state change. */
export function applyMeta(tabId: string, meta: Partial<BrowserTabInfo>) {
  const t = browser.tabs.find(x => x.tabId === tabId);
  if (t) Object.assign(t, meta);
}

/** Luna used a browser tool. A new tab opens the dock on the Browser pane, so you watch it live. */
export async function agentBrowserActivity(session: string, opened: boolean) {
  if (!session || browser.session !== session) return;
  const known = new Set(browser.tabs.map(t => t.tabId));
  await loadBrowser(session);
  if (!browser.enabled || browser.session !== session) return;
  const fresh = browser.tabs.filter(t => !known.has(t.tabId) && t.owner === "agent").at(-1);
  if (opened && fresh) { selectBrowserTab(fresh.tabId); dock.pane = "browser"; terminal.open = true; }
}

/** WebSocket URL for one attach. The ticket is single use, so call this for every connection attempt. */
export async function browserAttachUrl(session: string, tabId: string): Promise<string> {
  const { ticket } = await post<{ ticket: string }>(`/v1/sessions/${session}/browser/${tabId}/ticket`);
  const u = new URL(`/v1/browser/${tabId}/attach`, serverUrl.value || window.location.origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("ticket", ticket);
  return u.toString();
}
