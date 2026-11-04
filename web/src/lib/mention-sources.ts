// `@` completion sources. Each source owns a token namespace (`@session:<id>`, later `@file:<path>`), so a new
// kind of mention only needs a new entry in `mentionSources`; the composer renders every source as one group.
import { reactive } from "vue";
import { json } from "@/lib/api";
import { history, projectName, sessionTitle } from "@/stores/sessions";

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
export interface MentionSource {
  id: string;
  /** Group header. */
  label: string;
  /** Typed text after `@`, with this source's own `prefix:` already removed. */
  search(query: string, ctx: MentionContext): MentionItem[];
  /** Async sources fetch here when the typed query changes; `search` then reads the result. */
  refresh?(query: string, ctx: MentionContext): void;
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
// The sidebar list already excludes subagent children. Archived sessions stay out of the menu; type the id to use one.
const sessionSource: MentionSource = {
  id: "sessions",
  label: "Sessions",
  prefix: "session",
  search(query, { session }) {
    const q = query.trim().toLowerCase();
    return history.list
      .filter(s => !s.archived && String(s.id) !== String(session ?? ""))
      .filter(s => !q || String(s.id).startsWith(q) || sessionTitle(s).toLowerCase().includes(q))
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
          ...(e.kind === "file" ? { meta: size(e.size) } : {}),
        }));
        files.key = key;
      } catch {
        if (ticket === fileTicket) { files.items = []; files.key = key; }
      }
    }, 120);
  },
};
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const mentionSources: MentionSource[] = [sessionSource, fileSource];

/** Groups for the typed query. `@session:4` searches only that source; a bare query searches every source. */
export function searchMentions(raw: string, ctx: MentionContext) {
  const colon = raw.indexOf(":");
  const scoped = colon > 0 ? mentionSources.find(s => s.prefix === raw.slice(0, colon).toLowerCase()) : undefined;
  const sources = scoped ? [scoped] : mentionSources;
  const query = scoped ? raw.slice(colon + 1) : raw;
  for (const source of sources) source.refresh?.(query, ctx);
  return sources.map(source => ({ source, items: source.search(query, ctx) })).filter(g => g.items.length);
}
