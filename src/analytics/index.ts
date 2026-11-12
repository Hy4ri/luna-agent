import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ConversationId } from "@earendil-works/pi-durable";
import { conversationStorage } from "../conversation-storage.js";
import type { ConversationStore } from "../conversations.js";
import { context } from "../luna.js";
import { isRunning, readSessionStatus } from "../session-status.js";
import { AnalyticsStore } from "./store.js";
import { scanAnalyticsSession } from "./source.js";
import { AnalyticsScanThread } from "./scan-thread.js";
import type { AnalyticsScan } from "./types.js";

type Harness = Awaited<ReturnType<typeof import("../luna.js").openLuna>>;
const services = new WeakMap<Harness, AnalyticsService>();

/** A durable materialized view, independent of request lifetimes. Never queues work inside a maintenance hook. */
export class AnalyticsService {
  readonly store: AnalyticsStore;
  private readonly source;
  private readonly dirty = new Set<number>();
  private readonly listeners = new Set<() => void>();
  private readonly detach: (() => void)[] = [];
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failure?: Error;
  /** Off-main-thread scanner for file databases. Undefined after a thread failure: scans then run inline. */
  private thread?: AnalyticsScanThread;
  sessionsScanned = 0;
  entriesScanned = 0;
  indexedAt: string | null = null;

  constructor(private readonly harness: Harness, conversations?: ConversationStore) {
    this.source = conversationStorage(harness).db;
    const filename = this.source.filename;
    this.store = new AnalyticsStore(filename === ":memory:" || !filename ? ":memory:" : join(dirname(filename), "analytics.db"));
    if (filename && filename !== ":memory:" && process.env.LUNA_ANALYTICS_THREAD !== "0") {
      try { this.thread = new AnalyticsScanThread(filename, join(dirname(filename), "analytics.db")); } catch { this.thread = undefined; }
    }
    this.store.db.exec("CREATE TABLE IF NOT EXISTS analytics_checkpoints(session_id INTEGER PRIMARY KEY, signature TEXT NOT NULL)");
    const observation = harness.observeCommits({
      advance: publication => {
        for (const change of publication.changes) {
          const id = change.type === "conversation" ? change.value.id
            : change.type === "entry" || change.type === "task" || change.type === "submission" ? change.value.conversationId
            : change.conversationId;
          if (id !== undefined) this.dirty.add(Number(id));
          // Global documents do not invalidate unrelated conversations.
        }
        this.schedule();
      },
      end: () => { if (!this.stopped) this.close(); },
    });
    this.detach.push(() => observation.detach());
    if (conversations) {
      this.detach.push(conversations.subscribeChanges(ids => {
        const affected = ids ?? (this.source.query("SELECT id FROM conversations").all() as { id: number }[]).map(row => row.id);
        for (const id of affected) this.dirty.add(id);
        this.schedule();
      }));
      this.detach.push(conversations.subscribeBeforeDelete(ids => {
        // This executes under the storage maintenance barrier. No harness reads are allowed.
        for (const id of ids) {
          const scan = scanAnalyticsSession(this.source, id, this.store.getSession(id));
          if (scan) this.store.apply(scan);
        }
      }));
      this.detach.push(conversations.subscribeDeleted(ids => {
        this.store.markDeleted(ids, Date.now());
        for (const id of ids) this.dirty.delete(id);
        this.emit();
      }));
    }
    const savedTime = this.store.db.query("SELECT value FROM analytics_meta WHERE key='indexed_at'").get() as { value: string } | null;
    this.indexedAt = savedTime?.value ?? null;
    this.reconcile();
    this.schedule();
    void harness.closed.then(() => this.close(), () => this.close());
  }

  private signature(id: number): string {
    const entry = this.source.query("SELECT COALESCE(MAX(id),0) AS n FROM entries WHERE conversation_id=?").get(id) as { n: number };
    const docs = this.source.query(`SELECT COALESCE(MAX(r.seq),0) AS n FROM documents d JOIN document_revisions r ON r.document_id=d.id
      WHERE (d.scope_kind='conversation' AND d.owner_id=?) OR (d.scope_kind='task' AND d.owner_id IN (SELECT id FROM tasks WHERE conversation_id=?))`).get(id, id) as { n: number };
    const tasks = this.source.query("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS latest, SUM(status<>'terminal') AS live FROM tasks WHERE conversation_id=?").get(id) as { n: number; latest: number; live: number | null };
    const meta = this.source.query("SELECT record FROM conversations WHERE id=?").get(id) as { record: string } | null;
    let metadata: unknown = null;
    try { metadata = this.source.query("SELECT m.title,m.archived,m.pinned,p.project_id,j.name FROM luna_conversations m LEFT JOIN luna_session_projects p ON p.conversation_id=m.id LEFT JOIN luna_projects j ON j.id=p.project_id WHERE m.id=?").get(id); } catch { /* Optional metadata tables are absent in minimal harnesses. */ }
    return JSON.stringify([entry.n, docs.n, tasks.n, tasks.latest, tasks.live, meta?.record, metadata]);
  }

  private reconcile(): void {
    if (this.stopped) return;
    const ids = (this.source.query("SELECT id FROM conversations").all() as { id: number }[]).map(row => row.id);
    const retained = new Set(ids);
    for (const id of ids) {
      const previous = this.store.getSession(id);
      const checkpoint = this.store.db.query("SELECT signature FROM analytics_checkpoints WHERE session_id=?").get(id) as { signature: string } | null;
      if (!previous || !previous.revision || previous.deletedAt !== null || checkpoint?.signature !== this.signature(id)) this.dirty.add(id);
    }
    // Repairs a crash between source deletion and the tombstone write without erasing saved facts.
    this.store.markDeleted(this.store.sessions().filter(row => row.deletedAt === null && !retained.has(row.id)).map(row => row.id), Date.now());
  }

  private schedule(): void {
    if (this.stopped || !this.dirty.size || this.timer || this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); console.warn("Analytics indexing failed:", this.failure.message); });
    }, 250);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    if (this.stopped) throw new Error("Analytics is closed");
    if (this.pending) return this.pending;
    clearTimeout(this.timer); this.timer = undefined;
    this.pending = this.drain().finally(() => { this.pending = undefined; this.schedule(); });
    return this.pending;
  }

  private async drain(): Promise<void> {
    this.sessionsScanned = 0; this.entriesScanned = 0;
    try {
      // Snapshot the worklist: subsequent commits remain dirty for the next pass.
      for (const id of [...this.dirty]) {
        if (this.stopped) return;
        this.dirty.delete(id);
        try {
          const scan = await this.scanSession(id);
          if (this.stopped) return;
          if (scan) {
            if (!scan.applied) this.store.apply(scan.value);
            // If commits interleaved with the read, keep the checkpoint invalid until their next pass.
            if (!this.dirty.has(id)) this.store.db.query("INSERT OR REPLACE INTO analytics_checkpoints VALUES (?,?)").run(id, this.signature(id));
            this.sessionsScanned++; this.entriesScanned += scan.entriesScanned;
          } else this.store.markDeleted([id], Date.now());
        } catch (error) { this.dirty.add(id); throw error; }
        await setImmediate();
      }
      this.failure = undefined;
      this.indexedAt = new Date().toISOString();
      this.store.db.query("INSERT OR REPLACE INTO analytics_meta VALUES ('indexed_at',?)").run(this.indexedAt);
      this.emit();
    } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); throw error; }
  }

  /**
   * Scans one session. With the scan thread, the thread scans and writes the facts itself (applied: true); the
   * main thread only reads the session status. Without it, the scan runs inline in one storage read.
   */
  private async scanSession(id: number): Promise<{ applied: true; entriesScanned: number } | { applied: false; value: AnalyticsScan; entriesScanned: number } | undefined> {
    const thread = this.thread;
    if (thread) {
      let handle: number | undefined;
      try {
        handle = await thread.scan(id);
        if (this.stopped) { if (handle !== undefined) thread.drop(handle); return undefined; }
        const held = handle;
        const state = await this.harness.commit(async tx => {
          if (this.stopped || held === undefined || !await tx.conversation(id as ConversationId)) return undefined;
          return readSessionStatus(tx, id as ConversationId, await isRunning(tx, id as ConversationId));
        }, context);
        if (!state) { if (held !== undefined) thread.drop(held); return undefined; }
        handle = undefined;
        return { applied: true, entriesScanned: await thread.apply(held!, state.status, state.statusReason) };
      } catch (error) {
        if (handle !== undefined) thread.drop(handle);
        if (this.stopped) return undefined;
        console.warn("Analytics scan thread failed, scanning inline:", error instanceof Error ? error.message : String(error));
        thread.close();
        if (this.thread === thread) this.thread = undefined;
      }
    }
    if (this.stopped) return undefined;
    const value = await this.harness.commit(async tx => {
      if (this.stopped || !await tx.conversation(id as ConversationId)) return undefined;
      const value = scanAnalyticsSession(this.source, id, this.store.getSession(id));
      if (value) {
        const state = await readSessionStatus(tx, id as ConversationId, await isRunning(tx, id as ConversationId));
        value.session.status = state.status;
        value.session.statusReason = state.statusReason;
      }
      return value;
    }, context);
    return value ? { applied: false, value, entriesScanned: value.entriesScanned } : undefined;
  }

  async ready(): Promise<void> {
    // Saved results can be served immediately during a restart catch-up. Fresh requests still see its timestamp.
    const count = this.store.db.query("SELECT COUNT(*) AS n FROM analytics_sessions").get() as { n: number };
    if (!count.n || this.failure) await this.refresh();
  }
  subscribe(callback: () => void): () => void { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* A disconnected viewer cannot fail indexing. */ } } }
  close(): void {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer);
    this.thread?.close(); this.thread = undefined;
    for (const detach of this.detach.splice(0)) detach();
    this.listeners.clear();
    // An active drain checks stopped after its pending harness read before touching the store.
    this.store.close();
  }
}

export function analyticsService(harness: Harness, conversations?: ConversationStore): AnalyticsService {
  let service = services.get(harness);
  if (!service) { service = new AnalyticsService(harness, conversations); services.set(harness, service); }
  return service;
}
