// Durable browser transport state, not a relationship between conversations.
export interface StoredAttachment {
  mimeType: string; data: string; uploadId?: string; name?: string; size?: number;
  report?: { jobName: string; id: number; status: string };
}
export interface BackgroundSendRecord {
  id: string; creationRequestId: string; messageRequestId: string; scope: string;
  createdAt: number; updatedAt: number;
  settings: { project: number | null; model: { provider: string; modelId: string }; thinking: string; speed?: "fast" | "ultrafast" | null; worker: number | null; cwd: string };
  payload: { text: string; attachments: StoredAttachment[]; isCommand: boolean } | null;
  sessionId: string | null;
  state: "persisted" | "creating_session" | "session_created" | "submitting" | "accepted" | "failed";
  error: string | null; notice?: string;
  claimedBy?: string | null; claimedUntil?: number | null;
}
let database: Promise<IDBDatabase> | undefined;
function openDB(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("Browser storage is unavailable; the draft was not sent.")); return; }
      const request = indexedDB.open("luna_background_send_outbox", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("records", { keyPath: "id" });
        store.createIndex("by_scope", "scope");
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined; };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close older Luna tabs to enable send recovery."));
    }).catch(error => { database = undefined; throw error; });
  }
  return database;
}
// Resolve only on transaction completion, never on request success (the commit can still abort).
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("records", mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("Could not commit send recovery; the draft was not sent."));
    tx.onerror = () => reject(tx.error ?? new Error("Browser storage failed."));
    action(tx.objectStore("records"), value => { result = value; });
  });
}
export function putOutboxRecord(record: BackgroundSendRecord): Promise<void> {
  return transaction("readwrite", store => { store.put(record); });
}
export function getOutboxRecord(id: string): Promise<BackgroundSendRecord | undefined> {
  return transaction("readonly", (store, set) => { const req = store.get(id); req.onsuccess = () => set(req.result); });
}
export function listOutboxRecords(scope: string): Promise<BackgroundSendRecord[]> {
  return transaction("readonly", (store, set) => { const req = store.index("by_scope").getAll(scope); req.onsuccess = () => set(req.result); });
}
export function deleteOutboxRecord(id: string): Promise<void> {
  return transaction("readwrite", store => { store.delete(id); });
}
export function claimOutboxRecord(id: string, clientId: string): Promise<BackgroundSendRecord | null> {
  return transaction("readwrite", (store, set) => {
    const req = store.get(id);
    req.onsuccess = () => {
      const record = req.result as BackgroundSendRecord | undefined;
      if (!record || (record.claimedUntil ?? 0) > Date.now()) { set(null); return; }
      // Each pipeline contains bounded HTTP requests; fence stale writers as well as duplicate clicks.
      record.claimedBy = clientId; record.claimedUntil = Date.now() + 120_000;
      store.put(record); set(record);
    };
  });
}
export function saveClaimedRecord(record: BackgroundSendRecord, clientId: string): Promise<boolean> {
  return transaction("readwrite", (store, set) => {
    const req = store.get(record.id);
    req.onsuccess = () => {
      const current = req.result as BackgroundSendRecord | undefined;
      if (!current || current.claimedBy !== clientId || (current.claimedUntil ?? 0) <= Date.now()) { set(false); return; }
      store.put({ ...record, claimedBy: current.claimedBy, claimedUntil: current.claimedUntil }); set(true);
    };
  });
}
export function releaseOutboxClaim(id: string, clientId: string): Promise<void> {
  return transaction("readwrite", store => {
    const req = store.get(id);
    req.onsuccess = () => {
      const record = req.result as BackgroundSendRecord | undefined;
      if (record?.claimedBy === clientId) store.put({ ...record, claimedBy: null, claimedUntil: null });
    };
  });
}
