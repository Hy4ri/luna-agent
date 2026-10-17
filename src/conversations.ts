// pi-durable 1.2 has no delete operation. Keep its SQLite-specific purge here, on the harness mutation line.
import type { DatabaseSync } from "node:sqlite";
import { defineDoc, defineDocFamily, type ConversationRecord, type DocumentRecord, type Tx } from "@earendil-works/pi-durable";
import { conversationStorage } from "./conversation-storage.js";
import { context } from "./luna.js";
import type { RecallIndex } from "./recall.js";
type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type ConversationMeta = { title: string | null; archived: boolean; pinned: boolean };
export class ConversationError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}
export class ConversationStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly harness: Harness, private readonly recall?: RecallIndex) {
    this.db = conversationStorage(harness).db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS luna_conversations (
        id INTEGER PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
      ) STRICT;`);
  }
  subscribeChanges(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private notify() {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch {}
    }
  }
  get(id: number): ConversationMeta {
    const row = this.db.prepare("SELECT title, archived, pinned FROM luna_conversations WHERE id=?").get(id) as { title: string | null; archived: number; pinned: number } | undefined;
    return { title: row?.title ?? null, archived: !!row?.archived, pinned: !!row?.pinned };
  }
  async update(id: number, changes: Partial<ConversationMeta>) {
    const res = await this.harness.commit(async tx => {
      if (!await tx.conversation(id as never)) throw new ConversationError(404, "no such session");
      const next = { ...this.get(id), ...changes };
      this.db.prepare(`INSERT INTO luna_conversations(id,title,archived,pinned) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,archived=excluded.archived,pinned=excluded.pinned`)
        .run(id, next.title, Number(next.archived), Number(next.pinned));
      return next;
    }, context);
    this.notify();
    return res;
  }
  async delete(id: number) {
    // A busy conversation must be stopped first. Do not race an invocation that can still write its result.
    const store = conversationStorage(this.harness);
    let pendingPurge: (() => void) | undefined;
    try { return await this.harness.commit(async tx => {
      if (!await tx.conversation(id as never)) throw new ConversationError(404, "no such session");
      // Forks inherit their ancestors' entries. Purge descendants too, so no fork refers to removed history.
      const records = this.db.prepare("SELECT record FROM conversations").all() as { record: string }[];
      const conversations = records.map(r => JSON.parse(r.record) as ConversationRecord);
      const delegates = this.db.prepare("SELECT conversation_id AS id, json_extract(record, '$.data.parent') AS parent FROM entries WHERE json_extract(record, '$.kind')='delegate.child'").all() as { id: number; parent: number }[];
      const selected = new Set([id]);
      let size;
      do {
        size = selected.size;
        for (const c of conversations) if ((c.parent && selected.has(c.parent.conversationId)) || (c.owner && selected.has(c.owner.conversationId))) selected.add(c.id);
        for (const child of delegates) if (selected.has(child.parent)) selected.add(child.id);
      } while (size !== selected.size);
      const ids = [...selected];
      // Use a temp table instead of a SQL variable limit for large child trees.
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS purge_conversations(id INTEGER PRIMARY KEY); DELETE FROM purge_conversations;");
      const add = this.db.prepare("INSERT INTO purge_conversations VALUES (?)"); for (const n of ids) add.run(n);
      const busy = this.db.prepare("SELECT id FROM tasks WHERE conversation_id IN (SELECT id FROM purge_conversations) AND status <> 'terminal' LIMIT 1").get();
      if (busy) throw new ConversationError(409, "Stop the conversation and its child tasks before deleting it.");
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS purge_tasks(id INTEGER PRIMARY KEY); DELETE FROM purge_tasks;
        INSERT INTO purge_tasks SELECT id FROM tasks WHERE conversation_id IN (SELECT id FROM purge_conversations);
        CREATE TEMP TABLE IF NOT EXISTS purge_documents(id INTEGER PRIMARY KEY); DELETE FROM purge_documents;
        INSERT INTO purge_documents SELECT id FROM documents WHERE
          (scope_kind='conversation' AND owner_id IN (SELECT id FROM purge_conversations)) OR
          (scope_kind='task' AND owner_id IN (SELECT id FROM purge_tasks));
      `);
      const docs = this.db.prepare("SELECT record FROM documents WHERE id IN (SELECT id FROM purge_documents) AND retired_at IS NULL").all() as { record: string }[];
      for (const row of docs) await retireDocument(tx, JSON.parse(row.record) as DocumentRecord);
      const purge = () => this.db.exec(`
        DELETE FROM record_ids WHERE id IN (SELECT id FROM purge_documents)
          OR id IN (SELECT id FROM entries WHERE conversation_id IN (SELECT id FROM purge_conversations))
          OR id IN (SELECT id FROM submissions WHERE conversation_id IN (SELECT id FROM purge_conversations))
          OR id IN (SELECT id FROM purge_tasks) OR id IN (SELECT id FROM purge_conversations);
        DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM purge_documents);
        DELETE FROM documents WHERE id IN (SELECT id FROM purge_documents);
        DELETE FROM submissions WHERE conversation_id IN (SELECT id FROM purge_conversations);
        DELETE FROM entries WHERE conversation_id IN (SELECT id FROM purge_conversations);
        DELETE FROM tasks WHERE id IN (SELECT id FROM purge_tasks);
        DELETE FROM luna_conversations WHERE id IN (SELECT id FROM purge_conversations);
        DELETE FROM conversations WHERE id IN (SELECT id FROM purge_conversations);
        DELETE FROM purge_documents; DELETE FROM purge_tasks; DELETE FROM purge_conversations;
        `);
      if (docs.length) { pendingPurge = purge; store.afterWrite = purge; }
      else {
        // A raw conversation can have no documents, hence no storage commit to attach the purge to.
        this.db.exec("BEGIN IMMEDIATE");
        try { purge(); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
      }
      return ids;
    }, context).then(ids => { this.recall?.forget(ids); this.notify(); return ids; });
    } finally { if (store.afterWrite === pendingPurge) store.afterWrite = undefined; }
  }
}

// Retire each current document through the public API, so attached observers and cached snapshots are invalidated.
async function retireDocument(tx: Tx, record: DocumentRecord) {
  if (record.scope.kind === "session") return;
  const semantics = record.scope.kind === "conversation"
    ? { scope: "conversation" as const, history: record.history!, fork: record.fork! }
    : { scope: "task" as const };
  // Retirement uses address/semantics only; it neither loads nor migrates the value.
  const definition = { kind: record.kind, version: 1, ...semantics, initial: () => ({}) };
  const owner = record.scope.kind === "conversation" ? record.scope.conversationId : record.scope.taskId;
  if (record.key !== undefined) {
    const token = defineDocFamily({ ...definition, family: true } as never);
    await tx.retireDoc(token as never, owner as never, record.key);
  } else await tx.retireDoc(defineDoc(definition as never) as never, owner as never);
}
