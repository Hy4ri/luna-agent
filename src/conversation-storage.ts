// SQLite maintenance bridge for hard deletion. Pi 1.5 caches records, so purges run through the patched
// Session.maintain() barrier, which drains publications and evicts the deleted records.
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Harness } from "@earendil-works/pi-durable";
import { BunSqliteDatabase } from "./sqlite/bun-adapter.js";
export type ConversationStorage = { db: Database; adapter: BunSqliteDatabase };
const stores = new WeakMap<Harness, ConversationStorage>();
export const registerConversationStorage = (harness: Harness, store: ConversationStorage) => stores.set(harness, store);
export function conversationStorage(harness: Harness) {
  const store = stores.get(harness);
  if (!store) throw new Error("Conversation management requires Luna SQLite storage");
  return store;
}
export async function openConversationStorage(path: string) {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000;");
  // Entry records reach 3 MB. A 64 MB page cache and a 256 MB memory map cut large transcript reads by ~40%
  // (12.7 -> 7.5 ms per 100 entries). Both apply to this connection only.
  if (path !== ":memory:") db.exec("PRAGMA cache_size=-64000; PRAGMA mmap_size=268435456;");
  // Without planner statistics SQLite picks the low-selectivity tasks_by_background index for per-conversation
  // task scans and walks every task row. A bounded ANALYZE (~0.1 s on a 90 MB db) fixes the plan.
  if (path !== ":memory:") { try { db.exec("PRAGMA analysis_limit=400; ANALYZE; PRAGMA optimize;"); } catch {} }
  const adapter = new BunSqliteDatabase(db), store: ConversationStorage = { db, adapter };
  try {
    const storage = await SqliteStorage.open(adapter);
    // Status reads filter by conversation plus status/kind and background. The
    // upstream single-column background index otherwise scans all retained tasks.
    db.exec(`CREATE INDEX IF NOT EXISTS luna_tasks_by_conversation_status_background ON tasks (conversation_id, status, background, id);
      CREATE INDEX IF NOT EXISTS luna_tasks_by_conversation_kind_background ON tasks (conversation_id, kind, background, id);
      CREATE INDEX IF NOT EXISTS luna_entries_by_conversation_kind ON entries (conversation_id, json_extract(record, '$.kind'), id);`);
    // The user-message index (src/user-messages.ts) filters by entry kind. The expression index lets SQLite
    // skip large assistant and tool records without reading them. Building it takes about 0.6 s once on a 480 MB db.
    return { storage, store };
  }
  catch (e) { await adapter.close(); throw e; }
}
