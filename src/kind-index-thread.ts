// Builds luna_entries_by_conversation_kind on its own connection and thread. On a 500 MB db the build takes
// 25-40 s, which would freeze the daemon's event loop if it ran on the main connection.
import { Database } from "bun:sqlite";
import { KIND_INDEX_SQL } from "./kind-index.js";

declare const self: Worker;
self.onmessage = (event: MessageEvent<{ path: string }>) => {
  try {
    const db = new Database(event.data.path);
    // The build holds the write lock. Wait for other writers instead of failing.
    db.exec("PRAGMA busy_timeout=600000;");
    db.exec(KIND_INDEX_SQL);
    db.close();
    self.postMessage({ ok: true });
  } catch (e) { self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
};
