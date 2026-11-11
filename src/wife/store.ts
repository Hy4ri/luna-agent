// Wife: suggestion cards in wife.db. A card is filed by a detector (or the model pass) and decided by m57.
// Dedupe is by fingerprint: a dismissed, done, or failed card is never filed again.
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";

export const WIFE_KINDS = ["skill", "memory", "new_project", "move_session", "archive_session", "delete_session", "feature_tip"] as const;
export type WifeKind = (typeof WIFE_KINDS)[number];
export const WIFE_STATUSES = ["open", "snoozed", "dismissed", "working", "done", "failed"] as const;
export type WifeStatus = (typeof WIFE_STATUSES)[number];

export interface Suggestion {
  id: number; kind: WifeKind; fingerprint: string; title: string; body: string;
  evidence: { sessionId: number; note: string }[];
  payload: Record<string, unknown>;
  source: "detector" | "model"; status: WifeStatus;
  snoozeUntil: number | null; sessionId: number | null; result: string | null;
  created: number; updated: number;
}
export type NewSuggestion = Pick<Suggestion, "kind" | "fingerprint" | "title" | "body" | "evidence" | "payload" | "source">;

interface Row { id: number; kind: WifeKind; fingerprint: string; title: string; body: string; evidence: string; payload: string; source: "detector" | "model";
  status: WifeStatus; snooze_until: number | null; session_id: number | null; result: string | null; created: number; updated: number }
const view = (r: Row): Suggestion => ({ id: r.id, kind: r.kind, fingerprint: r.fingerprint, title: r.title, body: r.body, evidence: JSON.parse(r.evidence),
  payload: JSON.parse(r.payload), source: r.source, status: r.status, snoozeUntil: r.snooze_until, sessionId: r.session_id, result: r.result, created: r.created, updated: r.updated });

export class WifeStore {
  readonly db: Database;
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL CHECK (source IN ('detector','model')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','dismissed','working','done','failed')),
        snooze_until INTEGER, session_id INTEGER, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status);
    `);
  }
  close() { this.db.close(); }

  get(id: number): Suggestion | undefined {
    const r = this.db.prepare("SELECT * FROM suggestions WHERE id=?").get(id) as Row | null;
    return r ? view(r) : undefined;
  }
  has(fingerprint: string): boolean { return !!this.db.prepare("SELECT 1 FROM suggestions WHERE fingerprint=?").get(fingerprint); }
  list(status?: WifeStatus): Suggestion[] {
    const rows = (status ? this.db.prepare("SELECT * FROM suggestions WHERE status=? ORDER BY created DESC, id DESC").all(status)
      : this.db.prepare("SELECT * FROM suggestions ORDER BY created DESC, id DESC").all()) as Row[];
    return rows.map(view);
  }
  count(status: WifeStatus = "open"): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status=?").get(status) as { n: number }).n;
  }
  /** New fingerprint: insert. Open or snoozed: refresh text and evidence. Any other status: leave alone. Returns the card when it was inserted or refreshed. */
  file(s: NewSuggestion): Suggestion | undefined {
    const t = this.now();
    const existing = this.db.prepare("SELECT status FROM suggestions WHERE fingerprint=?").get(s.fingerprint) as { status: WifeStatus } | null;
    if (!existing) {
      this.db.prepare(`INSERT INTO suggestions(kind,fingerprint,title,body,evidence,payload,source,status,created,updated) VALUES (?,?,?,?,?,?,?,'open',?,?)`)
        .run(s.kind, s.fingerprint, s.title, s.body, JSON.stringify(s.evidence), JSON.stringify(s.payload), s.source, t, t);
    } else if (existing.status === "open" || existing.status === "snoozed") {
      this.db.prepare("UPDATE suggestions SET title=?, body=?, evidence=?, payload=?, updated=? WHERE fingerprint=?")
        .run(s.title, s.body, JSON.stringify(s.evidence), JSON.stringify(s.payload), t, s.fingerprint);
    } else return undefined;
    const r = this.db.prepare("SELECT * FROM suggestions WHERE fingerprint=?").get(s.fingerprint) as Row;
    return view(r);
  }
  /** Move a card to a status. `patch` sets result, sessionId, or snoozeUntil. */
  setStatus(id: number, status: WifeStatus, patch: { result?: string | null; sessionId?: number | null; snoozeUntil?: number | null } = {}) {
    this.db.prepare("UPDATE suggestions SET status=?, result=COALESCE(?,result), session_id=COALESCE(?,session_id), snooze_until=?, updated=? WHERE id=?")
      .run(status, patch.result ?? null, patch.sessionId ?? null, status === "snoozed" ? patch.snoozeUntil ?? null : null, this.now(), id);
  }
  /** Snoozed cards whose time has passed become open again. Returns how many. */
  expireSnoozed(now = this.now()): number {
    return Number(this.db.prepare("UPDATE suggestions SET status='open', snooze_until=NULL, updated=? WHERE status='snoozed' AND snooze_until IS NOT NULL AND snooze_until<=?").run(now, now).changes);
  }
  /** A detector withdraws an open card when its condition no longer holds. Only `open` rows are deleted. */
  withdrawOpen(kind: WifeKind, keep: Set<string>): number {
    const rows = this.db.prepare("SELECT id, fingerprint FROM suggestions WHERE kind=? AND status='open'").all(kind) as { id: number; fingerprint: string }[];
    let n = 0;
    for (const r of rows) if (!keep.has(r.fingerprint)) { this.db.prepare("DELETE FROM suggestions WHERE id=? AND status='open'").run(r.id); n++; }
    return n;
  }
}
