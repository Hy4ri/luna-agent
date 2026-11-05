// Conversation history list + projects for the sidebar. Port of vanilla sidebar.js data logic.
import { reactive, watch } from "vue";
import { api, json, post, serverUrl, token } from "@/lib/api";
import { notify } from "@/lib/platform";
import { sessionState, SESSION_STATUS_LABELS } from "@/lib/session-status";
import type { Project, SessionMeta, SessionStatus } from "@/lib/types";
import { sortProjects } from "@/lib/projects";
import { chat, clearConversation } from "./chat";

export interface GroupSummary {
  count: number;
  lastActivity: number;
  activity: number;
  statuses: Record<string, number>;
  machines: Record<string, number>;
}

export interface SessionsQueryOptions {
  limit?: number;
  archived?: "0" | "1" | "all";
  project?: "none" | number;
  worker?: "main" | number | "all";
  q?: string;
  cursor?: string | null;
  ids?: number[];
  running?: boolean;
}

export interface SessionsPage {
  sessions: SessionMeta[];
  nextCursor: string | null;
  total: number;
  groups: Record<string, GroupSummary>;
}

const DRILL_KEY = "luna.side.project";
function readDrill(): string | null {
  try { return localStorage.getItem(DRILL_KEY); } catch { return null; }
}

export const history = reactive({
  list: [] as SessionMeta[],
  rows: [] as SessionMeta[],
  groups: {} as Record<string, GroupSummary>,
  total: 0,
  nextCursor: null as string | null,
  loading: false,
  loadingMore: false,
  error: "",
  worker: "all" as "all" | "main" | number,
  projects: [] as Project[],
  projectsLoaded: false,
  projectsError: "",
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

const PROJECT_FRESH_MS = 30_000;
const favoriteContextKey = (id: number) => JSON.stringify([serverUrl.value, token.value, id]);
const favoriteBusy = new Set<string>();
const favoriteValues = new Map<string, boolean>();
let projectsFreshUntil = 0, projectsGeneration = 0;
let projectsController: AbortController | undefined;
let inFlightProjects: Promise<void> | undefined;

/** Discard pre-mutation reads without clearing the last successful project list. */
export function invalidateProjects() {
  projectsFreshUntil = 0;
  projectsGeneration++;
  projectsController?.abort();
  projectsController = undefined;
  inFlightProjects = undefined;
}
watch([serverUrl, token], () => {
  invalidateProjects();
  history.projects = [];
  history.projectsLoaded = false;
  history.projectsError = "";
}, { flush: "sync" });

/** Cached-first on reopen; force waits for a fresh server receipt after a mutation. */
export function loadProjects(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && projectsFreshUntil > Date.now()) return Promise.resolve();
  if (options.force) invalidateProjects();
  if (!inFlightProjects) {
    const generation = projectsGeneration;
    const controller = new AbortController();
    projectsController = controller;
    const request = json<{ projects: Project[] }>("/v1/projects", { signal: controller.signal }).then(res => {
      if (generation !== projectsGeneration) return;
      history.projects = sortProjects(res.projects.map(p => favoriteValues.has(favoriteContextKey(p.id)) ? { ...p, favorite: favoriteValues.get(favoriteContextKey(p.id))! } : p));
      history.projectsLoaded = true;
      history.projectsError = "";
      projectsFreshUntil = Date.now() + PROJECT_FRESH_MS;
      const saved = localStorage.getItem("luna.project");
      if (!saved || !history.projects.some(p => String(p.id) === saved)) {
        if (history.projects.length) localStorage.setItem("luna.project", String(history.projects[0].id));
        else localStorage.removeItem("luna.project");
      }
    }).catch(error => {
      if (generation === projectsGeneration && !controller.signal.aborted) {
        history.projectsError = (error as Error).message;
        throw error;
      }
    }).finally(() => {
      if (inFlightProjects === request) { inFlightProjects = undefined; projectsController = undefined; }
    });
    inFlightProjects = request;
  }
  // A failed refresh never turns a populated sidebar into an empty one.
  if (history.projectsLoaded && !options.force) {
    void inFlightProjects.catch(() => {});
    return Promise.resolve();
  }
  return inFlightProjects;
}

/** Flip a project's favourite flag at once and roll it back when the server refuses. */
export async function toggleFavorite(id: number) {
  const p = history.projects.find(x => x.id === id), key = favoriteContextKey(id);
  if (!p || p.general || favoriteBusy.has(key)) return;
  const origin = serverUrl.value, credential = token.value;
  const current = () => origin === serverUrl.value && credential === token.value;
  favoriteBusy.add(key);
  const before = !!p.favorite, next = !before;
  const set = (v: boolean) => {
    if (!current()) return;
    const cur = history.projects.find(x => x.id === id); if (cur) cur.favorite = v;
    history.projects = sortProjects([...history.projects].sort((a, b) => Number(!!b.general) - Number(!!a.general) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
  };
  invalidateProjects(); favoriteValues.set(key, next); set(next);
  try {
    const saved = await post<Project>(`/v1/projects/${id}`, { favorite: next }, "PATCH");
    if (current()) { invalidateProjects(); set(!!saved.favorite); }
  } catch (e) { if (current()) { set(before); history.status = (e as Error).message; } }
  finally { favoriteBusy.delete(key); favoriteValues.delete(key); }
}

// Desktop notifications: a session that was running and now needs attention or has stopped.
const NOTIFY_ON = new Set<SessionStatus>(["finished", "review_finished", "needs_input", "needs_approval", "failed", "limit_reached"]);
let seenStatus: Map<string, SessionStatus> | undefined;

/** Forget the last snapshot (new daemon or login) so ids from another server never notify. */
export function resetNotifications() {
  seenStatus = undefined;
  watchRunningIds.clear();
  notificationGeneration++;
}

function notifyChanges(list: SessionMeta[]) {
  const next = new Map(list.map(s => [String(s.id), sessionState(s)]));
  const prev = seenStatus;
  // Only active states are needed for the next completion comparison.
  seenStatus = new Map([...next].filter(([, state]) => state === 'running' || state === 'reviewing'));
  if (!prev || document.hasFocus()) return; // First load, or the user is looking at the app.
  for (const s of list) {
    const was = prev.get(String(s.id)), now = next.get(String(s.id))!;
    if (!s.recovery?.active && (was === "running" || was === "reviewing") && NOTIFY_ON.has(now)) {
      notify(sessionTitle(s), SESSION_STATUS_LABELS[now]);
    }
  }
}

/** Set of session IDs that were recently seen running or reviewing, polled for notifications. */
const watchRunningIds = new Set<number>();
let notificationGeneration = 0;
let notificationController: AbortController | undefined;

/** Bounded background poll for active notifications without draining full history. */
async function trackActiveNotifications() {
  const origin = serverUrl.value, credential = token.value;
  const gen = ++notificationGeneration;

  notificationController?.abort();
  const controller = new AbortController();
  notificationController = controller;

  const activeResults: SessionMeta[] = [];

  try {
    // 1. Drain running=true pages until cursor exhausted (limit <= 100 per page)
    let cursor: string | null = null;
    do {
      if (controller.signal.aborted || gen !== notificationGeneration) return;
      const runningPage: SessionsPage = await querySessions({
        archived: "all",
        running: true,
        limit: 100,
        cursor: cursor ?? undefined,
      }, controller.signal);

      if (gen !== notificationGeneration || origin !== serverUrl.value || credential !== token.value) return;
      activeResults.push(...runningPage.sessions);
      cursor = runningPage.nextCursor ?? null;
    } while (cursor);

    // 2. Poll watchRunningIds in chunks <= 100
    const alreadyFetchedIds = new Set(activeResults.map(s => Number(s.id)));
    const neededWatchIds = [...watchRunningIds].filter(id => !alreadyFetchedIds.has(id));

    for (let i = 0; i < neededWatchIds.length; i += 100) {
      if (controller.signal.aborted || gen !== notificationGeneration) return;
      const chunk = neededWatchIds.slice(i, i + 100);
      const watchPage: SessionsPage = await querySessions({
        archived: "all",
        ids: chunk,
        limit: 100,
      }, controller.signal);

      if (gen !== notificationGeneration || origin !== serverUrl.value || credential !== token.value) return;
      activeResults.push(...watchPage.sessions);
    }

    if (gen !== notificationGeneration || origin !== serverUrl.value || credential !== token.value) return;

    // Apply optimistic overlays and merge into bounded list cache
    const sessions = activeResults.map(applyPinOverlay);
    mergeIntoList(sessions);

    // Call notifyChanges exactly once on combined active/watch results
    notifyChanges(sessions);

    // Deleted sessions disappear from this complete active/watch receipt as well.
    watchRunningIds.clear();
    for (const s of sessions) {
      const id = Number(s.id);
      const state = sessionState(s);
      if (state === "running" || state === "reviewing") {
        watchRunningIds.add(id);
      } else {
        watchRunningIds.delete(id);
      }
    }
  } catch (e: any) {
    if (controller.signal.aborted || e?.name === "AbortError" || gen !== notificationGeneration) return;
  }
}

/** Standalone query function for independent consumers and sidebar window fetching.
 *  Always sets default limit: 50 so it never accidentally hits the legacy unbounded route. */
export async function querySessions(options: SessionsQueryOptions = {}, signal?: AbortSignal): Promise<SessionsPage> {
  const limit = options.limit !== undefined ? options.limit : 50;
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (options.archived !== undefined) params.set("archived", options.archived);
  if (options.project !== undefined) params.set("project", String(options.project));
  if (options.worker !== undefined && options.worker !== "all") params.set("worker", String(options.worker));
  if (options.q !== undefined && options.q.trim()) params.set("q", options.q.trim());
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.ids && options.ids.length > 0) params.set("ids", options.ids.slice(0, 100).join(","));
  if (options.running) params.set("running", "1");

  const qs = params.toString();
  const path = qs ? `/v1/sessions?${qs}` : "/v1/sessions";
  return json<SessionsPage>(path, { signal });
}

const pinContextKey = (id: string | number) => JSON.stringify([serverUrl.value, token.value, String(id)]);
const pinBusy = new Set<string>();
const pinValues = new Map<string, boolean>();

function applyPinOverlay(row: SessionMeta): SessionMeta {
  const key = pinContextKey(row.id);
  if (pinValues.has(key)) {
    return { ...row, pinned: pinValues.get(key) };
  }
  return row;
}

/** Retain history.list as a bounded cache (max ~500), preserving focused chat, loaded page IDs, and all history.rows. */
const MAX_LIST_CACHE = 500;
function mergeIntoList(incoming: SessionMeta[]) {
  const map = new Map<string, SessionMeta>();
  for (const s of history.list) {
    map.set(String(s.id), s);
  }
  for (const s of incoming) {
    map.set(String(s.id), s);
  }

  let merged = [...map.values()].map(applyPinOverlay);
  // Sort descending: pinned desc, activity desc, id desc
  merged.sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) ||
    (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) ||
    Number(b.id) - Number(a.id)
  );

  // Preserve focused chat, all currently loaded history.rows, and incoming sessions even if exceeding 500
  const keepIds = new Set<string>();
  if (chat.session) keepIds.add(String(chat.session));
  for (const r of history.rows) keepIds.add(String(r.id));
  for (const s of incoming) keepIds.add(String(s.id));

  const capacityLimit = Math.max(MAX_LIST_CACHE, keepIds.size);
  if (merged.length > capacityLimit) {
    const kept: SessionMeta[] = [];
    const excess: SessionMeta[] = [];
    for (const s of merged) {
      if (keepIds.has(String(s.id))) kept.push(s);
      else excess.push(s);
    }
    const available = capacityLimit - kept.length;
    merged = kept.concat(excess.slice(0, Math.max(0, available)));
    merged.sort((a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) ||
      Number(b.id) - Number(a.id)
    );
  }
  history.list = merged;
}

let historyRequest = 0;
let sidebarController: AbortController | undefined;
let moreController: AbortController | undefined;
let inFlightSessions: { origin: string; credential: string; promise: Promise<void> } | null = null;
let currentViewGeneration = 0;
let focusedController: AbortController | undefined;
export async function loadFocusedSession(sid: string) {
  focusedController?.abort();
  if (!sid || history.list.some(row => String(row.id) === sid)) return;
  const controller = new AbortController(); focusedController = controller;
  const origin = serverUrl.value, credential = token.value;
  try {
    const page = await querySessions({ limit: 1, archived: 'all', ids: [Number(sid)] }, controller.signal);
    if (controller.signal.aborted || sid !== chat.session || origin !== serverUrl.value || credential !== token.value) return;
    const row = page.sessions[0];
    if (row) { mergeIntoList([applyPinOverlay(row)]); chat.title = sessionTitle(row); }
  } catch (error: any) {
    if (!controller.signal.aborted && sid === chat.session && origin === serverUrl.value && credential === token.value) history.status = error.message;
  }
}

function currentSidebarQuery(limit = 50, cursor?: string | null): SessionsQueryOptions {
  const opts: SessionsQueryOptions = {
    limit,
    archived: history.archived ? "1" : "0",
  };
  const q = history.query.trim();
  if (q) {
    opts.q = q;
  } else {
    const drill = history.drill ?? (history.projects.some(p => !p.general) ? null : 'none');
    if (drill === null) return opts;
    opts.project = drill === "none" ? "none" : Number(drill);
    if (history.worker !== "all") {
      opts.worker = history.worker;
    }
  }
  if (cursor) opts.cursor = cursor;
  return opts;
}

/** Resets/revalidates currently loaded window with bounded reads; preserves loaded window depth up to max(50, history.rows.length). */
export async function loadSessions(): Promise<void> {
  const origin = serverUrl.value, credential = token.value;
  if (inFlightSessions && inFlightSessions.origin === origin && inFlightSessions.credential === credential) {
    return inFlightSessions.promise;
  }

  // Abort any previous sidebar window reads
  sidebarController?.abort();
  moreController?.abort();
  history.loadingMore = false;
  const controller = new AbortController();
  sidebarController = controller;

  const viewGen = currentViewGeneration;
  const task = (async () => {
    const request = ++historyRequest;
    history.loading = true;
    history.error = "";

    try {
      const q = history.query.trim();
      const inDrill = history.drill !== null;
      const namedProjects = history.projects.filter(p => !p.general);
      const isOverview = !q && !inDrill && namedProjects.length > 0;

      // Preserve current loaded depth: fetch up to targetRows in pages of <= 100
      const targetRows = isOverview ? 50 : Math.max(50, history.rows.length);
      const accumulatedSessions: SessionMeta[] = [];
      let cursor: string | null = null;
      let lastPage: SessionsPage | null = null;

      while (accumulatedSessions.length < targetRows) {
        if (controller.signal.aborted || viewGen !== currentViewGeneration) return;
        const fetchLimit = Math.min(100, targetRows - accumulatedSessions.length);
        const queryOpts: SessionsQueryOptions = isOverview
          ? { limit: fetchLimit, archived: history.archived ? "1" as const : "0" as const, cursor: cursor ?? undefined }
          : currentSidebarQuery(fetchLimit, cursor);

        const page = await querySessions(queryOpts, controller.signal);
        if (request !== historyRequest || viewGen !== currentViewGeneration || origin !== serverUrl.value || credential !== token.value) return;

        lastPage = page;
        accumulatedSessions.push(...page.sessions);
        cursor = page.nextCursor ?? null;
        if (!cursor || page.sessions.length === 0) break;
      }

      if (request !== historyRequest || viewGen !== currentViewGeneration || origin !== serverUrl.value || credential !== token.value) return;

      const sessions = accumulatedSessions.map(applyPinOverlay);

      // Update store rows, groups, total, nextCursor
      history.rows = sessions;
      if (lastPage?.groups) history.groups = lastPage.groups;
      history.total = lastPage?.total ?? sessions.length;
      history.nextCursor = cursor;
      history.error = "";

      mergeIntoList(sessions);

      for (const s of sessions) {
        const state = sessionState(s);
        if (state === "running" || state === "reviewing") {
          watchRunningIds.add(Number(s.id));
        }
      }

      // Track active notifications independently with combined notification check
      void trackActiveNotifications();

      // Verify focused conversation title & 404 using querySessions ids lookup (has full row fields)
      if (chat.session) {
        const active = sessions.find(s => String(s.id) === String(chat.session));
        if (active?.title) {
          chat.title = active.title;
        } else {
          const sid = Number(chat.session);
          if (!isNaN(sid)) {
            const page = await querySessions({ ids: [sid], archived: "all", limit: 1 }, controller.signal);
            if (request !== historyRequest || viewGen !== currentViewGeneration || origin !== serverUrl.value || credential !== token.value) return;
            if (String(sid) !== String(chat.session)) return;
            const detail = page.sessions.find(s => Number(s.id) === sid);
            if (!detail) {
              // Check 404 via single session endpoint
              const response = await api(`/v1/sessions/${sid}?limit=1`, { signal: controller.signal });
              if (request !== historyRequest || viewGen !== currentViewGeneration || origin !== serverUrl.value || credential !== token.value) return;
              if (response.status === 404 && String(sid) === String(chat.session)) {
                clearConversation();
              }
            } else {
              mergeIntoList([applyPinOverlay(detail)]);
              if (detail.title) chat.title = detail.title;
            }
          }
        }
      }
    } catch (e: any) {
      if (controller.signal.aborted || e?.name === "AbortError") return;
      if (request === historyRequest && viewGen === currentViewGeneration) {
        history.error = e.message || "Failed to load conversations";
      }
      throw e;
    } finally {
      if (request === historyRequest && viewGen === currentViewGeneration) {
        history.loading = false;
      }
    }
  })();

  const current = { origin, credential, promise: task };
  inFlightSessions = current;
  const cleanup = () => { if (inFlightSessions === current) inFlightSessions = null; };
  task.then(cleanup, cleanup);
  return task;
}

/** Paginates next 50 sessions for the current view using nextCursor. */
export async function loadMoreSessions(): Promise<void> {
  if (history.loading || history.loadingMore || !history.nextCursor) return;
  const origin = serverUrl.value, credential = token.value;
  const viewGen = currentViewGeneration;

  moreController?.abort();
  const controller = new AbortController();
  moreController = controller;

  history.loadingMore = true;
  history.status = "";

  try {
    const opts = currentSidebarQuery(50, history.nextCursor);
    const page = await querySessions(opts, controller.signal);
    if (controller.signal.aborted || moreController !== controller || viewGen !== currentViewGeneration || origin !== serverUrl.value || credential !== token.value) return;

    const sessions = page.sessions.map(applyPinOverlay);
    const seen = new Set(history.rows.map(r => String(r.id)));
    const newRows = sessions.filter(s => !seen.has(String(s.id)));
    history.rows = [...history.rows, ...newRows];
    history.nextCursor = page.nextCursor ?? null;
    if (page.groups) history.groups = page.groups;

    mergeIntoList(sessions);

    for (const s of sessions) {
      const state = sessionState(s);
      if (state === "running" || state === "reviewing") {
        watchRunningIds.add(Number(s.id));
      }
    }
    void trackActiveNotifications();
  } catch (e: any) {
    if (controller.signal.aborted || e?.name === "AbortError") return;
    if (viewGen === currentViewGeneration) {
      history.status = (e as Error).message;
    }
  } finally {
    if (moreController === controller && viewGen === currentViewGeneration) {
      history.loadingMore = false;
    }
  }
}

export function resetHistoryView() {
  history.archived = false;
  history.searchOpen = false;
  history.query = "";
  history.worker = "all";
}

// Watch view context changes: clear old private rows immediately and fetch with fences
let lastViewKey = "";
function computeViewKey() {
  const named = history.projects.filter(p => !p.general);
  const effectiveDrill = (!history.query.trim() && named.length === 0) ? "none" : history.drill;
  return JSON.stringify([
    history.archived,
    history.query.trim(),
    effectiveDrill,
    history.worker,
  ]);
}

watch([
  () => history.archived,
  () => history.query,
  () => history.drill,
  () => history.worker,
  () => history.projects.length,
], () => {
  const nextKey = computeViewKey();
  if (nextKey === lastViewKey) return;
  lastViewKey = nextKey;
  currentViewGeneration++;

  // View context changed: abort in-flight reads, reset loading terminal flags, and clear old view private rows
  sidebarController?.abort();
  moreController?.abort();
  inFlightSessions = null;
  history.loading = false;
  history.loadingMore = false;
  history.rows = [];
  history.nextCursor = null;
  history.error = "";
  void loadSessions().catch(() => {});
});

watch([serverUrl, token], () => {
  currentViewGeneration++;
  sidebarController?.abort();
  moreController?.abort();
  notificationController?.abort();
  focusedController?.abort();
  inFlightSessions = null;
  resetNotifications();
  history.list = [];
  history.rows = [];
  history.groups = {};
  history.total = 0;
  history.nextCursor = null;
  history.loading = false;
  history.loadingMore = false;
  history.error = "";
  lastViewKey = "";
}, { flush: 'sync' });

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

export async function togglePinned(s: SessionMeta): Promise<boolean> {
  const id = String(s.id), key = pinContextKey(s.id), origin = serverUrl.value, credential = token.value;
  if (pinBusy.has(key)) return false;
  pinBusy.add(key);
  const before = !!s.pinned, next = !before;
  const current = () => origin === serverUrl.value && credential === token.value;
  const set = (value: boolean) => {
    if (!current()) return;
    const row = history.list.find(row => String(row.id) === id);
    if (row) row.pinned = value;
    const sidebarRow = history.rows.find(row => String(row.id) === id);
    if (sidebarRow) sidebarRow.pinned = value;
  };
  history.status = ""; pinValues.set(key, next); set(next);
  try {
    const saved = await post<{ pinned?: boolean }>(`/v1/sessions/${s.id}/metadata`, { pinned: next }, "PATCH");
    set(!!saved.pinned);
    return true;
  } catch (e) {
    set(before);
    if (current()) history.status = (e as Error).message;
    return false;
  } finally { pinBusy.delete(key); pinValues.delete(key); }
}
export const toggleArchived = (s: SessionMeta) => act(async () => {
  await post(`/v1/sessions/${s.id}/metadata`, { archived: !s.archived }, "PATCH");
  if (!s.archived && String(chat.session) === String(s.id)) clearConversation();
});
/** Cancel the automatic continuation scheduled after a usage limit. */
export const cancelLimitWait = (s: SessionMeta) =>
  act(() => json(`/v1/sessions/${s.id}/limit-wait`, { method: "DELETE" }));
/** Local time of a scheduled continuation; the date appears only when it is not today. */
export function resumeLabel(at: number, now = Date.now(), exact = true) {
  const d = new Date(at), sameDay = d.toDateString() === new Date(now).toDateString();
  return (exact ? "Retry after " : "Estimated retry ") + (sameDay ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " ")
    + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
/** Asks for confirmation (native dialog), then deletes the conversation and its children. */
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
