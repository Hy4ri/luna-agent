// Steward: suggestion cards in steward.db. A card is filed by a detector (or the model pass) and decided by the user.
// Dedupe is by fingerprint: a dismissed, done, or failed card is never filed again.
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";

export const STEWARD_KINDS = ["skill", "memory", "new_project", "move_session", "archive_session", "delete_session", "feature_tip", "tune_rule", "mute_rule", "mute_kind", "goal_unfinished", "cron_failing", "quota_waits", "board_stuck", "new_rule", "promote_rule", "cost_habit", "compaction_heavy", "weekly_recap", "reminder_unscheduled", "worktree_orphan", "bg_leftover",  "browser_leftover", "rule_idea","tool_error_repeat", "skill_unused", "prompt_repeat", "project_setup_repeat"] as const;
export type StewardKind = (typeof STEWARD_KINDS)[number];
export const STEWARD_STATUSES = ["open", "snoozed", "dismissed", "working", "done", "failed"] as const;
export const DISMISS_REASONS = ["wrong", "not_now", "already_done", "dont_care_kind", "too_aggressive"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
export type OutcomeAction = "agree" | "dismiss" | "snooze" | "undo" | "failed";
export const NOT_NOW_DAYS = 30;
export type StewardStatus = (typeof STEWARD_STATUSES)[number];

export interface Suggestion {
  id: number; kind: StewardKind; ruleId: string; fingerprint: string; title: string; body: string;
  evidence: { sessionId: number; note: string }[];
  payload: Record<string, unknown>;
  source: "detector" | "model"; status: StewardStatus;
  snoozeUntil: number | null; sessionId: number | null; result: string | null;
  created: number; updated: number;
  /** Until when the action can be undone. Null when it cannot. */
  undoUntil: number | null;
}
export type NewSuggestion = Pick<Suggestion, "kind" | "fingerprint" | "title" | "body" | "evidence" | "payload" | "source"> & { ruleId?: string };
export const UNDO_DAYS = 7;
/** Release order for held cards: work you can act on first, reports and nudges last. Kinds not listed come after these. */
export const KIND_VALUE: readonly StewardKind[] = ["goal_unfinished", "cron_failing", "reminder_unscheduled", "board_stuck", "memory", "skill", "new_project", "move_session",
  "worktree_orphan", "bg_leftover", "browser_leftover", "archive_session", "delete_session", "quota_waits", "tool_error_repeat", "prompt_repeat", "project_setup_repeat",
  "promote_rule", "tune_rule", "mute_rule", "mute_kind", "new_rule", "rule_idea", "feature_tip", "cost_habit", "compaction_heavy", "skill_unused", "weekly_recap"];
/** How to reverse a direct action. Deleting a session has none. */
export type Inverse =
  | { type: "unarchive"; ids: number[] }
  | { type: "move_back"; moves: { id: number; projectId: number }[] }
  | { type: "remove_project"; projectId: number; moves: { id: number; projectId: number }[] }
  | { type: "restore_memory"; key: string; content: string | null };
export interface Outcome { id: number; suggestionId: number; kind: StewardKind; ruleId: string; source: string; action: OutcomeAction; reason: string | null; note: string | null; ts: number }

interface Row { id: number; kind: StewardKind; rule_id: string; fingerprint: string; title: string; body: string; evidence: string; payload: string; source: "detector" | "model";
  status: StewardStatus; snooze_until: number | null; session_id: number | null; result: string | null; created: number; updated: number }
const view = (r: Row & { undo_until?: number | null }): Suggestion => ({ id: r.id, kind: r.kind, ruleId: r.rule_id, fingerprint: r.fingerprint, title: r.title, body: r.body, evidence: JSON.parse(r.evidence),
  payload: JSON.parse(r.payload), source: r.source, status: r.status, snoozeUntil: r.snooze_until, sessionId: r.session_id, result: r.result, created: r.created, updated: r.updated, undoUntil: r.undo_until ?? null });

export class StewardStore {
  readonly db: Database;
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, rule_id TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL CHECK (source IN ('detector','model')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','dismissed','working','done','failed')),
        snooze_until INTEGER, session_id INTEGER, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status);
      CREATE TABLE IF NOT EXISTS outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER NOT NULL, kind TEXT NOT NULL, rule_id TEXT NOT NULL, source TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('agree','dismiss','snooze','undo','failed')), reason TEXT, note TEXT, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outcomes_rule ON outcomes(rule_id, ts);
      CREATE TABLE IF NOT EXISTS shadow_hits (tip_id TEXT NOT NULL, day INTEGER NOT NULL, title TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (tip_id, day));
      CREATE TABLE IF NOT EXISTS undo (suggestion_id INTEGER PRIMARY KEY, inverse TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
    // shown_at null: the card is held back by quiet hours or the daily cap.
    const cols = (this.db.prepare("PRAGMA table_info(suggestions)").all() as { name: string }[]).map(c => c.name);
    if (!cols.includes("shown_at")) this.db.exec("ALTER TABLE suggestions ADD COLUMN shown_at INTEGER; UPDATE suggestions SET shown_at=created;");
  }
  close() { this.db.close(); }
  /** A shadow rule would have flagged something now. One row per rule per day. */
  logShadow(tipId: string, title: string, ts: number) { this.db.prepare("INSERT OR IGNORE INTO shadow_hits(tip_id, day, title, ts) VALUES (?,?,?,?)").run(tipId, Math.floor(ts / 86_400_000), title, ts); }
  shadowHits(tipId: string, since = 0): { day: number; title: string; ts: number }[] {
    return this.db.prepare("SELECT day, title, ts FROM shadow_hits WHERE tip_id=? AND ts>=? ORDER BY ts").all(tipId, since) as never;
  }

  get(id: number): Suggestion | undefined {
    const r = this.db.prepare("SELECT s.*, (SELECT expires FROM undo u WHERE u.suggestion_id=s.id) AS undo_until FROM suggestions s WHERE s.id=?").get(id) as Row | null;
    return r ? view(r) : undefined;
  }
  has(fingerprint: string): boolean { return !!this.db.prepare("SELECT 1 FROM suggestions WHERE fingerprint=?").get(fingerprint); }
  list(status?: StewardStatus): Suggestion[] {
    const rows = (status ? this.db.prepare("SELECT s.*, (SELECT expires FROM undo u WHERE u.suggestion_id=s.id) AS undo_until FROM suggestions s WHERE s.shown_at IS NOT NULL AND s.status=? ORDER BY s.created DESC, s.id DESC").all(status)
      : this.db.prepare("SELECT s.*, (SELECT expires FROM undo u WHERE u.suggestion_id=s.id) AS undo_until FROM suggestions s WHERE s.shown_at IS NOT NULL ORDER BY s.created DESC, s.id DESC").all()) as Row[];
    return rows.map(view);
  }
  count(status: StewardStatus = "open"): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE shown_at IS NOT NULL AND status=?").get(status) as { n: number }).n;
  }
  /** New fingerprint: insert. Open or snoozed: refresh text and evidence. Any other status: leave alone. Returns the card when it was inserted or refreshed. */
  file(s: NewSuggestion, show = true): Suggestion | undefined {
    const t = this.now();
    const existing = this.db.prepare("SELECT status FROM suggestions WHERE fingerprint=?").get(s.fingerprint) as { status: StewardStatus } | null;
    if (!existing) {
      this.db.prepare(`INSERT INTO suggestions(kind,rule_id,fingerprint,title,body,evidence,payload,source,status,created,updated,shown_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?,?)`)
        .run(s.kind, s.ruleId ?? s.kind, s.fingerprint, s.title, s.body, JSON.stringify(s.evidence), JSON.stringify(s.payload), s.source, t, t, show ? t : null);
    } else if (existing.status === "open" || existing.status === "snoozed") {
      this.db.prepare("UPDATE suggestions SET title=?, body=?, evidence=?, payload=?, updated=? WHERE fingerprint=?")
        .run(s.title, s.body, JSON.stringify(s.evidence), JSON.stringify(s.payload), t, s.fingerprint);
    } else return undefined;
    const r = this.db.prepare("SELECT s.*, (SELECT expires FROM undo u WHERE u.suggestion_id=s.id) AS undo_until FROM suggestions s WHERE s.fingerprint=?").get(s.fingerprint) as Row;
    return view(r);
  }
  /** Cards shown since `since`, and the held ones, oldest first. */
  shownSince(since: number): number { return (this.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE shown_at>=?").get(since) as { n: number }).n; }
  /** Show up to `n` held open cards, the most useful kinds first (see KIND_VALUE), then oldest. Returns how many. */
  release(n: number): number {
    if (n <= 0) return 0;
    const rank = `CASE ${KIND_VALUE.map((k, i) => `WHEN kind='${k}' THEN ${i}`).join(" ")} ELSE ${KIND_VALUE.length} END`;
    return Number(this.db.prepare(`UPDATE suggestions SET shown_at=? WHERE id IN (SELECT id FROM suggestions WHERE shown_at IS NULL AND status='open' ORDER BY CASE source WHEN 'model' THEN 0 ELSE 1 END, ${rank}, created, id LIMIT ?)`).run(this.now(), n).changes);
  }
  /** Show one card now, whatever the quiet hours and cap say. Returns 1 when it was held. */
  show(fingerprint: string): number { return Number(this.db.prepare("UPDATE suggestions SET shown_at=? WHERE fingerprint=? AND shown_at IS NULL").run(this.now(), fingerprint).changes); }
  /** Open and snoozed cards about one session: its id is in the evidence or the payload. Held cards count. */
  about(session: number): Suggestion[] {
    const rows = this.db.prepare("SELECT s.*, NULL AS undo_until FROM suggestions s WHERE s.status IN ('open','snoozed')").all() as Row[];
    return rows.map(view).filter(c => c.evidence.some(e => e.sessionId === session) || Number(c.payload.sessionId) === session
      || (Array.isArray(c.payload.sessionIds) && (c.payload.sessionIds as unknown[]).includes(session)));
  }
  /** Show every held card about one session. Returns how many. */
  showAbout(session: number): number {
    let n = 0;
    for (const c of this.about(session)) n += this.show(c.fingerprint);
    return n;
  }
  /** Move a card to a status. `patch` sets result, sessionId, or snoozeUntil. */
  setStatus(id: number, status: StewardStatus, patch: { result?: string | null; sessionId?: number | null; snoozeUntil?: number | null } = {}) {
    this.db.prepare("UPDATE suggestions SET status=?, result=COALESCE(?,result), session_id=COALESCE(?,session_id), snooze_until=?, updated=? WHERE id=?")
      .run(status, patch.result ?? null, patch.sessionId ?? null, status === "snoozed" ? patch.snoozeUntil ?? null : null, this.now(), id);
  }
  /** Snoozed cards whose time has passed become open again. Returns how many. */
  expireSnoozed(now = this.now()): number {
    return Number(this.db.prepare("UPDATE suggestions SET status='open', snooze_until=NULL, updated=? WHERE status='snoozed' AND snooze_until IS NOT NULL AND snooze_until<=?").run(now, now).changes);
  }
  /** A detector withdraws an open card when its condition no longer holds. Only `open` rows are deleted. */
  withdrawOpen(ruleId: string, keep: Set<string>): number {
    const rows = this.db.prepare("SELECT id, fingerprint FROM suggestions WHERE rule_id=? AND source='detector' AND status='open'").all(ruleId) as { id: number; fingerprint: string }[];
    let n = 0;
    for (const r of rows) if (!keep.has(r.fingerprint)) { this.db.prepare("DELETE FROM suggestions WHERE id=? AND status='open'").run(r.id); n++; }
    return n;
  }

  setUndo(id: number, inverse: Inverse) {
    this.db.prepare("INSERT OR REPLACE INTO undo(suggestion_id,inverse,expires) VALUES (?,?,?)").run(id, JSON.stringify(inverse), this.now() + UNDO_DAYS * 86_400_000);
  }
  /** The inverse of a done card, while it is still inside the undo window. */
  getUndo(id: number): Inverse | undefined {
    const r = this.db.prepare("SELECT inverse FROM undo WHERE suggestion_id=? AND expires>?").get(id, this.now()) as { inverse: string } | null;
    return r ? JSON.parse(r.inverse) : undefined;
  }
  clearUndo(id: number) { this.db.prepare("DELETE FROM undo WHERE suggestion_id=?").run(id); }
  /** Write one decision to the outcome log. The agree rate and tuning cards read it. */
  record(card: Suggestion, action: OutcomeAction, reason?: string | null, note?: string | null) {
    this.db.prepare("INSERT INTO outcomes(suggestion_id,kind,rule_id,source,action,reason,note,ts) VALUES (?,?,?,?,?,?,?,?)")
      .run(card.id, card.kind, card.ruleId, card.source, action, reason ?? null, note ?? null, this.now());
  }
  outcomes(sinceMs = 0): Outcome[] {
    return (this.db.prepare("SELECT * FROM outcomes WHERE ts>=? ORDER BY id").all(sinceMs) as Record<string, unknown>[]).map(r => ({
      id: r.id as number, suggestionId: r.suggestion_id as number, kind: r.kind as StewardKind, ruleId: r.rule_id as string, source: r.source as string,
      action: r.action as OutcomeAction, reason: r.reason as string | null, note: r.note as string | null, ts: r.ts as number }));
  }
  /** Dismiss with a reason. `not_now` snoozes 30 days, `already_done` closes the card as done, the rest dismiss for good. */
  dismiss(id: number, reason?: DismissReason, note?: string) {
    const card = this.get(id)!;
    if (reason === "not_now") this.setStatus(id, "snoozed", { snoozeUntil: this.now() + NOT_NOW_DAYS * 86_400_000 });
    else if (reason === "already_done") this.setStatus(id, "done", { result: "Already done." });
    else this.setStatus(id, "dismissed");
    this.record(card, "dismiss", reason, note);
  }
  /** Recent dismiss notes, so the model pass does not file what you rejected and why. */
  recentNotes(limit = 20): { title: string; reason: string | null; note: string }[] {
    return this.db.prepare(`SELECT s.title AS title, o.reason AS reason, o.note AS note FROM outcomes o JOIN suggestions s ON s.id=o.suggestion_id
      WHERE o.action='dismiss' AND o.note IS NOT NULL AND o.note<>'' ORDER BY o.id DESC LIMIT ?`).all(limit) as never;
  }
}
