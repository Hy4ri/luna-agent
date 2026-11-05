import { formatFileSize } from "./files";
// `@` completion sources. Each source owns a token namespace (`@session:<id>`, later `@file:<path>`), so a new
// kind of mention only needs a new entry in `mentionSources`; the composer renders every source as one group.
import { reactive, watch } from "vue";
import { json, serverUrl, token } from "@/lib/api";
import { history, projectName, sessionTitle, querySessions } from "@/stores/sessions";
import type { SessionMeta } from "@/lib/types";

export type MentionItem = {
  /** Unique within the source; used for keys and data attributes. */
  key: string;
  /** Inserted text, without a trailing space. */
  token: string;
  label: string;
  /** Secondary text, such as the project name. */
  detail?: string;
  /** Right-aligned short text, such as a relative time. */
  meta?: string;
  /** A directory: selecting it inserts `…/` and keeps the list open to browse deeper. */
  dir?: boolean;
};
/** Where `@` completion looks. A saved session names itself; a draft chat names its machine and project. */
export type MentionContext = { session: string | null; worker?: number | null; project?: number | null; cwd?: string };
export type MentionFeedback = { message: string; retry?: () => void };
export interface MentionSource {
  id: string;
  /** Group header. */
  label: string;
  /** Typed text after `@`, with this source's own `prefix:` already removed. */
  search(query: string, ctx: MentionContext): MentionItem[];
  /** Async sources fetch here when the typed query changes; `search` then reads the result. */
  refresh?(query: string, ctx: MentionContext): void;
  feedback?(query: string, ctx: MentionContext): MentionFeedback | undefined;
  /** Token namespace, for example `session`. */
  prefix: string;
}

export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const MAX_ROWS = 20;
// Session completion searches beyond the loaded sidebar page. Archived rows remain excluded.
const sessions = reactive({ items: [] as SessionMeta[], loading: false, error: '' });
let sessionKey = '', sessionRead: AbortController | undefined;
watch([serverUrl, token, () => history.groups], () => {
  sessionRead?.abort(); sessionKey = ''; sessions.items = []; sessions.loading = false; sessions.error = '';
}, { flush: 'sync' });
const sessionSource: MentionSource = {
  id: "sessions",
  label: "Sessions",
  prefix: "session",
  refresh(query, ctx) {
    const q = query.trim();
    const key = JSON.stringify([serverUrl.value, token.value, q, ctx.session]);
    if (key === sessionKey) return;
    sessionKey = key;
    sessionRead?.abort();
    const controller = new AbortController();
    sessionRead = controller;
    sessions.items = []; sessions.loading = true; sessions.error = '';
    void querySessions({ limit: 50, archived: '0', q }, controller.signal).then(page => {
      if (sessionKey === key && !controller.signal.aborted) sessions.items = page.sessions;
    }).catch((error: Error) => {
      if (sessionKey === key && !controller.signal.aborted) sessions.error = error.message || 'Session search failed.';
    }).finally(() => {
      if (sessionKey === key && !controller.signal.aborted) sessions.loading = false;
    });
  },
  feedback(query, ctx) {
    if (sessions.loading) return { message: 'Loading conversations…' };
    if (sessions.error) return { message: sessions.error, retry: () => { sessionKey = ''; sessionSource.refresh!(query, ctx); } };
  },
  search(_query, { session }) {
    return sessions.items
      .filter(s => !s.archived && String(s.id) !== String(session ?? ""))
      .sort((a, b) => (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) || Number(b.id) - Number(a.id))
      .slice(0, MAX_ROWS)
      .map(s => ({
        key: String(s.id),
        token: `@session:${s.id}`,
        label: sessionTitle(s),
        detail: projectName(s.project ?? null),
        meta: ago(s.lastActivity ?? s.createdAt),
      }));
  },
};

// Files on the session's execution machine. The default list is its working directory; a typed `~/x/`, `/x/` or `../`
// path lists that directory instead. The server does the listing, so remote workers work the same way.
const files = reactive({ items: [] as MentionItem[], key: "" });
let fileTicket = 0, fileTimer: ReturnType<typeof setTimeout> | undefined;
const fileSource: MentionSource = {
  id: "files",
  label: "Files",
  prefix: "file",
  search: () => files.items,
  refresh(query, ctx) {
    const params = new URLSearchParams({ q: query });
    if (ctx.session) params.set("session", ctx.session);
    else {
      if (ctx.worker != null) params.set("worker", String(ctx.worker));
      if (ctx.project != null) params.set("project", String(ctx.project));
      if (ctx.cwd) params.set("cwd", ctx.cwd);
    }
    const key = params.toString();
    if (key === files.key) return;
    const ticket = ++fileTicket;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(async () => {
      try {
        const r = await json<{ entries: { name: string; path: string; kind: string; size: number }[] }>(`/v1/files?${key}`);
        if (ticket !== fileTicket) return;
        files.items = r.entries.map(e => ({
          key: e.path,
          token: `@file:${e.path}${e.kind === "directory" ? "/" : ""}`,
          label: e.name + (e.kind === "directory" ? "/" : ""),
          dir: e.kind === "directory",
          ...(e.kind === "file" ? { meta: formatFileSize(e.size) } : {}),
        }));
        files.key = key;
      } catch {
        if (ticket === fileTicket) { files.items = []; files.key = key; }
      }
    }, 120);
  },
};

const mentionSources: MentionSource[] = [sessionSource, fileSource];

/** Groups for the typed query. `@session:4` searches only that source; a bare query searches every source. */
export function searchMentions(raw: string, ctx: MentionContext) {
  const colon = raw.indexOf(":");
  const scoped = colon > 0 ? mentionSources.find(s => s.prefix === raw.slice(0, colon).toLowerCase()) : undefined;
  const sources = scoped ? [scoped] : mentionSources;
  const query = scoped ? raw.slice(colon + 1) : raw;
  for (const source of sources) source.refresh?.(query, ctx);
  return sources.map(source => ({ source, items: source.search(query, ctx), feedback: source.feedback?.(query, ctx) }))
    .filter(g => g.items.length || g.feedback);
}
