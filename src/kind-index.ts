import type { Database } from "bun:sqlite";

export const KIND_INDEX = "luna_entries_by_conversation_kind";
export const KIND_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${KIND_INDEX} ON entries (conversation_id, json_extract(record, '$.kind'), id);`;

const ready = new WeakSet<Database>();

/** True once the kind index exists. Queries must fall back to index-free plans until then. */
export function kindIndexReady(db: Database): boolean {
  if (ready.has(db)) return true;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(KIND_INDEX)) return false;
  ready.add(db);
  return true;
}
