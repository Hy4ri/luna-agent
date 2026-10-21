// Session learning: detect -> diagnose -> fix -> measure, outside the live agent loop.
// 1. Detect (code, no model): after a conversation goes idle its transcript is scanned for user corrections, explicit
//    rules, recovered and unrecovered tool errors, and which skills it loaded. Signals store pointers (conversation +
//    entry id) and a short redacted summary, never transcript copies.
// 2. Diagnose (daily model pass): signals are grouped into lessons with a cause. The cause picks the fix:
//    missing -> add text, not_loaded -> fix the skill trigger, ignored -> needs a code guard (text will not help),
//    wrong -> edit or remove the rule.
// 3. Fix: a lesson becomes a proposal only with evidence from 2+ sessions or an explicit user rule. A proposal is a
//    full SKILL.md checked by lint, its regression phrases and a growth budget. The diagnosis agent reviews it: a
//    routine fix is applied at once through SkillImprover (backup + rollback); only a fix the agent marks critical
//    waits for the user. The agent also dismisses noise lessons, so the user never triages them.
// 4. Measure: after apply, a recurrence makes the lesson ineffective; 3 later sessions that load the skill without a
//    recurrence confirm it. A lesson that fails twice, or whose cause is "ignored", is flagged for a code guard.
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineExtension, defineTool, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { containsBenchmark, signature, type SkillImprover } from "./improve.js";
import { messageText } from "./recall.js";
import type { MemoryStore } from "./memory.js";

export type SignalKind = "correction" | "rule" | "recovery" | "tool_error";
export type Cause = "missing" | "not_loaded" | "ignored" | "wrong";
export type Scope = "skill" | "memory";
export type LessonStatus = "candidate" | "corroborated" | "proposed" | "applied" | "confirmed" | "ineffective" | "rejected" | "retired";

export interface ScanMessage { entry: number; role: "user" | "assistant" | "toolResult"; text: string; ts: number | null; calls: { name: string; args: Record<string, unknown> }[]; toolName?: string; isError?: boolean }
export interface DetectedSignal { entry: number; kind: SignalKind; key: string | null; summary: string; skills: string[]; ts: number | null }
export interface SignalRow { id: number; conv: number; entry: number; kind: SignalKind; key: string | null; summary: string; skills: string; ts: number | null; lesson: number | null }
export interface LessonRow {
  id: number; key: string | null; claim: string; cause: Cause | null; scope: Scope; skill: string | null; status: LessonStatus;
  proposal: string | null; tests: string | null; fact_key: string | null; note: string | null; needs_guard: number; failures: number;
  version: number | null; applied_at: number | null; created: number; updated: number;
  /** Why the agent held the proposal for the user; null when it was routine. */
  critical: string | null;
}

/** Tokens, keys and passwords never enter the ledger. */
export function redact(s: string): string {
  return s
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g, "$1 [secret]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{8,}/g, "[secret]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[secret]")
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[secret]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[secret]");
}

const oneLine = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
// Arabic has no \b in JS regexes; end a word at whitespace, punctuation or end of text.
const AR_END = "(?=$|[\\s,.!?،؟])";
const CORRECTION = new RegExp(
  "^\\s*(?:no\\b|nope\\b|wrong\\b|incorrect\\b|that'?s not\\b|thats not\\b|not what i\\b|i said\\b|i told you\\b|i asked\\b|stop\\b|don'?t\\b|do not\\b|" +
  "why did you\\b|why are you\\b|you didn'?t\\b|you did not\\b|you forgot\\b|undo\\b|revert\\b|that is wrong\\b|" +
  `(?:لا|لأ|غلط|خطأ|مش هيك|مش هاد|مش هذا|قلتلك|قلت لك|ليش|وقف|بطل|ما طلبت)${AR_END})`, "i");
const RULE = new RegExp(
  "\\b(?:always|never|from now on|every time|each time|in future|going forward|remember that|remember to)\\b|" +
  `(?:^|\\s)(?:دايما|دائما|أبدا|ابدا|من هلأ|من هلق|كل مرة|كل ما|تذكري|تذكر)${AR_END}`, "i");

/** Pure detector over one conversation's messages (oldest first). */
export function detectSignals(msgs: ScanMessage[]): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  const skills: string[] = [];
  let sawAssistant = false;
  let lastTool: string | null = null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === "assistant") {
      sawAssistant = true;
      for (const c of m.calls) {
        lastTool = c.name;
        if (c.name === "skill_view" && typeof c.args.name === "string" && !c.args.file_path && !skills.includes(c.args.name)) skills.push(c.args.name);
      }
      continue;
    }
    if (m.role === "user") {
      const text = m.text.trim();
      if (!text || text.startsWith("[")) continue; // system-injected notices ([process finished], [side job], ...)
      const summary = oneLine(redact(text), 240);
      if (RULE.test(text)) out.push({ entry: m.entry, kind: "rule", key: null, summary, skills: [...skills], ts: m.ts });
      else if (sawAssistant && CORRECTION.test(text)) out.push({ entry: m.entry, kind: "correction", key: lastTool ? `after:${lastTool}` : null, summary, skills: [...skills], ts: m.ts });
      continue;
    }
    if (m.role === "toolResult" && m.isError && m.toolName) {
      const sig = signature(redact(m.text)) || "(empty error)";
      // Recovered when the same tool succeeds before the next user turn.
      let recovered = false;
      for (let j = i + 1; j < msgs.length && msgs[j]!.role !== "user"; j++) {
        const n = msgs[j]!;
        if (n.role === "toolResult" && n.toolName === m.toolName && !n.isError) { recovered = true; break; }
      }
      const kind: SignalKind = recovered ? "recovery" : "tool_error";
      out.push({ entry: m.entry, kind, key: `${kind}:${m.toolName}:${sig}`, summary: oneLine(`${m.toolName}: ${redact(m.text)}`, 240), skills: [...skills], ts: m.ts });
    }
  }
  return out;
}

/** Skills a conversation loaded with skill_view. */
export function loadedSkills(msgs: ScanMessage[]): string[] {
  const s = new Set<string>();
  for (const m of msgs) for (const c of m.calls) if (c.name === "skill_view" && typeof c.args.name === "string" && !c.args.file_path) s.add(c.args.name);
  return [...s];
}

type RawMsg = { role?: string; content?: unknown; timestamp?: number; toolName?: string; isError?: boolean };

/** One conversation's own messages (inherited fork entries excluded), oldest first. */
export async function readConversation(tx: Pick<Tx, "scanEntries">, conv: number): Promise<{ msgs: ScanMessage[]; lastEntry: number }> {
  const msgs: ScanMessage[] = [];
  let cursor, last = 0;
  do {
    const page = await tx.scanEntries({ conversationId: conv as never, order: "ascending" }, 200, cursor);
    for (const e of page.items as EntryRecord[]) {
      last = Math.max(last, e.id as number);
      if ((e.conversationId as number) !== conv) continue;
      for (const m of (e.model ?? []) as RawMsg[]) {
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") continue;
        const calls = m.role === "assistant" && Array.isArray(m.content)
          ? (m.content as { type?: string; name?: string; arguments?: unknown }[]).filter((b) => b.type === "toolCall" && b.name)
            .map((b) => ({ name: b.name!, args: (b.arguments && typeof b.arguments === "object" ? b.arguments : {}) as Record<string, unknown> }))
          : [];
        const text = m.role === "toolResult" && Array.isArray(m.content)
          ? (m.content as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
          : messageText(m as never);
        msgs.push({ entry: e.id as number, role: m.role, text, ts: m.timestamp ?? null, calls, ...(m.role === "toolResult" ? { toolName: m.toolName, isError: !!m.isError } : {}) });
      }
    }
    cursor = page.next;
  } while (cursor);
  return { msgs, lastEntry: last };
}

/** Sessions after apply that loaded the skill with no recurrence before a lesson counts as confirmed. */
export const CONFIRM_SESSIONS = 3;
/** Maximum growth of an existing skill per proposal: edits must merge or replace text, not only add it. */
export const GROWTH_BUDGET = 1500;
const OPEN: LessonStatus[] = ["candidate", "corroborated", "proposed", "ineffective"];

export class LearnStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scans (conv INTEGER PRIMARY KEY, last_entry INTEGER NOT NULL, started INTEGER, scanned INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_use (conv INTEGER NOT NULL, skill TEXT NOT NULL, started INTEGER, PRIMARY KEY (conv, skill));
      CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY, key TEXT UNIQUE, claim TEXT NOT NULL, cause TEXT, scope TEXT NOT NULL DEFAULT 'skill', skill TEXT,
        status TEXT NOT NULL DEFAULT 'candidate', proposal TEXT, tests TEXT, fact_key TEXT, note TEXT,
        needs_guard INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, version INTEGER, applied_at INTEGER,
        created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY, conv INTEGER NOT NULL, entry INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT, summary TEXT NOT NULL,
        skills TEXT NOT NULL DEFAULT '[]', ts INTEGER, lesson INTEGER REFERENCES lessons(id), UNIQUE (conv, entry, kind));
      CREATE INDEX IF NOT EXISTS signals_lesson ON signals(lesson);
    `);
    const cols = this.db.prepare("PRAGMA table_info(lessons)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "critical")) {
      // Proposals from before automatic review were waiting for the user; they stay with the user.
      this.db.exec("ALTER TABLE lessons ADD COLUMN critical TEXT; UPDATE lessons SET critical='proposed before automatic review' WHERE status='proposed'");
    }
  }
  close() { this.db.close(); }

  scanned(conv: number): number | undefined {
    return (this.db.prepare("SELECT last_entry FROM scans WHERE conv=?").get(conv) as { last_entry: number } | undefined)?.last_entry;
  }

  /** Record one scanned conversation. Returns the ids of new signals. Tool signals group into lessons by key at once. */
  ingest(conv: number, msgs: ScanMessage[], lastEntry: number, now = Date.now()): number[] {
    const started = msgs.find((m) => m.ts)?.ts ?? null;
    const ins = this.db.prepare("INSERT OR IGNORE INTO signals(conv, entry, kind, key, summary, skills, ts) VALUES (?,?,?,?,?,?,?)");
    const ids: number[] = [];
    this.db.exec("BEGIN");
    try {
      for (const s of detectSignals(msgs)) {
        const r = ins.run(conv, s.entry, s.kind, s.key, s.summary, JSON.stringify(s.skills), s.ts);
        if (r.changes) ids.push(Number(r.lastInsertRowid));
      }
      for (const sk of loadedSkills(msgs)) this.db.prepare("INSERT OR IGNORE INTO skill_use(conv, skill, started) VALUES (?,?,?)").run(conv, sk, started);
      this.db.prepare("INSERT INTO scans(conv, last_entry, started, scanned) VALUES (?,?,?,?) ON CONFLICT(conv) DO UPDATE SET last_entry=excluded.last_entry, scanned=excluded.scanned")
        .run(conv, lastEntry, started, now);
      // Deterministic tool-error keys need no model to group them.
      for (const id of ids) {
        const s = this.signal(id)!;
        if (s.kind !== "recovery" && s.kind !== "tool_error") continue;
        let l = this.db.prepare("SELECT * FROM lessons WHERE key=?").get(s.key) as LessonRow | undefined;
        if (!l) {
          const claim = `${s.kind === "recovery" ? "Recovered from" : "Unrecovered"} ${s.summary.split(":")[0]} error: ${s.key!.split(":").slice(2).join(":")}`;
          const lid = Number(this.db.prepare("INSERT INTO lessons(key, claim, scope, created, updated) VALUES (?,?,'skill',?,?)").run(s.key, oneLine(claim, 240), now, now).lastInsertRowid);
          l = this.lesson(lid)!;
        }
        this.attachRaw(l, [id], now);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this.measure(now);
    return ids;
  }

  signal(id: number) { return this.db.prepare("SELECT * FROM signals WHERE id=?").get(id) as SignalRow | undefined; }
  lesson(id: number) { return this.db.prepare("SELECT * FROM lessons WHERE id=?").get(id) as LessonRow | undefined; }
  unassigned(limit = 50) { return this.db.prepare("SELECT * FROM signals WHERE lesson IS NULL ORDER BY id LIMIT ?").all(limit) as unknown as SignalRow[]; }
  lessons(status?: LessonStatus[]) {
    const rows = this.db.prepare("SELECT * FROM lessons ORDER BY updated DESC").all() as unknown as LessonRow[];
    return status ? rows.filter((r) => status.includes(r.status)) : rows;
  }
  evidence(lesson: number) { return this.db.prepare("SELECT * FROM signals WHERE lesson=? ORDER BY id").all(lesson) as unknown as SignalRow[]; }
  sessions(lesson: number) { return (this.db.prepare("SELECT COUNT(DISTINCT conv) n FROM signals WHERE lesson=?").get(lesson) as { n: number }).n; }

  private set(id: number, fields: Partial<LessonRow>, now = Date.now()) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE lessons SET ${keys.map((k) => `${k}=?, `).join("")}updated=? WHERE id=?`)
      .run(...keys.map((k) => (fields as Record<string, never>)[k] ?? null), now, id);
  }

  /** Link signals to a lesson and apply the status rules. */
  private attachRaw(l: LessonRow, signalIds: number[], now: number) {
    for (const sid of signalIds) this.db.prepare("UPDATE signals SET lesson=? WHERE id=?").run(l.id, sid);
    const sigs = signalIds.map((s) => this.signal(s)!);
    if ((l.status === "applied" || l.status === "confirmed") && l.applied_at) {
      // A recurrence in a session that started after the fix: the fix did not work.
      const after = sigs.filter((s) => (this.sessionStart(s.conv) ?? s.ts ?? 0) >= l.applied_at!);
      if (after.length) {
        const failures = l.failures + 1;
        this.set(l.id, { status: "ineffective", failures, needs_guard: failures >= 2 || l.cause === "ignored" ? 1 : l.needs_guard }, now);
        return;
      }
    }
    if (l.status === "candidate" && this.corroborated(l.id)) this.set(l.id, { status: "corroborated" }, now);
    else this.set(l.id, {}, now);
  }

  private sessionStart(conv: number) { return (this.db.prepare("SELECT started FROM scans WHERE conv=?").get(conv) as { started: number | null } | undefined)?.started ?? null; }

  /** Evidence rule: 2+ separate sessions, or an explicit user rule. One unverified outcome is never a general rule. */
  corroborated(lesson: number) {
    return this.sessions(lesson) >= 2 || this.evidence(lesson).some((s) => s.kind === "rule");
  }

  /** Create a lesson or add evidence to one (model pass). */
  record(a: { lesson_id?: number; claim?: string; cause?: Cause; scope?: Scope; skill?: string; signal_ids?: number[] }, now = Date.now()): LessonRow {
    const signalIds = a.signal_ids ?? [];
    for (const sid of signalIds) if (!this.signal(sid)) throw new Error(`no such signal ${sid}`);
    this.db.exec("BEGIN");
    try {
      let l: LessonRow;
      if (a.lesson_id !== undefined) {
        const found = this.lesson(a.lesson_id);
        if (!found) throw new Error(`no such lesson ${a.lesson_id}`);
        l = found;
        const upd: Partial<LessonRow> = {};
        if (a.claim) upd.claim = oneLine(redact(a.claim), 400);
        if (a.cause) upd.cause = a.cause;
        if (a.skill) upd.skill = a.skill;
        if (a.scope) upd.scope = a.scope;
        if (Object.keys(upd).length) { this.set(l.id, upd, now); l = this.lesson(l.id)!; }
      } else {
        if (!a.claim?.trim()) throw new Error("claim is required for a new lesson");
        const id = Number(this.db.prepare("INSERT INTO lessons(claim, cause, scope, skill, created, updated) VALUES (?,?,?,?,?,?)")
          .run(oneLine(redact(a.claim), 400), a.cause ?? null, a.scope ?? "skill", a.skill ?? null, now, now).lastInsertRowid);
        l = this.lesson(id)!;
      }
      if (l.cause === "ignored" && !l.needs_guard) { this.set(l.id, { needs_guard: 1 }, now); l = this.lesson(l.id)!; }
      this.attachRaw(l, signalIds, now);
      this.db.exec("COMMIT");
      return this.lesson(l.id)!;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /**
   * Verify a fix. A routine fix is applied at once (backup + rollback). A fix with a `critical` reason is held for
   * the user and applied only on approval.
   */
  async propose(imp: SkillImprover, a: { lesson_id: number; content?: string; must_contain?: string[]; fact?: string; fact_key?: string; critical?: string },
    memory?: MemoryStore, now = Date.now()): Promise<LessonRow> {
    const l = this.lesson(a.lesson_id);
    if (!l) throw new Error(`no such lesson ${a.lesson_id}`);
    if (l.status === "rejected") throw new Error(`lesson ${l.id} was rejected${l.note ? `: ${l.note}` : ""}. Do not propose it again.`);
    if (l.status !== "corroborated" && l.status !== "ineffective" && l.status !== "proposed")
      throw new Error(`lesson ${l.id} is ${l.status}; a proposal needs evidence from 2+ sessions or an explicit user rule`);
    if (l.status === "proposed" && l.critical) throw new Error(`lesson ${l.id} is waiting for the user (${l.critical}); leave it`);
    const critical = a.critical?.trim() ? oneLine(redact(a.critical), 300) : null;
    if (!l.cause) throw new Error("set the lesson cause with lesson_record first");
    if (l.cause === "ignored") {
      this.set(l.id, { needs_guard: 1 }, now);
      throw new Error("cause is 'ignored': the rule already exists and more text will not help. The lesson is flagged for a code guard; leave it for review.");
    }
    if (l.scope === "memory") {
      const fact = a.fact?.trim();
      if (!fact) throw new Error("memory lessons need `fact`");
      this.set(l.id, { status: "proposed", proposal: oneLine(redact(fact), 600), fact_key: a.fact_key ?? null, tests: null, critical }, now);
      return critical ? this.lesson(l.id)! : this.approve(l.id, imp, memory, now);
    }
    if (!l.skill) throw new Error("set the target skill with lesson_record first");
    if (!a.content) throw new Error("skill lessons need `content` (full SKILL.md)");
    const tests = (a.must_contain ?? []).map((t) => t.trim()).filter(Boolean);
    if (!tests.length) throw new Error("must_contain is required: the phrases that prevent the recorded failure (the regression test)");
    const current = imp.read(l.skill);
    if (current !== undefined && a.content.length > current.length + GROWTH_BUDGET)
      throw new Error(`proposal grows ${l.skill} by ${a.content.length - current.length} chars (budget ${GROWTH_BUDGET}); merge or remove text instead of only adding`);
    if (l.cause === "not_loaded" && current !== undefined && imp.description(a.content) === imp.description(current))
      throw new Error("cause is 'not_loaded': the fix must change the skill description (its trigger), not only the body");
    const r = await imp.propose(l.skill, a.content, containsBenchmark(tests), true);
    if (r.reason !== "verified (dry run, not written)") throw new Error(`proposal failed verification: ${r.reason}${r.lint.length ? ` (${r.lint.join("; ")})` : ""}`);
    this.set(l.id, { status: "proposed", proposal: a.content, tests: JSON.stringify(tests), critical }, now);
    return critical ? this.lesson(l.id)! : this.approve(l.id, imp, memory, now);
  }

  /** Apply a stored proposal (the agent for routine fixes, the user for critical ones). Skills go through SkillImprover (lint + regression phrases + backup). */
  async approve(id: number, imp: SkillImprover, memory?: MemoryStore, now = Date.now()): Promise<LessonRow> {
    const l = this.lesson(id);
    if (!l) throw new Error(`no such lesson ${id}`);
    if (l.status !== "proposed" || !l.proposal) throw new Error(`lesson ${id} has no pending proposal`);
    if (l.scope === "memory") {
      if (!memory) throw new Error("memory is disabled");
      memory.remember({ content: l.proposal, ...(l.fact_key ? { key: l.fact_key } : {}), tags: ["lesson"] });
      this.set(id, { status: "applied", applied_at: now, version: null }, now);
      return this.lesson(id)!;
    }
    const r = await imp.propose(l.skill!, l.proposal, containsBenchmark(JSON.parse(l.tests ?? "[]")));
    if (!r.applied) throw new Error(`not applied: ${r.reason}`);
    // `version` is the backup of the previous content (null for a new skill): the rollback target.
    this.set(id, { status: "applied", applied_at: now, version: r.version }, now);
    return this.lesson(id)!;
  }

  reject(id: number, note: string, now = Date.now()): LessonRow {
    const l = this.lesson(id);
    if (!l) throw new Error(`no such lesson ${id}`);
    if (l.status === "rejected" || l.status === "retired") throw new Error(`lesson ${id} is already ${l.status}`);
    this.set(id, { status: "rejected", note: oneLine(note || "rejected", 400), proposal: null, tests: null, critical: null }, now);
    return this.lesson(id)!;
  }

  /** Agent triage: drop a lesson that is noise. A proposal held for the user and an applied change are not the agent's to drop. */
  dismiss(id: number, reason: string, now = Date.now()): LessonRow {
    const l = this.lesson(id);
    if (!l) throw new Error(`no such lesson ${id}`);
    if (l.status === "proposed" && l.critical) throw new Error(`lesson ${id} is waiting for the user; leave it`);
    if (l.status === "applied" || l.status === "confirmed") throw new Error(`lesson ${id} is ${l.status}; only the user can roll it back`);
    if (!reason.trim()) throw new Error("reason is required");
    return this.reject(id, `dismissed by Luna: ${reason}`, now);
  }

  /** Undo an applied skill change: restore the backup taken at apply time. */
  rollback(id: number, imp: SkillImprover, now = Date.now()): LessonRow {
    const l = this.lesson(id);
    if (!l) throw new Error(`no such lesson ${id}`);
    if (!["applied", "confirmed", "ineffective"].includes(l.status) || l.scope !== "skill" || !l.skill) throw new Error(`lesson ${id} has no applied skill change`);
    if (l.version === null) throw new Error(`${l.skill} was created by this lesson; no previous version to restore`);
    imp.rollback(l.skill, l.version);
    this.set(id, { status: "retired" }, now);
    return this.lesson(id)!;
  }

  /** Confirm applied lessons whose skill loaded in enough later sessions without a recurrence. */
  measure(now = Date.now()) {
    for (const l of this.lessons(["applied"])) {
      if (l.scope !== "skill" || !l.skill || !l.applied_at) continue;
      const n = (this.db.prepare("SELECT COUNT(*) n FROM skill_use WHERE skill=? AND started>=?").get(l.skill, l.applied_at) as { n: number }).n;
      if (n >= CONFIRM_SESSIONS) this.set(l.id, { status: "confirmed" }, now);
    }
  }
}

export interface LearnScannerOptions {
  store: LearnStore;
  commit: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** A conversation counts as idle when its newest message is this old. */
  idleMs: number;
  /** Conversations to skip (cron runs: their "user" text is a prompt, not a person). */
  skip?: (conv: number) => boolean;
  log?: (m: string) => void;
}

/** Conversations read per scan; the rest wait for the next tick, so a first backfill never blocks chat for long. */
export const SCAN_BATCH = 20;

/**
 * Scan idle conversations that have new entries since their last scan. Subagent and skipped conversations are ignored.
 * One short transaction lists candidates, then each conversation is read in its own transaction.
 */
export async function scanIdle(o: LearnScannerOptions, now = Date.now()): Promise<{ scanned: number; signals: number }> {
  const due = await o.commit(async (tx) => {
    const ids: number[] = [];
    let cursor;
    do {
      const page = await tx.scanConversations({ order: "ascending" }, 200, cursor);
      for (const c of page.items) {
        const id = c.id as number;
        if (c.owner || o.skip?.(id)) continue;
        const top = (await tx.scanEntries({ conversationId: c.id, order: "descending" }, 1)).items[0];
        if (top && (o.store.scanned(id) ?? 0) < (top.id as number)) ids.push(id);
      }
      cursor = page.next;
    } while (cursor);
    return ids;
  });
  let scanned = 0, signals = 0;
  for (const id of due) {
    if (scanned >= SCAN_BATCH) break;
    const { msgs, lastEntry } = await o.commit((tx) => readConversation(tx, id));
    const lastTs = msgs.reduce((m, x) => Math.max(m, x.ts ?? 0), 0);
    if (msgs.length && now - lastTs < o.idleMs) continue; // still active; empty ones are recorded so they are not re-read
    signals += o.store.ingest(id, msgs, lastEntry, now).length;
    scanned++;
  }
  if (scanned) o.log?.(`learn: scanned ${scanned} conversation(s), ${signals} new signal(s)`);
  return { scanned, signals };
}

/** Name and prompt of the built-in daily diagnosis job. */
export const LEARN_JOB = "luna-learn";
export const LEARN_PROMPT =
  "Learning pass. You review lessons for the user: apply routine fixes yourself and hold only critical ones. " +
  "Load the tools with tool_search \"learn lessons\" if they are not available. 1) Call learn_review. If it shows no unassigned signals " +
  "and no candidate, corroborated, ineffective or code-guard lessons, answer 'nothing to learn' and stop. 2) For each unassigned correction or rule, read its context with " +
  "session_search {sessionId, aroundMessageId}. Group signals that teach the same thing with lesson_record (one claim, a cause, a scope, a target skill). " +
  "Ignore signals that are not about how Luna works (casual talk, one-off task details). Use the causes exactly: missing = no rule existed; " +
  "not_loaded = a skill had the rule but was not loaded; ignored = the skill was loaded and the rule was ignored; wrong = the rule itself is wrong. " +
  "3) For each corroborated or ineffective lesson with cause missing, not_loaded or wrong, load the target skill with skill_view and call lesson_propose " +
  "with the full new SKILL.md and must_contain phrases that would have prevented the failure. Keep the skill the same size or smaller: merge or replace text. " +
  "Memory lessons (facts true in every session) need `fact`. Never propose a rejected lesson. A proposal is applied at once unless you set `critical`. " +
  "Set `critical` (one line: why the user must decide) only when the fix removes or reverses an existing rule, changes identity, safety, permission, " +
  "publishing, money or privacy behavior, or you are unsure the evidence supports it. 4) Call lesson_dismiss with a reason for each lesson that is noise: " +
  "a normal retry, a one-off task detail, a mistaken signal, or a code-guard lesson that no longer applies. Do not dismiss a lesson only because it is old. " +
  "5) Answer with what you recorded, applied, held for the user, and dismissed.";

const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const fmtLesson = (s: LearnStore, l: LessonRow) =>
  `lesson ${l.id} [${l.status}${l.status === "proposed" && l.critical ? ", held for the user" : ""}${l.needs_guard ? ", needs code guard" : ""}] ${l.claim}` +
  `\n   cause: ${l.cause ?? "?"} · scope: ${l.scope}${l.skill ? ` · skill: ${l.skill}` : ""} · sessions: ${s.sessions(l.id)}${l.note ? ` · note: ${l.note}` : ""}`;

/** Tools for the diagnosis pass. Deferred: normal sessions never pay for their schemas. */
export function createLearnExtension(store: LearnStore, imp: SkillImprover, memory?: MemoryStore) {
  const review = defineTool({
    name: "learn_review",
    description: "Learning ledger: unassigned session signals (corrections, rules, tool errors) with session/message pointers, and open lessons.",
    deferred: true,
    parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "Max unassigned signals (default 40)." })) }),
    replay: "safe",
    async execute({ limit }) {
      const sig = store.unassigned(limit ?? 40);
      const open = store.lessons([...OPEN, "applied"]);
      const rejected = store.lessons(["rejected"]);
      const parts = [
        sig.length ? "Unassigned signals:\n" + sig.map((s) => `signal ${s.id} · ${s.kind} · session ${s.conv} · message ${s.entry}${JSON.parse(s.skills).length ? ` · skills loaded: ${JSON.parse(s.skills).join(", ")}` : ""}\n   ${s.summary}`).join("\n") : "No unassigned signals.",
        open.length ? "Lessons:\n" + open.map((l) => fmtLesson(store, l)).join("\n") : "No open lessons.",
        ...(rejected.length ? ["Rejected (never propose again):\n" + rejected.map((l) => fmtLesson(store, l)).join("\n")] : []),
      ];
      return text(parts.join("\n\n"));
    },
  });
  const record = defineTool({
    name: "lesson_record",
    description: "Create a lesson from signals, or add signals/cause/skill to an existing lesson (lesson_id). Status rules are applied in code.",
    deferred: true,
    parameters: Type.Object({
      lesson_id: Type.Optional(Type.Number()),
      claim: Type.Optional(Type.String({ description: "One imperative rule and why. No dates, ids or private details." })),
      cause: Type.Optional(Type.Union([Type.Literal("missing"), Type.Literal("not_loaded"), Type.Literal("ignored"), Type.Literal("wrong")])),
      scope: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("memory")])),
      skill: Type.Optional(Type.String({ description: "Target skill name (scope skill)." })),
      signal_ids: Type.Optional(Type.Array(Type.Number())),
    }),
    replay: "unsafe",
    async execute(a) {
      try { return text(fmtLesson(store, store.record(a))); }
      catch (e) { return text((e as Error).message, true); }
    },
  });
  const propose = defineTool({
    name: "lesson_propose",
    description: "Verify and apply a fix for a corroborated lesson (backup + rollback). Skill: full SKILL.md + must_contain regression phrases. Memory: fact (+ fact_key). Set critical to hold it for the user instead of applying.",
    deferred: true,
    parameters: Type.Object({
      lesson_id: Type.Number(),
      content: Type.Optional(Type.String({ description: "Complete SKILL.md including frontmatter." })),
      must_contain: Type.Optional(Type.Array(Type.String())),
      fact: Type.Optional(Type.String()),
      fact_key: Type.Optional(Type.String()),
      critical: Type.Optional(Type.String({ description: "Only for a fix the user must decide: one line saying why. Omit to apply now." })),
    }),
    replay: "unsafe",
    async execute(a) {
      try {
        const l = await store.propose(imp, a, memory);
        return text(fmtLesson(store, l) + (l.status === "proposed" ? "\nHeld for the user." : "\nApplied. The user can roll it back."));
      } catch (e) { return text((e as Error).message, true); }
    },
  });
  const dismiss = defineTool({
    name: "lesson_dismiss",
    description: "Drop a lesson that is noise (normal retry, one-off detail, mistaken signal). It is never proposed again. Cannot drop applied lessons or ones held for the user.",
    deferred: true,
    parameters: Type.Object({ lesson_id: Type.Number(), reason: Type.String({ description: "One line: why this is not a lesson." }) }),
    replay: "unsafe",
    async execute({ lesson_id, reason }) {
      try { return text(fmtLesson(store, store.dismiss(lesson_id, reason))); }
      catch (e) { return text((e as Error).message, true); }
    },
  });
  return defineExtension({ name: "learn", tools: [review, record, propose, dismiss] });
}
