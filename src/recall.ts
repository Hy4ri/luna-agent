// `session_search`: a port of @henryqw/pi-session-recall (MIT, the most-downloaded Pi session-search package).
// Same model: a local SQLite FTS5 index (trigram tokenizer, BM25 ranking, `[match]` snippets) over past conversations,
// with discovery, scroll and read modes. Source is Luna's durable store instead of Pi's JSONL files; the index is a
// separate file (<dataDir>/recall.db) synced incrementally from new entries on each call. The pattern-miner mode is
// Pi-specific and not ported.
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineExtension, defineTool, type EntryRecord, type Tx } from "@earendil-works/pi-durable";

const HEAD = 6000, TAIL = 2000, PAGE = 200;

type Msg = { role?: string; content?: unknown; timestamp?: number; toolName?: string };

/** Searchable text of one model message: user/assistant text, tool calls by name, tool results (capped by the split). */
export function messageText(m: Msg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const b of c as { type?: string; text?: string; name?: string; arguments?: unknown }[]) {
    if (b.type === "text" && b.text) parts.push(b.text);
    else if (b.type === "toolCall") parts.push(`[tool ${b.name}] ${JSON.stringify(b.arguments ?? {}).slice(0, 400)}`);
  }
  return parts.join("\n");
}

export class RecallIndex {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS convs (id INTEGER PRIMARY KEY, title TEXT, started INTEGER, last_entry INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (
        rowid INTEGER PRIMARY KEY, conv INTEGER NOT NULL, entry INTEGER NOT NULL UNIQUE, role TEXT NOT NULL,
        ts INTEGER, head TEXT NOT NULL, tail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, entry);
      CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(head, tail, content='messages', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO recall_fts(rowid, head, tail) VALUES (new.rowid, new.head, new.tail); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO recall_fts(recall_fts, rowid, head, tail) VALUES ('delete', old.rowid, old.head, old.tail); END;
    `);
  }
  close() { this.db.close(); }
  private stored?: (id: number) => string | null;
  /** Prefer stored session titles (user renames, generated titles) over the first-message fallback. */
  titles(resolve: (id: number) => string | null) { this.stored = resolve; }
  private title(id: number, fallback: string | null) {
    try { return this.stored?.(id) ?? fallback; } catch { return fallback; }
  }

  /** Remove both the text rows and their FTS entries. Safe to repeat after a crash. */
  forget(ids: number[]) {
    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        this.db.prepare("DELETE FROM messages WHERE conv=?").run(id);
        this.db.prepare("DELETE FROM convs WHERE id=?").run(id);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Index entries newer than the last indexed one, conversation by conversation. Returns the number of new messages. */
  async sync(tx: Tx): Promise<number> {
    const last = new Map((this.db.prepare("SELECT id, last_entry FROM convs").all() as { id: number; last_entry: number }[]).map((r) => [r.id, r.last_entry]));
    const ins = this.db.prepare("INSERT OR IGNORE INTO messages(conv, entry, role, ts, head, tail) VALUES (?,?,?,?,?,?)");
    const upConv = this.db.prepare("INSERT INTO convs(id, title, started, last_entry) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_entry=excluded.last_entry, title=COALESCE(convs.title, excluded.title), started=COALESCE(convs.started, excluded.started)");
    const present = new Set<number>();
    let added = 0;
    let cur;
    do {
      const page = await tx.scanConversations({ order: "ascending" }, PAGE, cur);
      for (const c of page.items) {
        present.add(c.id as number);
        const from = last.get(c.id as number) ?? 0;
        let ecur, max = from, title: string | null = null, started: number | null = null;
        do {
          const ep = await tx.scanEntries({ conversationId: c.id, order: "ascending", ...(from ? { minEntryId: (from + 1) as never } : {}) }, PAGE, ecur);
          this.db.exec("BEGIN");
          try {
            for (const e of ep.items as EntryRecord[]) {
              max = Math.max(max, e.id as number);
              if (e.conversationId !== c.id) continue; // a fork's inherited entries are indexed under their own conversation
              for (const m of (e.model ?? []) as Msg[]) {
                if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") continue;
                const text = m.role === "toolResult" ? `[result ${m.toolName ?? ""}] ${messageText(m)}` : messageText(m);
                if (!text.trim()) continue;
                if (m.role === "user" && title === null) { title = text.replace(/\s+/g, " ").slice(0, 80); started = m.timestamp ?? null; }
                const head = text.length > HEAD + TAIL ? text.slice(0, HEAD) : text, tail = text.length > HEAD + TAIL ? text.slice(-TAIL) : "";
                added += Number(ins.run(c.id as number, e.id as number, m.role, m.timestamp ?? null, head, tail).changes);
                break; // one row per entry: an entry carries one message
              }
            }
            this.db.exec("COMMIT");
          } catch (err) { this.db.exec("ROLLBACK"); throw err; }
          ecur = ep.next;
        } while (ecur);
        if (max !== from || !last.has(c.id as number)) upConv.run(c.id as number, title, started, max);
      }
      cur = page.next;
    } while (cur);
    this.forget([...last.keys()].filter(id => !present.has(id)));
    return added;
  }

  /** BM25 discovery; at most 2 hits per conversation. Terms shorter than 3 characters fall back to LIKE. */
  search(query: string, opts: { exclude?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
    const terms = query.match(/"[^"]+"|\S+/g) ?? [];
    const operators = /^(AND|OR|NOT|NEAR)$/;
    const short = terms.some((t) => !operators.test(t) && t.replace(/"/g, "").length < 3);
    type Row = { conv: number; entry: number; role: string; ts: number | null; snip: string; title: string | null };
    let rows: Row[];
    if (!short) {
      const fts = terms.map((t) => (operators.test(t) || t.startsWith('"') ? t : `"${t.replace(/"/g, "")}"`)).join(" ");
      rows = this.db.prepare(`
        WITH m AS (
          SELECT msg.conv, msg.entry, msg.role, msg.ts, snippet(recall_fts, -1, '[', ']', '…', 16) AS snip, bm25(recall_fts) AS score
          FROM recall_fts JOIN messages msg ON msg.rowid = recall_fts.rowid
          WHERE recall_fts MATCH ? AND (? IS NULL OR msg.conv <> ?)),
        r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY conv ORDER BY score) rn FROM m)
        SELECT r.conv, r.entry, r.role, r.ts, r.snip, c.title FROM r LEFT JOIN convs c ON c.id = r.conv
        WHERE rn <= 2 ORDER BY score LIMIT ?`).all(fts, opts.exclude ?? null, opts.exclude ?? null, limit) as Row[];
    } else {
      const words = terms.map((t) => t.replace(/"/g, "")).filter((t) => !operators.test(t));
      const where = words.map(() => "(lower(head) LIKE ? OR lower(tail) LIKE ?)").join(" AND ");
      const args = words.flatMap((w) => [`%${w.toLowerCase()}%`, `%${w.toLowerCase()}%`]);
      rows = (this.db.prepare(`SELECT m.conv, m.entry, m.role, m.ts, m.head AS snip, c.title FROM messages m LEFT JOIN convs c ON c.id = m.conv
        WHERE ${where || "1"} AND (? IS NULL OR m.conv <> ?) ORDER BY m.entry DESC LIMIT ?`).all(...args, opts.exclude ?? null, opts.exclude ?? null, limit) as Row[])
        .map((r) => { const i = r.snip.toLowerCase().indexOf(words[0]!.toLowerCase()); return { ...r, snip: (i > 60 ? "…" : "") + r.snip.slice(Math.max(0, i - 60), Math.max(0, i - 60) + 160) + "…" }; });
    }
    return rows.map((r) => ({ ...r, title: this.title(r.conv, r.title) }));
  }

  browse(limit = 5, exclude?: number) {
    return (this.db.prepare("SELECT id, title, started FROM convs WHERE title IS NOT NULL AND (? IS NULL OR id <> ?) ORDER BY id DESC LIMIT ?")
      .all(exclude ?? null, exclude ?? null, Math.min(Math.max(limit, 1), 10)) as { id: number; title: string; started: number | null }[])
      .map((c) => ({ ...c, title: this.title(c.id, c.title)! }));
  }

  messages(conv: number, around?: number, window = 5) {
    type Row = { entry: number; role: string; ts: number | null; head: string; tail: string };
    const all = this.db.prepare("SELECT entry, role, ts, head, tail FROM messages WHERE conv = ? ORDER BY entry").all(conv) as Row[];
    if (around === undefined) return { rows: all.length > 30 ? [...all.slice(0, 20), ...all.slice(-10)] : all, total: all.length, omitted: Math.max(0, all.length - 30) };
    const i = all.findIndex((r) => r.entry === around);
    if (i < 0) return { rows: [], total: all.length, omitted: 0 };
    const w = Math.min(Math.max(window, 1), 20);
    return { rows: all.slice(Math.max(0, i - w), i + w + 1), total: all.length, omitted: 0 };
  }
}

const when = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "?");
const MAX_OUT = 50_000;

const DESCRIPTION = [
  "Search past Luna conversations with a local full-text index; returns snippets and message ids.",
  "- `query`: discover matches (BM25). Prefer distinctive identifiers or uncommon terms; multi-word queries are AND. Use OR/NOT for Boolean queries and quotes for exact phrases.",
  "- `sessionId` + `aroundMessageId`: scroll ±`window` messages around a hit. `sessionId` alone: read the conversation (head 20 + tail 10). No arguments: browse recent conversations.",
  "Use it only when the user asks about past conversations, earlier decisions, or repeated work not in the current conversation; not for the current conversation or ordinary file inspection.",
].join("\n");

export function createRecallExtension(index: RecallIndex) {
  return defineExtension({
    name: "recall",
    tools: [
      defineTool({
        name: "session_search",
        description: DESCRIPTION,
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search query (discovery). FTS5 syntax supported." })),
          sessionId: Type.Optional(Type.Number({ description: "Conversation id to read or scroll." })),
          aroundMessageId: Type.Optional(Type.Number({ description: "Message id from a discovery hit to scroll around." })),
          window: Type.Optional(Type.Number({ description: "Messages each side when scrolling (1-20, default 5)." })),
          limit: Type.Optional(Type.Number({ description: "Results for discovery/browse (1-10, default 5)." })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          await api.commit((tx) => index.sync(tx), context);
          const me = api.conversationId as number;
          const text = (t: string) => ({ output: [{ type: "text" as const, text: t.length > MAX_OUT ? t.slice(0, MAX_OUT) + "\n[truncated]" : t }] });
          if (args.query?.trim()) {
            let rows;
            try { rows = index.search(args.query.trim(), { exclude: me, limit: args.limit }); }
            catch (e) { return { ...text(`Invalid query: ${(e as Error).message}. Quote terms or simplify the query.`), isError: true }; }
            if (!rows.length) return text(`No matches for ${JSON.stringify(args.query)}.`);
            return text(rows.map((r) => `session ${r.conv} · message ${r.entry} · ${r.role} · ${when(r.ts)}${r.title ? ` · "${r.title}"` : ""}\n  ${r.snip.replace(/\s+/g, " ")}`).join("\n")
              + "\n\nScroll with {sessionId, aroundMessageId}.");
          }
          if (args.sessionId !== undefined) {
            const r = index.messages(args.sessionId, args.aroundMessageId, args.window);
            if (!r.rows.length) return { ...text(args.aroundMessageId !== undefined ? `Message ${args.aroundMessageId} not found in session ${args.sessionId}.` : `Session ${args.sessionId} has no indexed messages.`), isError: true };
            const body = r.rows.map((m, i) => {
              const gap = r.omitted && i === 20 ? `… ${r.omitted} messages omitted …\n` : "";
              const content = m.tail ? `${m.head}\n…[middle omitted]…\n${m.tail}` : m.head;
              return `${gap}[${m.entry}] ${m.role} ${when(m.ts)}${m.entry === args.aroundMessageId ? " ◀" : ""}\n${content.length > 4000 ? content.slice(0, 4000) + "…" : content}`;
            }).join("\n\n");
            return text(`session ${args.sessionId} (${r.total} messages)\n\n${body}`);
          }
          const list = index.browse(args.limit, me);
          return text(list.length ? list.map((c) => `session ${c.id} · ${when(c.started)} · ${c.title}`).join("\n") : "No past conversations indexed.");
        },
      }),
    ],
  });
}
