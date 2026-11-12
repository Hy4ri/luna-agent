// SQLite maintenance bridge for hard deletion. Pi 1.5 caches records, so purges run through the patched
// Session.maintain() barrier, which drains publications and evicts the deleted records.
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Harness } from "@earendil-works/pi-durable";
import { BunSqliteDatabase } from "./sqlite/bun-adapter.js";
import { KIND_INDEX_SQL, kindIndexReady } from "./kind-index.js";
export type ConversationStorage = { db: Database; adapter: BunSqliteDatabase; kindIndex: Promise<void> };
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
  const adapter = new BunSqliteDatabase(db), store: ConversationStorage = { db, adapter, kindIndex: Promise.resolve() };
  try {
    const storage = await SqliteStorage.open(adapter);
    // Status reads filter by conversation plus status/kind and background. The
    // upstream single-column background index otherwise scans all retained tasks.
    db.exec(`CREATE INDEX IF NOT EXISTS luna_tasks_by_conversation_status_background ON tasks (conversation_id, status, background, id);
      CREATE INDEX IF NOT EXISTS luna_tasks_by_conversation_kind_background ON tasks (conversation_id, kind, background, id);`);
    // The user-message index (src/user-messages.ts) filters by entry kind. The expression index lets SQLite
    // skip large assistant and tool records without reading them. The first build takes 25-40 s on a 500 MB db,
    // so file databases build it on a worker thread; readers fall back to index-free queries until it exists.
    store.kindIndex = buildKindIndex(db, path);
    return { storage, store };
  }
  catch (e) { await adapter.close(); throw e; }
}

function buildKindIndex(db: Database, path: string): Promise<void> {
  if (kindIndexReady(db)) return Promise.resolve();
  if (path === ":memory:") { db.exec(KIND_INDEX_SQL); return Promise.resolve(); }
  // The build holds the write lock. Main-thread writes wait for it rather than fail with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout=600000;");
  return new Promise<void>(resolve => {
    const worker = new Worker(new URL("./kind-index-thread.ts", import.meta.url).href);
    worker.unref();
    const finish = (error?: string) => {
      worker.terminate();
      try { db.exec("PRAGMA busy_timeout=5000;"); } catch {}
      if (error) console.error(`kind index build failed: ${error}`);
      resolve();
    };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => finish(event.data.ok ? undefined : event.data.error);
    worker.onerror = (event) => finish(event.message || "worker failed");
    worker.postMessage({ path });
  });
}
