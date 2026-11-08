// Terminal dock state. The server owns the terminals; this store lists them per session and remembers which tab is open.
import { reactive } from "vue";
import { json, post, serverUrl } from "@/lib/api";
import { MIN_HEIGHT, clampHeight, dock } from "@/stores/dock";

export interface TerminalInfo {
  id: string;
  session: number;
  cwd: string;
  shell: string;
  /** "agent": Luna started it to run `command`. */
  owner?: "user" | "agent";
  command?: string;
  /** Who types. The other side watches. */
  controller?: "user" | "agent";
  /** Luna can see it. Always true for her own terminals. */
  shared?: boolean;
  status: "running" | "ended";
  exitCode: number | null;
  endReason?: string;
}

const HEIGHT_KEY = "luna.terminal.height";
const savedHeight = () => { const n = Number(localStorage.getItem(HEIGHT_KEY)); return Number.isFinite(n) && n >= MIN_HEIGHT ? n : 280; };

export const terminal = reactive({
  /** Dock visible. Shared by all sessions in this window. */
  open: false,
  height: savedHeight(),
  /** The loaded session. Tabs below belong to it. */
  session: "",
  /** false: the owner has not turned on Settings > Tools > Terminal (terminal.user). */
  enabled: true,
  /** terminal.agent: Luna has her terminal tool and can be given shared terminals. */
  agentEnabled: false,
  loading: false,
  error: "",
  tabs: [] as TerminalInfo[],
  active: "",
});

export { clampHeight };
export function setHeight(px: number) { terminal.height = clampHeight(px); localStorage.setItem(HEIGHT_KEY, String(terminal.height)); }

let epoch = 0;
const message = (e: unknown) => (e as Error).message || "Terminal request failed.";

/** Load this session's terminals. Safe to call again; the latest call wins. */
export async function loadTerminals(session: string) {
  const mine = ++epoch;
  if (terminal.session !== session) { terminal.tabs = []; terminal.active = ""; }
  terminal.session = session;
  terminal.error = "";
  if (!session) return;
  terminal.loading = true;
  try {
    const r = await json<{ enabled: boolean; agentEnabled?: boolean; terminals: TerminalInfo[] }>(`/v1/sessions/${session}/terminals`);
    if (mine !== epoch) return;
    terminal.enabled = r.enabled;
    terminal.agentEnabled = !!r.agentEnabled;
    terminal.tabs = r.terminals;
    if (!r.terminals.some(t => t.id === terminal.active)) terminal.active = r.terminals[0]?.id ?? "";
  } catch (e) {
    if (mine === epoch) terminal.error = message(e);
  } finally {
    if (mine === epoch) terminal.loading = false;
  }
}

export async function newTerminal(size?: { cols: number; rows: number }) {
  const session = terminal.session;
  if (!session) return;
  terminal.error = "";
  try {
    const t = await post<TerminalInfo>(`/v1/sessions/${session}/terminals`, size);
    if (terminal.session !== session) return;
    terminal.tabs.push(t);
    terminal.active = t.id;
    terminal.open = true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403) terminal.enabled = false;
    terminal.error = message(e);
  }
}

export async function closeTerminal(id: string) {
  const session = terminal.session;
  try { await post(`/v1/sessions/${session}/terminals/${id}`, undefined, "DELETE"); }
  catch (e) { if ((e as { status?: number }).status !== 404) { terminal.error = message(e); return; } }
  if (terminal.session !== session) return;
  const index = terminal.tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  terminal.tabs.splice(index, 1);
  if (terminal.active === id) terminal.active = (terminal.tabs[index] ?? terminal.tabs[index - 1])?.id ?? "";
}

/** Called when a socket reports the shell exited, so the tab shows it without a reload. */
export function markEnded(id: string, exitCode: number | null, reason?: string) {
  const t = terminal.tabs.find(x => x.id === id);
  if (t) { t.status = "ended"; t.exitCode = exitCode; if (reason) t.endReason = reason; }
}

/** Remove a tab the server already closed. */
export function dropTab(id: string) {
  const index = terminal.tabs.findIndex(t => t.id === id);
  if (index < 0) return;
  terminal.tabs.splice(index, 1);
  if (terminal.active === id) terminal.active = (terminal.tabs[index] ?? terminal.tabs[index - 1])?.id ?? "";
}

/** Luna used her terminal tool. A new terminal opens the dock on it, so m57 watches it live. */
export async function agentTerminalActivity(session: string, started: boolean) {
  if (!session || terminal.session !== session) return;
  const known = new Set(terminal.tabs.map(t => t.id));
  await loadTerminals(session);
  if (!started || terminal.session !== session) return;
  const fresh = terminal.tabs.filter(t => !known.has(t.id) && t.owner === "agent").at(-1);
  if (fresh) { terminal.active = fresh.id; terminal.open = true; }
}

/** m57 asked to see a terminal from the transcript: open the dock on the Terminal pane and select it when it still exists. */
export async function showTerminal(session: string, id?: string) {
  if (!session || terminal.session !== session) return;
  dock.pane = "terminal";
  terminal.open = true;
  await loadTerminals(session);
  if (terminal.session === session && id && terminal.tabs.some(t => t.id === id)) terminal.active = id;
}

export type ControlAction = "take" | "give" | "share" | "unshare";
/** Move the keyboard between m57 and Luna, or show or hide one of his terminals from her. */
export async function controlTerminal(id: string, action: ControlAction) {
  const session = terminal.session;
  terminal.error = "";
  try {
    const t = await post<TerminalInfo>(`/v1/sessions/${session}/terminals/${id}/control`, { action });
    setControl(id, t.controller ?? "user", !!t.shared);
  } catch (e) { terminal.error = message(e); }
}

/** The socket reported a control change. */
export function setControl(id: string, controller: "user" | "agent", shared: boolean) {
  const t = terminal.tabs.find(x => x.id === id);
  if (t) { t.controller = controller; t.shared = shared; }
}

export const tabLabel = (t: TerminalInfo) => t.command ? t.command.split(/\s+/)[0]!.split("/").pop()! : t.shell;

export async function toggleTerminal() {
  terminal.open = !terminal.open;
  if (terminal.open && terminal.session && terminal.enabled && !terminal.tabs.length && !terminal.loading) await newTerminal();
}

/** WebSocket URL for one attach. The ticket is single use, so call this for every connection attempt. */
export async function attachUrl(session: string, id: string): Promise<string> {
  const { ticket } = await post<{ ticket: string }>(`/v1/sessions/${session}/terminals/${id}/ticket`);
  const base = serverUrl.value || window.location.origin;
  const u = new URL(`/v1/terminals/${id}/attach`, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("ticket", ticket);
  return u.toString();
}
