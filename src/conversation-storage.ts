// Small SQLite maintenance bridge for hard deletion, which pi-durable 1.2 does not expose.
// The hook runs inside the SAME storage transaction as document retirement. Session adoption then clears its caches.
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Harness } from "@earendil-works/pi-durable";
export type ConversationStorage = { db: DatabaseSync; afterWrite?: () => void };
const stores = new WeakMap<Harness, ConversationStorage>();
export const registerConversationStorage = (harness: Harness, store: ConversationStorage) => stores.set(harness, store);
export function conversationStorage(harness: Harness) {
  const store = stores.get(harness);
  if (!store) throw new Error("Conversation management requires Luna SQLite storage");
  return store;
}
export async function openConversationStorage(path: string) {
  if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000;");
  // Without planner statistics SQLite picks the low-selectivity tasks_by_background index for per-conversation
  // task scans and walks every task row. A bounded ANALYZE (~0.1 s on a 90 MB db) fixes the plan.
  if (path !== ":memory:") { try { db.exec("PRAGMA analysis_limit=400; ANALYZE; PRAGMA optimize;"); } catch {} }
  const adapter = new NodeSqliteDatabase(db), store: ConversationStorage = { db };
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    const afterWrite = store.afterWrite; store.afterWrite = undefined;
    afterWrite?.();
    return result;
  });
  try {
    const storage = await SqliteStorage.open(adapter);
    // Status reads filter by conversation plus status/kind and background. The
    // upstream single-column background index otherwise scans all retained tasks.
    db.exec(`CREATE INDEX IF NOT EXISTS luna_tasks_by_conversation_status_background ON tasks (conversation_id, status, background, id);
      CREATE INDEX IF NOT EXISTS luna_tasks_by_conversation_kind_background ON tasks (conversation_id, kind, background, id);`);
    return { storage, store };
  }
  catch (e) { await adapter.close(); throw e; }
}
