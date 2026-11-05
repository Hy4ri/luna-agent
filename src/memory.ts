// Durable long-term memory: SQLite store of facts (keyed, upserted) and notes (free-form),
// a compacted system-prompt section, and remember/recall/forget tools.
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { Type } from "typebox";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export type Kind = "fact" | "note" | "digest";
export interface MemoryRow {
  id: number;
  kind: Kind;
  key: string | null;
  content: string;
  tags: string;
  created: number;
  updated: number;
  archived: number;
}

export interface MemoryOptions {
  /** Max chars of the injected prompt section (default 8000). It also holds user facts; no USER.md exists. */
  budget?: number;
  /** Live (unarchived) notes kept before the oldest are folded into the digest (default 40). */
  maxNotes?: number;
}

export class MemoryStore {
  readonly db: DatabaseSync;
  readonly budget: number;
  readonly maxNotes: number;

  constructor(path: string, opts: MemoryOptions = {}) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.budget = opts.budget ?? 8000;
    this.maxNotes = opts.maxNotes ?? 40;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('fact','note','digest')),
        key TEXT,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_fact_key ON memory(key) WHERE kind = 'fact' AND archived = 0;
      CREATE TABLE IF NOT EXISTS memory_provenance (key TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_history (id INTEGER PRIMARY KEY, key TEXT NOT NULL, before_text TEXT, after_text TEXT, created INTEGER NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  /** Facts with a key upsert (same key replaces); notes always append. Returns the row. */
  remember(input: { content: string; kind?: "fact" | "note"; key?: string; tags?: string[] }): MemoryRow {
    const content = input.content.trim();
    if (!content) throw new Error("content is empty");
    const kind = input.kind ?? (input.key ? "fact" : "note");
    if (kind === "fact" && !input.key?.trim()) throw new Error("a fact needs a key (e.g. 'printer.ip')");
    const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).join(",");
    const now = Date.now();
    let row: MemoryRow;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = kind === "fact" ? this.factSnapshot(input.key!.trim()) : null;
      if (kind === "fact") {
        const key = input.key!.trim();
        const existing = this.db.prepare("SELECT id FROM memory WHERE kind='fact' AND archived=0 AND key=?").get(key) as
          | { id: number }
          | undefined;
        if (existing) {
          this.db.prepare("UPDATE memory SET content=?, tags=?, updated=? WHERE id=?").run(content, tags, now, existing.id);
          row = this.get(existing.id)!;
        } else {
          const r = this.db
            .prepare("INSERT INTO memory(kind,key,content,tags,created,updated) VALUES('fact',?,?,?,?,?)")
            .run(key, content, tags, now, now);
          row = this.get(Number(r.lastInsertRowid))!;
        }
      } else {
        const r = this.db
          .prepare("INSERT INTO memory(kind,key,content,tags,created,updated) VALUES('note',NULL,?,?,?,?)")
          .run(content, tags, now, now);
        row = this.get(Number(r.lastInsertRowid))!;
      }
      if (kind === "fact") {
        this.db.prepare("DELETE FROM memory_provenance WHERE key=?").run(input.key!.trim());
        this.db.prepare("INSERT INTO memory_history(key,before_text,after_text,created) VALUES(?,?,?,?)")
          .run(input.key!.trim(),before,this.factSnapshot(input.key!.trim()),now);
      }
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
    this.compact();
    return row;
  }

  /** Exact snapshot includes metadata, so a concurrent fact edit invalidates a pending learning proposal. */
  factSnapshot(key: string): string | null {
    const row = this.db.prepare("SELECT * FROM memory WHERE kind='fact' AND key=? AND archived=0").get(key) as unknown as MemoryRow | undefined;
    if (!row) return null;
    const meta = this.db.prepare("SELECT metadata FROM memory_provenance WHERE key=?").get(key) as { metadata: string } | undefined;
    return JSON.stringify({ row, metadata: meta ? JSON.parse(meta.metadata) : null });
  }

  changeFact(key: string, expected: string | null, content: string, metadata: Record<string, unknown>): string {
    if (!key.trim() || !content.trim() || metadata.domain !== "global") throw new Error("learning memory requires a keyed global fact");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.factSnapshot(key) !== expected) throw new Error("memory changed since proposal; no overwrite performed");
      const now = Date.now();
      const old = expected ? JSON.parse(expected).row as MemoryRow : undefined;
      if (old) this.db.prepare("UPDATE memory SET content=?,updated=? WHERE id=?").run(content.trim(), Math.max(now,old.updated+1),old.id);
      else this.db.prepare("INSERT INTO memory(kind,key,content,tags,created,updated) VALUES('fact',?,?,'lesson',?,?)").run(key,content.trim(),now,now);
      this.db.prepare("INSERT INTO memory_provenance(key,metadata) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET metadata=excluded.metadata").run(key,JSON.stringify(metadata));
      const after = this.factSnapshot(key)!;
      this.db.prepare("INSERT INTO memory_history(key,before_text,after_text,created) VALUES(?,?,?,?)").run(key,expected,after,now);
      this.db.exec("COMMIT");
      return after;
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }

  restoreFact(key: string, expected: string, before: string | null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.factSnapshot(key) !== expected) throw new Error("memory changed after apply; rollback refused");
      const old = before ? JSON.parse(before) as { row: MemoryRow; metadata: unknown } : null;
      this.db.prepare("DELETE FROM memory WHERE kind='fact' AND key=? AND archived=0").run(key);
      this.db.prepare("DELETE FROM memory_provenance WHERE key=?").run(key);
      if (old) {
        const r = old.row;
        this.db.prepare("INSERT INTO memory(id,kind,key,content,tags,created,updated,archived) VALUES(?,?,?,?,?,?,?,?)")
          .run(r.id,r.kind,r.key,r.content,r.tags,r.created,r.updated,r.archived);
        if (old.metadata) this.db.prepare("INSERT INTO memory_provenance(key,metadata) VALUES(?,?)").run(key,JSON.stringify(old.metadata));
      }
      this.db.prepare("INSERT INTO memory_history(key,before_text,after_text,created) VALUES(?,?,?,?)").run(key,expected,before,Date.now());
      this.db.exec("COMMIT");
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }

  get(id: number): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memory WHERE id=?").get(id) as MemoryRow | undefined;
  }

  forget(id: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.get(id);
      if (row?.key) {
        this.db.prepare("DELETE FROM memory_provenance WHERE key=?").run(row.key);
        this.db.prepare("DELETE FROM memory_history WHERE key=?").run(row.key);
      }
      const removed = Number(this.db.prepare("DELETE FROM memory WHERE id=?").run(id).changes) > 0;
      this.db.exec("COMMIT");
      return removed;
    } catch(e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Search live rows by whitespace-separated terms (all must match content/key/tags). Empty query: most recent. */
  recall(query = "", opts: { kind?: Kind; limit?: number; includeArchived?: boolean } = {}): MemoryRow[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.includeArchived) where.push("archived=0", "kind<>'digest'");
    if (opts.kind) (where.push("kind=?"), params.push(opts.kind));
    for (const t of terms) {
      where.push("(lower(content) LIKE ? ESCAPE '\\' OR lower(coalesce(key,'')) LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      const p = `%${t.replace(/[\\%_]/g, "\\$&")}%`;
      params.push(p, p, p);
    }
    const sql = `SELECT * FROM memory ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated DESC, id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, Math.min(opts.limit ?? 10, 50)) as unknown as MemoryRow[];
  }

  /**
   * Fold the oldest live notes beyond `maxNotes` into one digest row (one truncated line each) and archive
   * the originals. Archived rows stay searchable with includeArchived. Returns the number folded.
   */
  compact(): number {
    const notes = this.db
      .prepare("SELECT * FROM memory WHERE kind='note' AND archived=0 ORDER BY created ASC, id ASC")
      .all() as unknown as MemoryRow[];
    const excess = notes.length - this.maxNotes;
    if (excess <= 0) return 0;
    // fold in batches of at least a quarter of the cap, so we don't rewrite the digest on every insert
    if (excess < Math.max(1, Math.floor(this.maxNotes / 4))) return 0;
    const old = notes.slice(0, excess);
    const lines = old.map((n) => "- " + oneLine(n.content, 120));
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const digest = this.db.prepare("SELECT * FROM memory WHERE kind='digest' AND archived=0").get() as MemoryRow | undefined;
      let text = (digest ? digest.content + "\n" : "") + lines.join("\n");
      // keep the digest bounded: drop its oldest lines
      const all = text.split("\n");
      while (all.join("\n").length > this.budget / 2 && all.length > 1) all.shift();
      text = all.join("\n");
      if (digest) this.db.prepare("UPDATE memory SET content=?, updated=? WHERE id=?").run(text, now, digest.id);
      else this.db.prepare("INSERT INTO memory(kind,content,created,updated) VALUES('digest',?,?,?)").run(text, now, now);
      const mark = this.db.prepare("UPDATE memory SET archived=1 WHERE id=?");
      for (const n of old) mark.run(n.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return old.length;
  }

  /** Prompt text within `budget`: all facts first (stable order), then digest, then newest notes that fit. */
  render(): string | undefined {
    const facts = this.db
      .prepare("SELECT * FROM memory WHERE kind='fact' AND archived=0 ORDER BY key ASC")
      .all() as unknown as MemoryRow[];
    const digest = this.db.prepare("SELECT * FROM memory WHERE kind='digest' AND archived=0").get() as MemoryRow | undefined;
    const notes = this.db
      .prepare("SELECT * FROM memory WHERE kind='note' AND archived=0 ORDER BY created DESC, id DESC")
      .all() as unknown as MemoryRow[];
    if (!facts.length && !digest && !notes.length) return undefined;

    const out: string[] = [];
    let used = 0;
    const add = (line: string): boolean => {
      if (used + line.length + 1 > this.budget) return false;
      out.push(line);
      used += line.length + 1;
      return true;
    };
    let droppedFacts = 0;
    if (facts.length) {
      add("Facts:");
      for (const f of facts) {
        const p = this.db.prepare("SELECT metadata FROM memory_provenance WHERE key=?").get(f.key!) as { metadata: string } | undefined;
        const due = p ? JSON.parse(p.metadata).reviewAt : null;
        if (!add(`- ${f.key}${due && due <= Date.now() ? " [review due; verify before use]" : ""}: ${oneLine(f.content, 300)}`)) droppedFacts++;
      }
    }
    if (digest) {
      add("Older notes (digest):");
      for (const l of digest.content.split("\n")) if (!add(l)) break;
    }
    let shown = 0;
    if (notes.length) {
      add("Recent notes:");
      for (const n of notes) {
        if (!add(`- [#${n.id}] ${oneLine(n.content, 200)}`)) break;
        shown++;
      }
    }
    const hidden = notes.length - shown + droppedFacts;
    if (hidden > 0) add(`(${hidden} more entries not shown; use the recall tool)`);
    return out.join("\n");
  }
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function fmt(r: MemoryRow): string {
  const head = `#${r.id} ${r.kind}${r.key ? " " + r.key : ""}${r.archived ? " (archived)" : ""}${r.tags ? " [" + r.tags + "]" : ""}`;
  return `${head}\n${r.content}`;
}

const text = (t: string) => ({ output: [{ type: "text" as const, text: t }] });

/** Extension: `remember`, `recall`, `forget` tools plus a `memory` prompt section backed by `store`. */
export function createMemoryExtension(store: MemoryStore) {
  const remember = defineTool({
    name: "remember",
    description:
      "Save durable knowledge across sessions. With `key`, stores a fact (same key overwrites, e.g. 'user.timezone'). Without `key`, appends a free-form note.",
    parameters: Type.Object({
      content: Type.String({ description: "What to remember" }),
      key: Type.Optional(Type.String({ description: "Stable dotted key for a fact; reuse it to update the fact" })),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    // upsert by key is idempotent; note append is not, so keep default (unsafe) replay semantics
    async execute(args) {
      const r = store.remember({ content: args.content, key: args.key, tags: args.tags });
      return text(`Saved ${r.kind} #${r.id}${r.key ? " (" + r.key + ")" : ""}.`);
    },
  });
  const recall = defineTool({
    name: "recall",
    description:
      "Search saved facts and notes (all terms must match content, key or tags). Empty query lists the most recent. Set archived to also search notes folded into the digest.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      kind: Type.Optional(Type.Union([Type.Literal("fact"), Type.Literal("note")])),
      limit: Type.Optional(Type.Number({ description: "Default 10, max 50" })),
      archived: Type.Optional(Type.Boolean()),
    }),
    replay: "safe",
    async execute(args) {
      const rows = store.recall(args.query ?? "", { kind: args.kind, limit: args.limit, includeArchived: args.archived });
      return text(rows.length ? rows.map(fmt).join("\n\n") : "No matches.");
    },
  });
  const forget = defineTool({
    name: "forget",
    description: "Delete a saved fact or note by its #id (from recall or the memory section).",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(args) {
      return text(store.forget(args.id) ? `Forgot #${args.id}.` : `No memory #${args.id}.`);
    },
  });
  return defineExtension({
    name: "memory",
    tools: [remember, recall, forget],
    sections: [section("memory", () => store.render())],
  });
}
