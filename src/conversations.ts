// pi-durable 1.5 has no native delete operation. Keep its SQLite-specific purge here, on the harness mutation line.
import type { Database } from "bun:sqlite";
import type { ConversationId, ConversationRecord, Tx } from "@earendil-works/pi-durable";
import { conversationStorage } from "./conversation-storage.js";
import { context } from "./luna.js";
import type { RecallIndex } from "./recall.js";
import type { UploadStore } from "./uploads.js";
import { ProjectStore, GENERAL_PROJECT } from "./projects.js";
import { BoardStore } from "./board.js";
import { ProjectSkills } from "./project-skills.js";
import { newestMessageTime, SessionCreated } from "./session-activity.js";
type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
export type PruneOptions = { days: number; includeArchived: boolean; excludeIds: number[]; projectId?: number };
/** One top-level root of a selected deletion tree. `ids` is the whole tree: the root, then its forks and subagents. */
export type PruneSession = { id: number; title: string | null; activity: number; ids: number[] };
export type PruneResult = { ids: number[]; sessions: PruneSession[] };
export type ConversationMeta = { title: string | null; archived: boolean; pinned: boolean };
export class ConversationError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}
export class ConversationStore {
  private readonly db: Database;
  private readonly listeners = new Set<(ids?: readonly number[]) => void>();
  readonly projects: ProjectStore;
  readonly board: BoardStore;
  readonly projectSkills: ProjectSkills;
  private readonly boardListeners = new Set<() => void>();
  private readonly deletionListeners = new Set<(ids: number[]) => void>();
  private readonly beforeDeletionListeners = new Set<(ids: number[]) => void>();
  constructor(private readonly harness: Harness, private readonly recall?: RecallIndex, uploads?: UploadStore) {
    this.db = conversationStorage(harness).db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS luna_conversations (
        id INTEGER PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
      ) STRICT;`);
    // NULL source on an existing title means a user rename from before sources were stored.
    const cols = this.db.prepare("PRAGMA table_info(luna_conversations)").all() as { name: string }[];
    if (!cols.some(c => c.name === "title_source")) this.db.exec("ALTER TABLE luna_conversations ADD COLUMN title_source TEXT");
    this.projectSkills = new ProjectSkills(this.db);
    this.projects = new ProjectStore(this.db, id => { this.board.deleteProject(id); this.projectSkills.clear(id); });
    this.board = new BoardStore(this.db, uploads);
  }
  subscribeChanges(cb: (ids?: readonly number[]) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  /** Called with the ids of sessions that were just deleted, by `delete` and by `prune`. */
  subscribeDeleted(cb: (ids: number[]) => void): () => void {
    this.deletionListeners.add(cb);
    return () => { this.deletionListeners.delete(cb); };
  }
  /** Synchronous maintenance-barrier hooks: preserve derived history before physical deletion.
   * Hooks must never queue a harness read here. Errors refuse deletion rather than lose history. */
  subscribeBeforeDelete(cb: (ids: number[]) => void): () => void {
    this.beforeDeletionListeners.add(cb);
    return () => { this.beforeDeletionListeners.delete(cb); };
  }
  subscribeBoard(cb: () => void): () => void {
    this.boardListeners.add(cb);
    return () => { this.boardListeners.delete(cb); };
  }
  /** Tell connected viewers a board changed. */
  touch() { for (const cb of [...this.boardListeners]) { try { cb(); } catch {} } }
  /** Invalidate denormalized project labels without scanning transcript history. */
  projectsChanged() { this.notify(); }
  private notify(ids?: readonly number[]) {
    for (const cb of [...this.listeners]) {
      try { cb(ids); } catch {}
    }
  }
  /** Whether a conversation with this id is stored. */
  exists(id: number): boolean { return Number.isSafeInteger(id) && !!this.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(id); }
  get(id: number): ConversationMeta {
    const row = this.db.prepare("SELECT title, archived, pinned FROM luna_conversations WHERE id=?").get(id) as { title: string | null; archived: number; pinned: number } | undefined;
    return { title: row?.title ?? null, archived: !!row?.archived, pinned: !!row?.pinned };
  }
  async update(id: number, changes: Partial<ConversationMeta>) {
    const res = await this.harness.commit(async tx => {
      if (!await tx.conversation(id as never)) throw new ConversationError(404, "no such session");
      const next = { ...this.get(id), ...changes };
      const source = "title" in changes ? "user" : null;
      this.db.prepare(`INSERT INTO luna_conversations(id,title,archived,pinned,title_source) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,archived=excluded.archived,pinned=excluded.pinned,
          title_source=COALESCE(excluded.title_source,luna_conversations.title_source)`)
        .run(id, next.title, Number(next.archived), Number(next.pinned), source);
      return next;
    }, context);
    this.notify([id]);
    return res;
  }
  /** Link a session to another project. Its directory and machine stay as they are. */
  async move(id: number, projectId: number) {
    if (!this.projects.get(projectId)) throw new ConversationError(404, "no such project");
    await this.harness.commit(async tx => {
      if (!await tx.conversation(id as never)) throw new ConversationError(404, "no such session");
      this.projects.link(id, projectId);
    }, context);
    this.notify([id]);
  }
  /** Where the stored title came from: "derived" (instant), "auto" (model), "user", or null when untitled. */
  titleSource(id: number): "derived" | "auto" | "user" | null {
    const row = this.db.prepare("SELECT title, title_source FROM luna_conversations WHERE id=?").get(id) as { title: string | null; title_source: string | null } | undefined;
    if (!row?.title) return null;
    return row.title_source === "derived" || row.title_source === "auto" ? row.title_source : "user";
  }
  /**
   * Store a generated title at `source` authority (derived < auto < user). Without `force` a title never replaces a
   * higher one: the check is in the same statement as the write, so a rename that lands first always wins.
   * Returns whether the title was written.
   */
  async autoTitle(id: number, title: string, o: { source?: "derived" | "auto"; force?: boolean } = {}): Promise<boolean> {
    const source = o.source ?? "auto";
    const written = await this.harness.commit(async tx => {
      if (!await tx.conversation(id as never)) return false;
      const r = this.db.prepare(`INSERT INTO luna_conversations(id,title,title_source) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,title_source=excluded.title_source
        WHERE ? OR luna_conversations.title IS NULL OR luna_conversations.title_source='derived'
          OR (excluded.title_source='auto' AND luna_conversations.title_source='auto')`).run(id, title, source, Number(!!o.force));
      return Number(r.changes) > 0;
    }, context);
    if (written) this.notify([id]);
    return written;
  }
  /**
   * Parent links of the deletion tree: forks, owned conversations, and delegate.child markers. Entries are append-only
   * and conversation links never change after creation, so each call reads only rows past the last watermark. The read
   * runs on the mutation line with immediate durability, so every row below the watermark was already stored.
   */
  private readonly links = { children: new Map<number, Set<number>>(), conversation: 0, entry: 0 };
  private deletionTree() {
    const { children } = this.links;
    const link = (parent: number, id: number) => {
      const set = children.get(parent) ?? new Set<number>(); set.add(id); children.set(parent, set);
    };
    const conversations = this.db.prepare("SELECT id, record FROM conversations WHERE id > ? ORDER BY id").all(this.links.conversation) as { id: number; record: string }[];
    for (const row of conversations) {
      const c = JSON.parse(row.record) as ConversationRecord;
      if (c.parent) link(c.parent.conversationId, c.id);
      if (c.owner) link(c.owner.conversationId, c.id);
      this.links.conversation = row.id;
    }
    const top = (this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM entries").get() as { n: number }).n;
    if (top > this.links.entry) {
      const delegates = this.db.prepare("SELECT conversation_id AS id, json_extract(record, '$.data.parent') AS parent FROM entries WHERE id > ? AND id <= ? AND json_extract(record, '$.kind')='delegate.child'").all(this.links.entry, top) as { id: number; parent: number }[];
      for (const child of delegates) if (Number.isSafeInteger(child.parent)) link(child.parent, child.id);
      this.links.entry = top;
    }
    return (roots: Iterable<number>) => {
      const selected = new Set(roots);
      for (const id of selected) for (const child of children.get(id) ?? []) selected.add(child);
      return [...selected];
    };
  }
  private forgetLinks(ids: number[]) {
    const gone = new Set(ids);
    for (const id of ids) this.links.children.delete(id);
    for (const set of this.links.children.values()) for (const id of set) if (gone.has(id)) set.delete(id);
    for (const id of ids) this.activity.delete(id);
  }
  /** Newest message time per conversation, valid while the newest visible entry ID is unchanged. */
  private readonly activity = new Map<number, { latest: number | undefined; at: number | null }>();
  private async lastMessage(tx: Tx, id: ConversationId) {
    const latest = await tx.latestEntryId(id) as number | undefined, hit = this.activity.get(id);
    if (hit && hit.latest === latest) return hit.at;
    const at = await newestMessageTime(tx, id);
    this.activity.set(id, { latest, at });
    return at;
  }
  async delete(id: number) {
    return this.purge(async tx => {
      if (!await tx.conversation(id as never)) throw new ConversationError(404, "no such session");
      return this.deletionTree()([id]);
    });
  }
  /**
   * Select whole deletion trees whose every member is old enough and unprotected. An excluded session keeps its
   * descendants too. Without `confirmed` nothing is deleted and the selection is returned with one summary per root.
   * Unknown ages stay safe. Deletion rechecks every member on the harness mutation line.
   */
  async prune(options: PruneOptions, confirmed?: number[], protectedSession?: (id: number, tx: Tx) => Promise<boolean>): Promise<PruneResult> {
    const cutoff = Date.now() - options.days * 86400000;
    let sessions: PruneSession[] = [];
    const ids = await this.purge(async tx => {
      const treeOf = this.deletionTree();
      const meta = new Map((this.db.prepare("SELECT id, title, archived, pinned FROM luna_conversations").all() as { id: number; title: string | null; archived: number; pinned: number }[]).map(r => [r.id, r]));
      const excluded = new Set(treeOf(options.excludeIds));
      const allowed = confirmed && new Set(confirmed);
      const busy = new Set((this.db.prepare("SELECT DISTINCT conversation_id AS id FROM tasks WHERE status <> 'terminal'").all() as { id: number }[]).map(r => r.id));
      const links = options.projectId === undefined ? null : this.projects.links();
      const eligible = new Map<number, number>();
      let cursor;
      do {
        const page = await tx.scanConversations({}, 100, cursor);
        for (const row of page.items) {
          const id = Number(row.id), m = meta.get(id);
          if (m?.pinned || excluded.has(id) || busy.has(id) || (allowed && !allowed.has(id)) || (!options.includeArchived && m?.archived)) continue;
          if (links && (links.get(id) ?? GENERAL_PROJECT.id) !== options.projectId) continue;
          const message = await this.lastMessage(tx, row.id), created = (await tx.doc(SessionCreated, row.id)).at;
          const activity = message === null ? created : Math.max(message, created ?? 0);
          if (activity === null || !Number.isFinite(activity) || activity >= cutoff) continue;
          // Process and side-job checks cost the most, so they run only for sessions that are otherwise old enough.
          if (await protectedSession?.(id, tx)) continue;
          eligible.set(id, activity);
        }
        cursor = page.next;
      } while (cursor);
      const selected = new Set<number>(), trees = new Map<number, number[]>();
      for (const id of eligible.keys()) {
        const tree = treeOf([id]);
        // Never cascade through a pinned, recent, archived, running, excluded, or unconfirmed descendant.
        if (tree.every(child => eligible.has(child))) { trees.set(id, tree); for (const child of tree) selected.add(child); }
      }
      if (confirmed === undefined) {
        const covered = new Set<number>();
        for (const [id, tree] of trees) for (const child of tree) if (child !== id) covered.add(child);
        sessions = [...trees].filter(([id]) => !covered.has(id))
          .map(([id, tree]) => ({ id, title: meta.get(id)?.title ?? null, activity: eligible.get(id)!, ids: [id, ...tree.filter(child => child !== id).sort((a, b) => a - b)] }))
          .sort((a, b) => a.activity - b.activity || a.id - b.id);
      }
      return [...selected].sort((a, b) => a - b);
    }, confirmed === undefined);
    return { ids, sessions };
  }
  private async purge(select: (tx: Tx) => Promise<number[]>, preview = false) {
    const store = conversationStorage(this.harness);
    // Select on the mutation line and fingerprint the tree. The maintenance barrier then holds the line, so no commit can
    // interleave; it refuses deletion when work reached the tree between the two steps.
    const fingerprint = (ids: number[]) => {
      const list = JSON.stringify(ids);
      const entries = this.db.prepare("SELECT COALESCE(MAX(id),0) AS n FROM entries WHERE conversation_id IN (SELECT value FROM json_each(?))").get(list) as { n: number };
      const tasks = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m FROM tasks WHERE conversation_id IN (SELECT value FROM json_each(?))").get(list) as { n: number; m: number };
      return `${entries.n}:${tasks.n}:${tasks.m}`;
    };
    let ids: number[] = [], before = "";
    await this.harness.commit(async tx => {
      ids = await select(tx);
      if (!preview && ids.length) before = fingerprint(ids);
    }, context);
    if (preview || !ids.length) return ids;
    return this.harness.maintain(async maintenance => {
      if (fingerprint(ids) !== before) throw new ConversationError(409, "The conversation changed during deletion. Try again.");

      // Execute physical deletion inside adapter transaction to ensure serialization with storage queue
      await store.adapter.transaction(async () => {
        // Use a temp table instead of a SQL variable limit for large child trees.
        this.db.exec("CREATE TEMP TABLE IF NOT EXISTS purge_conversations(id INTEGER PRIMARY KEY); DELETE FROM purge_conversations;");
        const add = this.db.prepare("INSERT INTO purge_conversations VALUES (?)"); for (const n of ids) add.run(n);
        const busy = this.db.prepare("SELECT id FROM tasks WHERE conversation_id IN (SELECT id FROM purge_conversations) AND status <> 'terminal' LIMIT 1").get();
        if (busy) throw new ConversationError(409, "Stop the conversation and its child tasks before deleting it.");
        for (const cb of this.beforeDeletionListeners) cb(ids);
        this.db.exec(`
          CREATE TEMP TABLE IF NOT EXISTS purge_tasks(id INTEGER PRIMARY KEY); DELETE FROM purge_tasks;
          INSERT INTO purge_tasks SELECT id FROM tasks WHERE conversation_id IN (SELECT id FROM purge_conversations);
          CREATE TEMP TABLE IF NOT EXISTS purge_documents(id INTEGER PRIMARY KEY); DELETE FROM purge_documents;
          INSERT INTO purge_documents SELECT id FROM documents WHERE
            (scope_kind='conversation' AND owner_id IN (SELECT id FROM purge_conversations)) OR
            (scope_kind='task' AND owner_id IN (SELECT id FROM purge_tasks));
          CREATE TEMP TABLE IF NOT EXISTS purge_submissions(id INTEGER PRIMARY KEY); DELETE FROM purge_submissions;
          INSERT INTO purge_submissions SELECT id FROM submissions WHERE conversation_id IN (SELECT id FROM purge_conversations);
        `);

        const purgeTaskIds = (this.db.prepare("SELECT id FROM purge_tasks").all() as { id: number }[]).map(r => r.id);
        const purgeSubmissionIds = (this.db.prepare("SELECT id FROM purge_submissions").all() as { id: number }[]).map(r => r.id);

        this.db.exec(`
          DELETE FROM record_ids WHERE id IN (SELECT id FROM purge_documents)
            OR id IN (SELECT id FROM entries WHERE conversation_id IN (SELECT id FROM purge_conversations))
            OR id IN (SELECT id FROM purge_submissions)
            OR id IN (SELECT id FROM purge_tasks) OR id IN (SELECT id FROM purge_conversations);
          DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM purge_documents);
          DELETE FROM documents WHERE id IN (SELECT id FROM purge_documents);
          DELETE FROM submissions WHERE id IN (SELECT id FROM purge_submissions);
          DELETE FROM entries WHERE conversation_id IN (SELECT id FROM purge_conversations);
          DELETE FROM tasks WHERE id IN (SELECT id FROM purge_tasks);
          DELETE FROM luna_conversations WHERE id IN (SELECT id FROM purge_conversations);
          DELETE FROM luna_session_projects WHERE conversation_id IN (SELECT id FROM purge_conversations);
          DELETE FROM conversations WHERE id IN (SELECT id FROM purge_conversations);
          DELETE FROM purge_submissions; DELETE FROM purge_documents; DELETE FROM purge_tasks; DELETE FROM purge_conversations;
        `);

        maintenance.evict({
          conversations: ids as never,
          tasks: purgeTaskIds as never,
          submissions: purgeSubmissionIds as never,
        });
      });

      this.recall?.forget(ids);
      this.forgetLinks(ids);
      for (const cb of [...this.deletionListeners]) { try { cb(ids); } catch {} }
      this.notify(ids);
      return ids;
    });
  }
}

