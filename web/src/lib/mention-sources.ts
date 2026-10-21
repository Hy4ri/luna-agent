// `@` completion sources. Each source owns a token namespace (`@session:<id>`, later `@file:<path>`), so a new
// kind of mention only needs a new entry in `mentionSources`; the composer renders every source as one group.
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
};
export interface MentionSource {
  id: string;
  /** Group header. */
  label: string;
  /** Typed text after `@`, with this source's own `prefix:` already removed. */
  search(query: string, ctx: { session: string | null }): MentionItem[];
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
export const sessionSource: MentionSource = {
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

export const mentionSources: MentionSource[] = [sessionSource];

/** Groups for the typed query. `@session:4` searches only that source; a bare query searches every source. */
export function searchMentions(raw: string, ctx: { session: string | null }) {
  const colon = raw.indexOf(":");
  const scoped = colon > 0 ? mentionSources.find(s => s.prefix === raw.slice(0, colon).toLowerCase()) : undefined;
  const sources = scoped ? [scoped] : mentionSources;
  const query = scoped ? raw.slice(colon + 1) : raw;
  return sources.map(source => ({ source, items: source.search(query, ctx) })).filter(g => g.items.length);
}
