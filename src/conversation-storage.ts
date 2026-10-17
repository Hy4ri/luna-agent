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
  const adapter = new NodeSqliteDatabase(db), store: ConversationStorage = { db };
  const transaction = adapter.transaction.bind(adapter);
  adapter.transaction = callback => transaction(async tx => {
    const result = await callback(tx);
    const afterWrite = store.afterWrite; store.afterWrite = undefined;
    afterWrite?.();
    return result;
  });
  try { return { storage: await SqliteStorage.open(adapter), store }; }
  catch (e) { await adapter.close(); throw e; }
}
