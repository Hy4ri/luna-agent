// Conversation history list + projects for the sidebar. Port of vanilla sidebar.js data logic.
import { reactive } from "vue";
import { api, json, post } from "@/lib/api";
import { notify } from "@/lib/platform";
import { sessionState, SESSION_STATUS_LABELS } from "@/lib/session-status";
import type { Project, SessionMeta, SessionStatus } from "@/lib/types";
import { chat, clearConversation } from "./chat";

const GROUPS_KEY = "luna.side.groups";
function readGroups(): Record<string, boolean> {
  try { const v = JSON.parse(localStorage.getItem(GROUPS_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

export const history = reactive({
  list: [] as SessionMeta[],
  projects: [] as Project[],
  archived: false,
  searchOpen: false,
  query: "",
  /** Inline status line under the history header (errors from row actions). */
  status: "",
  collapsedGroups: readGroups(),
});

export const sessionTitle = (s: Pick<SessionMeta, "id" | "title">) => s.title || "Conversation " + s.id;
export const projectName = (id: number | null | undefined) => history.projects.find(p => p.id === id)?.name;

export function toggleGroup(key: string) {
  history.collapsedGroups[key] = !history.collapsedGroups[key];
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(history.collapsedGroups)); } catch {}
}

export async function loadProjects() {
  history.projects = (await json<{ projects: Project[] }>("/v1/projects").catch(() => ({ projects: [] as Project[] }))).projects || [];
  const saved = localStorage.getItem("luna.project");
  if (!saved || !history.projects.some(p => String(p.id) === saved)) {
    if (history.projects.length) localStorage.setItem("luna.project", String(history.projects[0].id));
    else localStorage.removeItem("luna.project");
  }
}

// Desktop notifications: a session that was running and now needs attention or has stopped.
const NOTIFY_ON = new Set<SessionStatus>(["finished", "review_finished", "needs_input", "needs_approval", "failed", "limit_reached"]);
let seenStatus: Map<string, SessionStatus> | undefined;
/** Forget the last snapshot (new daemon or login) so ids from another server never notify. */
export function resetNotifications() { seenStatus = undefined; }
function notifyChanges(list: SessionMeta[]) {
  const next = new Map(list.map(s => [String(s.id), sessionState(s)]));
  const prev = seenStatus;
  seenStatus = next;
  if (!prev || document.hasFocus()) return; // First load, or the user is looking at the app.
  for (const s of list) {
    const was = prev.get(String(s.id)), now = next.get(String(s.id))!;
    if ((was === "running" || was === "reviewing") && NOTIFY_ON.has(now)) notify(sessionTitle(s), SESSION_STATUS_LABELS[now]);
  }
}

let historyRequest = 0;
export async function loadSessions() {
  const request = ++historyRequest;
  const r = await json<{ sessions: SessionMeta[] }>("/v1/sessions");
  if (request !== historyRequest) return;
  history.list = r.sessions;
  notifyChanges(r.sessions);
  const active = history.list.find(s => String(s.id) === String(chat.session));
  if (active?.title) chat.title = active.title;
  if (chat.session && !active) {
    const sid = chat.session;
    const response = await api(`/v1/sessions/${sid}?limit=1`);
    if (request !== historyRequest) return;
    if (response.status === 404 && sid === chat.session) clearConversation();
  }
}

export function setArchivedView(archived: boolean) {
  history.archived = archived;
  loadSessions().catch(e => { history.status = (e as Error).message; });
}
export function resetHistoryView() {
  history.archived = false; history.searchOpen = false; history.query = "";
}

async function act(run: () => Promise<unknown>) {
  history.status = "";
  try { await run(); await loadSessions(); return true; }
  catch (e) { history.status = (e as Error).message; return false; }
}
export const renameSession = (s: SessionMeta, title: string) =>
  act(() => post(`/v1/sessions/${s.id}/metadata`, { title }, "PATCH"));
/** Whether a session-title model is configured. Checked on every menu open, so Settings changes apply at once. */
export const titleModelAvailable = () =>
  json<{ available: boolean }>("/v1/session-titles").then(r => !!r.available, () => false);
export const generateTitle = (s: SessionMeta) =>
  act(() => post(`/v1/sessions/${s.id}/title`, {}));
export const togglePinned = (s: SessionMeta) =>
  act(() => post(`/v1/sessions/${s.id}/metadata`, { pinned: !s.pinned }, "PATCH"));
export const toggleArchived = (s: SessionMeta) => act(async () => {
  await post(`/v1/sessions/${s.id}/metadata`, { archived: !s.archived }, "PATCH");
  if (!s.archived && String(chat.session) === String(s.id)) clearConversation();
});
/** Asks for confirmation (native dialog), then deletes the conversation and its children. */
/** Cancel the automatic continuation scheduled after a usage limit. */
export const cancelLimitWait = (s: SessionMeta) =>
  act(() => json(`/v1/sessions/${s.id}/limit-wait`, { method: "DELETE" }));
/** Local time of a scheduled continuation; the date appears only when it is not today. */
export function resumeLabel(at: number, now = Date.now()) {
  const d = new Date(at), sameDay = d.toDateString() === new Date(now).toDateString();
  return "Resumes " + (sameDay ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " ")
    + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export async function deleteSession(s: SessionMeta) {
  if (!confirm('Permanently delete "' + sessionTitle(s) + '" and all its child conversations and forks? Stored messages and search entries will be removed. This cannot be undone.')) return;
  return act(async () => {
    const result = await json<{ deleted: (number | string)[] }>(`/v1/sessions/${s.id}`, { method: "DELETE" });
    if (result.deleted.some(n => String(n) === String(chat.session))) clearConversation();
  });
}
