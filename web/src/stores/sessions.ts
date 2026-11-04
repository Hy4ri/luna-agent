// Conversation history list + projects for the sidebar. Port of vanilla sidebar.js data logic.
import { reactive } from "vue";
import { api, json, post, serverUrl, token } from "@/lib/api";
import { notify } from "@/lib/platform";
import { sessionState, SESSION_STATUS_LABELS } from "@/lib/session-status";
import type { Project, SessionMeta, SessionStatus } from "@/lib/types";
import { sortProjects } from "@/lib/projects";
import { chat, clearConversation } from "./chat";

const DRILL_KEY = "luna.side.project";
function readDrill(): string | null {
  try { return localStorage.getItem(DRILL_KEY); } catch { return null; }
}

export const history = reactive({
  list: [] as SessionMeta[],
  projects: [] as Project[],
  archived: false,
  searchOpen: false,
  query: "",
  /** Inline status line under the history header (errors from row actions). */
  status: "",
  /** Project folder open in the sidebar ("none" for chats without a project), or null for the project list. */
  drill: readDrill(),
});

export const sessionTitle = (s: Pick<SessionMeta, "id" | "title">) => s.title || "Conversation " + s.id;
export const projectName = (id: number | null | undefined) => history.projects.find(p => p.id === id)?.name;

export function setDrill(key: string | null) {
  history.drill = key;
  try { key === null ? localStorage.removeItem(DRILL_KEY) : localStorage.setItem(DRILL_KEY, key); } catch {}
}

let inFlightProjects: { origin: string; credential: string; promise: Promise<void> } | null = null;

export async function loadProjects(): Promise<void> {
  const origin = serverUrl.value, credential = token.value;
  if (inFlightProjects && inFlightProjects.origin === origin && inFlightProjects.credential === credential) {
    return inFlightProjects.promise;
  }

  const task = (async () => {
    const res = await json<{ projects: Project[] }>("/v1/projects").catch(() => ({ projects: [] as Project[] }));
    if (origin !== serverUrl.value || credential !== token.value) return;
    history.projects = sortProjects(res.projects || []);
    const saved = localStorage.getItem("luna.project");
    if (!saved || !history.projects.some(p => String(p.id) === saved)) {
      if (history.projects.length) localStorage.setItem("luna.project", String(history.projects[0].id));
      else localStorage.removeItem("luna.project");
    }
  })();

  const current = { origin, credential, promise: task };
  inFlightProjects = current;
  const cleanup = () => { if (inFlightProjects === current) inFlightProjects = null; };
  task.then(cleanup, cleanup);
  return task;
}

const favoriteBusy = new Set<number>();
/** Flip a project's favourite flag at once and roll it back when the server refuses. */
export async function toggleFavorite(id: number) {
  const p = history.projects.find(x => x.id === id);
  if (!p || p.general || favoriteBusy.has(id)) return;
  favoriteBusy.add(id);
  const before = !!p.favorite, next = !before;
  const set = (v: boolean) => { const cur = history.projects.find(x => x.id === id); if (cur) cur.favorite = v; history.projects = sortProjects([...history.projects].sort((a, b) => Number(!!b.general) - Number(!!a.general) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))); };
  set(next);
  try { await post(`/v1/projects/${id}`, { favorite: next }, "PATCH"); }
  catch (e) { set(before); history.status = (e as Error).message; }
  finally { favoriteBusy.delete(id); }
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
    if (!s.recovery?.active && (was === "running" || was === "reviewing") && NOTIFY_ON.has(now)) notify(sessionTitle(s), SESSION_STATUS_LABELS[now]);
  }
}

let historyRequest = 0;
let inFlightSessions: { origin: string; credential: string; promise: Promise<void> } | null = null;

export async function loadSessions(): Promise<void> {
  const origin = serverUrl.value, credential = token.value;
  if (inFlightSessions && inFlightSessions.origin === origin && inFlightSessions.credential === credential) {
    return inFlightSessions.promise;
  }

  const task = (async () => {
    const request = ++historyRequest;
    const r = await json<{ sessions: SessionMeta[] }>("/v1/sessions");
    if (request !== historyRequest || origin !== serverUrl.value || credential !== token.value) return;
    history.list = r.sessions;
    notifyChanges(r.sessions);
    const active = history.list.find(s => String(s.id) === String(chat.session));
    if (active?.title) chat.title = active.title;
    if (chat.session && !active) {
      const sid = chat.session;
      const response = await api(`/v1/sessions/${sid}?limit=1`);
      if (request !== historyRequest || origin !== serverUrl.value || credential !== token.value) return;
      if (response.status === 404 && sid === chat.session) clearConversation();
    }
  })();

  const current = { origin, credential, promise: task };
  inFlightSessions = current;
  const cleanup = () => { if (inFlightSessions === current) inFlightSessions = null; };
  task.then(cleanup, cleanup);
  return task;
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
export const moveSession = (s: SessionMeta, project: number) =>
  act(() => post(`/v1/sessions/${s.id}/metadata`, { project }, "PATCH"));
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
export function resumeLabel(at: number, now = Date.now(), exact = true) {
  const d = new Date(at), sameDay = d.toDateString() === new Date(now).toDateString();
  return (exact ? "Retry after " : "Estimated retry ") + (sameDay ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " ")
    + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export async function deleteSession(s: SessionMeta) {
  if (!confirm('Permanently delete "' + sessionTitle(s) + '" and all its child conversations and forks? Stored messages and search entries will be removed. This cannot be undone.')) return;
  return act(async () => {
    const result = await json<{ deleted: (number | string)[] }>(`/v1/sessions/${s.id}`, { method: "DELETE" });
    if (result.deleted.some(n => String(n) === String(chat.session))) clearConversation();
  });
}

export type BulkAction = "archive" | "restore" | "pin" | "unpin" | "title" | "delete";
/** Run one action on many sessions in turn. Returns how many succeeded; failures set history.status. Asks once before deleting. */
export async function bulkAction(sessions: SessionMeta[], action: BulkAction): Promise<number> {
  if (!sessions.length) return 0;
  if (action === "delete" && !confirm(`Permanently delete ${sessions.length} conversation${sessions.length === 1 ? "" : "s"} with all child conversations and forks? Stored messages and search entries will be removed. This cannot be undone.`)) return 0;
  history.status = "";
  let ok = 0; const errors: string[] = [];
  for (const s of sessions) {
    try {
      if (action === "delete") {
        const r = await json<{ deleted: (number | string)[] }>(`/v1/sessions/${s.id}`, { method: "DELETE" });
        if (r.deleted.some(n => String(n) === String(chat.session))) clearConversation();
      } else if (action === "title") await post(`/v1/sessions/${s.id}/title`, {});
      else {
        await post(`/v1/sessions/${s.id}/metadata`, action === "pin" || action === "unpin" ? { pinned: action === "pin" } : { archived: action === "archive" }, "PATCH");
        if (action === "archive" && String(chat.session) === String(s.id)) clearConversation();
      }
      ok++;
    } catch (e) { errors.push(`${sessionTitle(s)}: ${(e as Error).message}`); }
  }
  if (errors.length) history.status = `${errors.length} of ${sessions.length} failed. ${errors[0]}`;
  await loadSessions();
  return ok;
}
