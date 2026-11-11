// Runs the detectors, files their cards, and carries out an agreed card.
import type { AnalyticsStore } from "../analytics/store.js";
import { ConversationError, type ConversationStore } from "../conversations.js";
import { batchCards, misfiledSessions, newProjects, staleSessions, type DetectorConfig } from "./detectors.js";
import { bgLeftovers, projectSetupRepeat, promptRepeat, skillsUnused, toolErrorRepeat, worktreeOrphans, browserLeftovers, type BrowserTabView, type TerminalView } from "./detectors3.js";
import { boardStuck, cronFailing, goalUnfinished, quotaWaits } from "./detectors2.js";
import { inQuietHours, inScope, startOfLocalDay, type WifePolicy } from "./policy.js";
import { agreeRate, DAY as LDAY, metaCards, META_RULES, ruleStats, TUNABLE } from "./learning.js";
import { type CostRow, compactionHeavy, costHabit, weeklyRecap } from "./detectors4.js";
import { matchTips, TipSchema, type ToolCounts, type WifeTip } from "./tips.js";
import type { NewSuggestion, Inverse, Suggestion, WifeStore } from "./store.js";

const DETECTOR_RULES = ["goal_unfinished", "cron_failing", "quota_waits", "board_stuck", "worktree_orphan", "bg_leftover", "browser_leftover", "tool_error_repeat", "skill_unused", "prompt_repeat", "project_setup_repeat", "cost_habit", "compaction_heavy", "weekly_recap", "promote_rule", "archive_session", "delete_session", "move_session", "new_project"]  // tip rules are added per tip id;
export class WifeError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message); } }

export interface WifeServiceOptions {
  store: WifeStore; analytics: () => AnalyticsStore; conversations: ConversationStore;
  config: () => DetectorConfig & { enabled: boolean; detectEveryMinutes: number; tips?: WifeTip[]; mutedRules?: string[]; mutedKinds?: string[] } & Partial<WifePolicy>;
  /** Change a value in the `wife` config block. Used by tune and mute cards. */
  /** Cron jobs and their latest runs, newest first, and a way to disable one. */
  cron?: { jobs: () => { id: number; name: string; enabled: boolean; runs: { status: string; output: string | null; startedAt: number }[] }[]; disable: (id: number) => void };
  setConfig?: (fn: (w: Record<string, unknown>) => void) => void;
  /** Settings mutation used by a tip that enables an extension. */
  /** Write a memory. Returns the key and the content it replaced (null when new). */
  remember?: (input: { key?: string; content: string }) => { key: string | null; before: string | null };
  /** Start a session with a first message (the webhook path). Returns the session id. */
  startSession?: (project: number | null, title: string, content: string, requestId: string) => Promise<number>;
  /** Session worktrees (git). Agree removes one that is clean. */
  worktrees?: () => { path: string; branch: string; merged: boolean; dirty: boolean }[];
  removeWorktree?: (path: string, branch: string) => Promise<void>;
  terminals?: () => TerminalView[];
  closeTerminal?: (id: string) => void;
  browserTabs?: () => BrowserTabView[];
  closeBrowserTab?: (session: number, tabId: string) => Promise<void>;
  /** Installed skills, and a way to move a managed one to the skill trash. */
  skills?: () => { name: string; managed: boolean; modified: number }[];
  trashSkill?: (name: string) => void;
  /** User messages from the recall index since `since`. `first` keeps one message per session: its first. */
  userMessages?: (since: number, first: boolean) => { conv: number; ts: number; text: string }[];
  skillExists?: (name: string) => boolean;
  /** Schedule a message into a session. Throws when the time is past. */
  scheduleMessage?: (sessionId: number, content: string, dueAt: number, requestId: string) => Promise<void>;
  restoreMemory?: (key: string, content: string | null) => Promise<void> | void;
  extensions?: { enabled(name: string): boolean; enable(name: string): void }; now?: () => number; log?: (m: string) => void;
}

const id_ = (c: { id: number }) => c.id;
const DAY = 86_400_000;
export class WifeService {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private o: WifeServiceOptions) {}
  get store() { return this.o.store; }

  /** Run every detector once. File new cards, refresh open ones, and withdraw open cards that no longer apply. */
  scan(opts: { session?: number } = {}): { filed: number; withdrawn: number; held: number } {
    const now = (this.o.now ?? Date.now)();
    this.o.store.expireSnoozed(now);
    const sessions = this.o.analytics().sessions();
    this.settleWorking(sessions);
    const projects = this.o.conversations.projects.list();
    const found = [...batchCards([...staleSessions(sessions, this.o.config(), now), ...misfiledSessions(sessions, projects)]), ...newProjects(sessions, projects, now)];
    const store = this.o.analytics();
    const tips = this.o.config().tips ?? [];
    const FACT = { tool: "tool", skill: "skill", compaction: "compaction" } as const;
    const scopeSql = (t?: WifeTip): { sql: string; args: (string | number)[] } => {
      const sql: string[] = [], args: (string | number)[] = [];
      if (t?.when.project !== undefined) { sql.push("s.project_id=?"); args.push(t.when.project); }
      if (t?.when.cwd) { sql.push("instr(s.cwd, ?)>0"); args.push(t.when.cwd); }
      return { sql: sql.map(x => ` AND ${x}`).join(""), args };
    };
    const toolCounts = (days: number, kind: keyof typeof FACT = "tool", tip?: WifeTip): ToolCounts => {
      const sc = scopeSql(tip);
      const rows = store.db.query<{ name: string; calls: number; sessions: number }, (string | number)[]>(
        `SELECT f.name AS name, COUNT(*) AS calls, COUNT(DISTINCT f.session_id) AS sessions FROM analytics_facts f JOIN analytics_sessions s ON s.id=f.session_id WHERE f.kind='${FACT[kind]}' AND f.ts>=? AND s.deleted_at IS NULL${sc.sql} GROUP BY f.name`).all(now - days * 86_400_000, ...sc.args);
      return new Map(rows.map(r => [r.name, { calls: r.calls, sessions: r.sessions }]));
    };
    const idleOf = (t: WifeTip): number | null => {
      const sc = scopeSql(t);
      const r = store.db.query<{ last: number | null }, (string | number)[]>(`SELECT MAX(f.ts) AS last FROM analytics_facts f JOIN analytics_sessions s ON s.id=f.session_id WHERE f.kind='${FACT[t.when.kind]}' AND f.name=? AND s.deleted_at IS NULL${sc.sql}`).get(t.when.tool, ...sc.args);
      return r?.last ? (now - r.last) / DAY : null;
    };
    const tipCards = matchTips(tips, toolCounts, n => this.o.extensions?.enabled(n) ?? false, false, idleOf);
    found.push(...tipCards, ...goalUnfinished(sessions, now));
    // Shadow rules only log. After 7 days a promote card shows what they would have flagged.
    for (const t of tips.filter(x => x.status === "shadow")) {
      for (const c of matchTips([t], toolCounts, n => this.o.extensions?.enabled(n) ?? false, true, idleOf)) this.o.store.logShadow(t.id, c.title, now);
      if (t.shadowSince !== undefined && now - t.shadowSince >= 7 * DAY) {
        const hits = this.o.store.shadowHits(t.id, t.shadowSince);
        found.push({ kind: "promote_rule", ruleId: "promote_rule", fingerprint: `promote_rule:${t.id}`, source: "detector", title: `Turn on your rule "${t.title}"?`,
          body: hits.length ? `It would have flagged ${hits.length} time${hits.length === 1 ? "" : "s"} in 7 days:\n${hits.slice(0, 7).map(h => `- ${new Date(h.ts).toISOString().slice(0, 10)}: ${h.title}`).join("\n")}\nAgree turns it on. Dismiss deletes it.`
            : "It would not have flagged anything in 7 days. Agree turns it on anyway. Dismiss deletes it.", evidence: [], payload: { tipId: t.id } });
      }
    }
    if (this.o.cron) found.push(...cronFailing(this.o.cron.jobs()));
    const waitRows = store.db.query<{ model: string; waits: number; sessions: number }, [number]>(
      "SELECT COALESCE(f.model,'unknown') AS model, COUNT(*) AS waits, COUNT(DISTINCT f.session_id) AS sessions FROM analytics_facts f WHERE f.kind='quota_wait' AND f.ts>=? GROUP BY 1").all(now - 7 * DAY);
    found.push(...quotaWaits(waitRows, String(Math.floor(now / (7 * DAY)))));
    const sessionById = new Map(sessions.map(s => [s.id, s]));
    const idleSession = (id: number) => { const s = sessionById.get(id); return !s || s.deletedAt !== null || s.archived || (s.status !== "running" && now - (s.lastActivity ?? s.createdAt ?? 0) >= DAY); };
    const cards = projects.flatMap(p => this.o.conversations.board.list(p.id).map(c => ({ project: p.id, id: c.id, subject: c.subject, status: c.status, updated: c.updated,
      ownerSession: /^session (\d+)$/.exec(c.owner ?? "")?.[1] ? Number(/^session (\d+)$/.exec(c.owner!)![1]) : null })));
    found.push(...boardStuck(cards, idleSession, now));
    const week = String(Math.floor(now / (7 * DAY)));
    const scopeNow = this.o.config().projects ?? { mode: "all" as const, ids: [] };
    const costRows = store.db.query<CostRow, [number]>("SELECT session_id AS session, COALESCE(model,'unknown') AS model, COALESCE(SUM(cost_total),0) AS cost, COUNT(*) AS turns FROM analytics_facts WHERE kind='response' AND ts>=? GROUP BY session_id, 2").all(now - 30 * DAY);
    found.push(...costHabit(costRows, sessions, week), ...weeklyRecap(cards.filter(c => inScope(scopeNow, c.project)), now, week));
    const compRows = store.db.query<{ session: number; n: number }, []>("SELECT f.session_id AS session, COUNT(*) AS n FROM analytics_facts f WHERE f.kind='compaction' GROUP BY f.session_id HAVING n>=3").all();
    found.push(...compactionHeavy(compRows, sessions, now));
    if (this.o.browserTabs) found.push(...browserLeftovers(this.o.browserTabs(), idleSession));
    if (this.o.worktrees) found.push(...worktreeOrphans(this.o.worktrees().map(w => {
      const sid = /^luna\/s(\d+)(?:-|$)/.exec(w.branch)?.[1]; const sessionId = sid ? Number(sid) : null;
      const rec = sessionId === null ? undefined : sessionById.get(sessionId);
      const gone = sessionId !== null && (!rec || rec.deletedAt !== null);
      // A fresh worktree is trivially merged. Count merged only once its session has been idle for a day.
      return { ...w, sessionId, sessionGone: gone, merged: w.merged && sessionId !== null && !gone && idleSession(sessionId) };
    })));
    if (this.o.terminals) found.push(...bgLeftovers(this.o.terminals(), idleSession));
    const errRows = store.db.query<{ name: string; errors: number; sessions: number; sample: string }, [number]>(
      "SELECT f.name AS name, COUNT(*) AS errors, COUNT(DISTINCT f.session_id) AS sessions, group_concat(DISTINCT f.session_id) AS sample FROM analytics_facts f JOIN analytics_sessions s ON s.id=f.session_id WHERE f.kind='tool' AND f.error=1 AND f.ts>=? AND s.deleted_at IS NULL GROUP BY f.name").all(now - 7 * DAY);
    found.push(...toolErrorRepeat(errRows.map(r => ({ ...r, sample: r.sample.split(",").map(Number) })), String(Math.floor(now / (7 * DAY)))));
    if (this.o.skills) {
      const use = store.db.query<{ name: string; last: number }, []>("SELECT name, MAX(ts) AS last FROM analytics_facts WHERE kind='skill' GROUP BY name").all();
      found.push(...skillsUnused(this.o.skills(), new Map(use.map(u => [u.name, u.last])), now));
    }
    if (this.o.userMessages) {
      found.push(...promptRepeat(this.o.userMessages(now - 60 * DAY, false)));
      found.push(...projectSetupRepeat(this.o.userMessages(now - 60 * DAY, true).map(m => ({ ...m, project: sessionById.get(m.conv)?.projectId ?? 0 }))));
    }
    const cfg = this.o.config();
    const muted = (c: { ruleId?: string; kind: string }) => (cfg.mutedRules ?? []).includes(c.ruleId ?? c.kind) || (cfg.mutedKinds ?? []).includes(c.kind);
    for (let i = found.length - 1; i >= 0; i--) if (muted(found[i]!)) found.splice(i, 1);
    const tunedAt = new Map<string, number>();
    for (const o of this.o.store.outcomes()) if (o.action === "agree" && o.ruleId === "tune_rule" && o.note?.startsWith("tuned:")) tunedAt.set(o.note.slice(6), o.ts);
    found.push(...metaCards({ outcomes: this.o.store.outcomes(now - 60 * LDAY), now, tunedAt, values: { staleDays: cfg.staleDays, deleteArchivedAfterDays: cfg.deleteArchivedAfterDays },
      mutedRules: cfg.mutedRules ?? [], mutedKinds: cfg.mutedKinds ?? [] }));
    // Scope: drop cards about sessions in projects Wife does not watch.
    const projectOf = new Map(sessions.map(s => [s.id, s.projectId]));
    const sessionsOf = (f: NewSuggestion): number[] => [...f.evidence.map(e => e.sessionId), ...(f.payload.sessionId !== undefined ? [Number(f.payload.sessionId)] : []), ...(Array.isArray(f.payload.sessionIds) ? (f.payload.sessionIds as number[]) : [])];
    const scope = cfg.projects ?? { mode: "all" as const, ids: [] };
    const wanted = opts.session;
    const inScopeCards = found.filter(f => { const ss = sessionsOf(f); return !ss.length || ss.every(i => inScope(scope, projectOf.get(i) ?? 0)); });
    const toFile = wanted === undefined ? inScopeCards : found.filter(f => sessionsOf(f).includes(wanted));
    let filed = 0;
    const quiet = inQuietHours(cfg.quietHours ?? null, now);
    for (const f of toFile) {
      const isNew = !this.o.store.has(f.fingerprint);
      this.o.store.file(f, wanted !== undefined || (!quiet && this.o.store.shownSince(startOfLocalDay(now)) < (cfg.maxNewPerDay ?? 10)));
      if (isNew) filed++;
      if (wanted !== undefined) this.o.store.show(f.fingerprint);
    }
    // Held cards wait for the quiet hours to end and for room under the daily cap.
    let held = 0;
    if (!quiet) this.o.store.release((cfg.maxNewPerDay ?? 10) - this.o.store.shownSince(startOfLocalDay(now)));
    held = (this.o.store.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE shown_at IS NULL AND status='open'").get() as { n: number }).n;
    if (wanted !== undefined) return { filed, withdrawn: 0, held };
    let withdrawn = 0;
    for (const rule of [...DETECTOR_RULES, ...META_RULES, ...tips.map(t => `tip:${t.id}`)])
      withdrawn += this.o.store.withdrawOpen(rule, new Set(inScopeCards.filter(f => (f.ruleId ?? f.kind) === rule).map(f => f.fingerprint)));
    return { filed, withdrawn, held };
  }

  start() {
    const run = () => { try { if (this.o.config().enabled) this.scan(); } catch (e) { this.o.log?.(`wife: scan failed: ${(e as Error).message}`); } };
    run();
    this.timer = setInterval(run, Math.max(1, this.o.config().detectEveryMinutes) * 60_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Dismissing a promote card deletes the trial rule. */
  onDismiss(card: Suggestion) {
    if (card.kind !== "promote_rule" || !this.o.setConfig) return;
    const tid = String(card.payload.tipId);
    this.o.setConfig(w => { w.tips = ((w.tips as { id: string }[] | undefined) ?? []).filter(t => t.id !== tid); });
  }
  /** Apply the delivery policy to a card the model filed: "skip" when muted or out of scope, "show" when it may appear now, else "hold". */
  admit(card: NewSuggestion): "skip" | "show" | "hold" {
    const cfg = this.o.config(), now = (this.o.now ?? Date.now)();
    if ((cfg.mutedRules ?? []).includes(card.ruleId ?? card.kind) || (cfg.mutedKinds ?? []).includes(card.kind)) return "skip";
    const projectOf = new Map(this.o.analytics().sessions().map(x => [x.id, x.projectId]));
    const scope = cfg.projects ?? { mode: "all" as const, ids: [] };
    const targets = [...card.evidence.map(e => e.sessionId), ...(card.payload.sessionId !== undefined ? [Number(card.payload.sessionId)] : []), ...(Array.isArray(card.payload.sessionIds) ? (card.payload.sessionIds as number[]) : [])];
    if (!targets.every(i => inScope(scope, projectOf.get(i) ?? 0))) return "skip";
    return !inQuietHours(cfg.quietHours ?? null, now) && this.o.store.shownSince(startOfLocalDay(now)) < (cfg.maxNewPerDay ?? 10) ? "show" : "hold";
  }
  /** The text a Discuss session starts with: the card, its evidence, and the action Wife proposes. */
  seedMessage(card: Suggestion): string {
    const lines = [`Wife suggests: ${card.title}`, "", card.body];
    if (card.evidence.length) lines.push("", "Evidence:", ...card.evidence.map(e => `- session ${e.sessionId}: ${e.note}`));
    lines.push("", `Proposed action: ${this.actionText(card)}`, "", "Let's talk it through. Do not change anything until I say so.");
    return lines.join("\n");
  }
  private actionText(card: Suggestion): string {
    const p = card.payload as Record<string, unknown>;
    switch (card.kind) {
      case "skill": return `${p.existing ? "update" : "create"} managed skill "${p.name}" from this outline: ${p.outline}`;
      case "memory": return `remember ${p.key ? `"${p.key}" = ` : ""}${JSON.stringify(p.content)}`;
      case "archive_session": return "archive the session";
      case "delete_session": return "delete the archived session";
      case "move_session": return `move the session to project ${p.projectId}`;
      case "new_project": return `create project "${p.name}" in ${p.cwd} and move its sessions there`;
      default: return card.title;
    }
  }
  /** Open a session about a card. The card keeps its status. A card with a session returns that session. */
  async discuss(id: number): Promise<number> {
    const card = this.o.store.get(id);
    if (!card) throw new WifeError(404, "no such suggestion");
    if (card.sessionId) return card.sessionId;
    if (!this.o.startSession) throw new WifeError(409, "sessions are not available");
    const first = card.evidence[0]?.sessionId;
    const project = first === undefined ? null : this.o.conversations.projects.projectOf(first) ?? null;
    const sid = await this.o.startSession(project, `Wife: ${card.title}`.slice(0, 100), this.seedMessage(card), `wife-discuss-${id}`);
    this.o.store.setStatus(id, card.status, { sessionId: sid, snoozeUntil: card.snoozeUntil });
    return sid;
  }
  /** True when a session other than the ones `skip` names was active after `since`. The daily model pass uses it to stay home when nothing changed. */
  activitySince(since: number, skip: (id: number) => boolean = () => false): boolean {
    const rows = this.o.analytics().db.query<{ id: number }, [number]>("SELECT id FROM analytics_sessions WHERE deleted_at IS NULL AND last_activity>?").all(since);
    return rows.some(r => !skip(r.id));
  }

  /** A skill work session that has ended settles its card: done when the skill exists, failed when it does not. */
  private settleWorking(sessions: { id: number; status: string }[]) {
    for (const card of this.o.store.list("working")) {
      const rec = card.sessionId ? sessions.find(s => s.id === card.sessionId) : undefined;
      if (!rec || ["running", "reviewing", "needs_approval", "needs_input"].includes(rec.status)) continue;
      if (card.kind !== "skill") { this.o.store.setStatus(id_(card), "done", { result: "The work session ended. Check what it wrote." }); continue; }
      const name = String(card.payload.name ?? "");
      if (this.o.skillExists?.(name)) { this.o.store.setStatus(id_(card), "done", { result: `Skill ${name} is written.` }); }
      else { this.o.store.setStatus(id_(card), "failed", { result: "The session ended and the skill was not written. Open it to see why." }); this.o.store.record(card, "failed", null, "no skill"); }
    }
  }

  /** Carry out an open card. The target is checked again first. A failure is recorded on the card and thrown. */
  async agree(id: number, opts: { confirm?: boolean; targets?: number[] } = {}): Promise<Suggestion> {
    const now = (this.o.now ?? Date.now)();
    const card = this.o.store.get(id);
    if (!card) throw new WifeError(404, "no such suggestion");
    if (card.status !== "open" && card.status !== "snoozed") throw new WifeError(409, `suggestion is ${card.status}`);
    try {
      let result: string;
      const sid = Number(card.payload.sessionId);  // not used by every kind
      let inverse: Inverse | undefined; let note: string | undefined;
      const conv = this.o.conversations;
      const ids = (): number[] => {
        const all = Array.isArray(card.payload.sessionIds) ? (card.payload.sessionIds as number[]) : [sid];
        const picked = opts.targets ? all.filter(i => opts.targets!.includes(i)) : all;
        if (!picked.length) throw new WifeError(400, "no targets chosen");
        return picked;
      };
      if (card.kind === "archive_session") {
        const done: number[] = []; let skipped = 0;
        for (const i of ids()) {
          try { const m = conv.get(i); if (m.pinned || m.archived) { skipped++; continue; } await conv.update(i, { archived: true }); done.push(i); }
          catch (e) { if (e instanceof ConversationError) skipped++; else throw e; }
        }
        if (!done.length) throw new WifeError(409, "nothing to archive: the sessions are pinned, archived, or gone");
        inverse = { type: "unarchive", ids: done };
        result = `Archived ${done.length}${skipped ? `, skipped ${skipped}` : ""}.`;
      } else if (card.kind === "delete_session") {
        if (opts.confirm !== true) throw new WifeError(400, "deleting needs confirm:true");
        if (!this.o.conversations.get(sid).archived) throw new WifeError(409, "session is no longer archived");
        if (this.o.conversations.get(sid).pinned) throw new WifeError(409, "session is pinned now");
        await this.o.conversations.delete(sid);
        result = "Deleted.";
      } else if (card.kind === "move_session") {
        const projectId = Number(card.payload.projectId);
        if (!conv.projects.get(projectId)) throw new WifeError(409, "the project no longer exists");
        const links = conv.projects.links(); const moves: { id: number; projectId: number }[] = [];
        for (const i of ids()) { try { const was = links.get(i) ?? 0; await conv.move(i, projectId); moves.push({ id: i, projectId: was }); } catch (e) { if (!(e instanceof ConversationError)) throw e; } }
        if (!moves.length) throw new WifeError(409, "no session could be moved");
        inverse = { type: "move_back", moves };
        result = `Moved ${moves.length}.`;
      } else if (card.kind === "new_project") {
        const p = card.payload as { name: string; cwd: string; worker: string; sessionIds: number[] };
        const projects = this.o.conversations.projects;
        let project, name = p.name;
        for (let n = 2; !project; n++) {
          try { project = p.worker === "main" || p.worker === "" ? projects.create(name, p.cwd) : projects.create(name, "", { worker: Number(p.worker), workerCwd: p.cwd }); }
          catch (e) { if (n > 20 || !/exist|taken|already/i.test((e as Error).message)) throw e; name = `${p.name}-${n}`; }
        }
        const links = conv.projects.links(); const moves: { id: number; projectId: number }[] = [];
        for (const id of p.sessionIds) { try { const was = links.get(id) ?? 0; await conv.move(id, project.id); moves.push({ id, projectId: was }); } catch { /* session gone */ } }
        inverse = { type: "remove_project", projectId: project.id, moves };
        result = `Created project ${project.name} and moved ${moves.length} sessions.`;
      } else if (card.kind === "cron_failing") {
        if (!this.o.cron) throw new WifeError(409, "cron is not available");
        this.o.cron.disable(Number(card.payload.jobId));
        result = "Disabled the job. Turn it back on in Cron.";
      } else if (card.kind === "board_stuck") {
        const p = card.payload as { project: number; card: number };
        conv.board.update(p.project, p.card, { status: "todo" }, "wife");
        result = "Moved the card to todo.";
      } else if (card.kind === "worktree_orphan") {
        const p = card.payload as { path: string; branch: string };
        const live = this.o.worktrees?.().find(w => w.path === p.path);
        if (!live) { result = "The worktree is already gone."; }
        else if (opts.confirm !== true) throw new WifeError(400, "removing a worktree needs confirm:true");
        else if (live.dirty) throw new WifeError(409, "The worktree has uncommitted changes. Clean it up by hand.");
        else { await this.o.removeWorktree!(p.path, p.branch); result = `Removed ${p.branch}.`; }
      } else if (card.kind === "new_rule") {
        if (!this.o.setConfig) throw new WifeError(409, "settings are not available");
        const parsed = TipSchema.safeParse({ ...(card.payload.tip as object), status: "shadow", shadowSince: now });
        if (!parsed.success) throw new WifeError(400, `the rule is not valid: ${parsed.error.issues[0]?.message}`);
        const tip = parsed.data;
        if ((this.o.config().tips ?? []).some(t => t.id === tip.id)) throw new WifeError(409, `a rule named ${tip.id} already exists`);
        this.o.setConfig(w => { w.tips = [...((w.tips as unknown[] | undefined) ?? []), tip]; });
        result = `Rule ${tip.id} is on trial for 7 days. It only logs what it would flag.`;
      } else if (card.kind === "promote_rule") {
        if (!this.o.setConfig) throw new WifeError(409, "settings are not available");
        const tid = String(card.payload.tipId);
        this.o.setConfig(w => { w.tips = ((w.tips as { id: string }[] | undefined) ?? []).map(t => t.id === tid ? { ...t, status: "on" } : t); });
        result = `Rule ${tid} is on.`;
      } else if (card.kind === "cost_habit" || card.kind === "compaction_heavy" || card.kind === "weekly_recap") {
        if (!this.o.startSession) throw new WifeError(409, "sessions are not available");
        const text = card.kind === "weekly_recap" ? `Help me plan my week. Here is the recap from my boards.\n\n${card.payload.recap}\n\nPick what to finish first and what to drop.`
          : card.kind === "cost_habit" ? `${card.body}\n\nLook at this project's recent sessions. Tell me whether a cheaper model or a lower thinking level would do, and show the project setting to change. Change nothing yourself.`
          : `Session ${card.payload.sessionId} has compacted many times. Read it and propose how to split the remaining work into smaller sessions. Change nothing yourself.`;
        const first = card.evidence[0]?.sessionId;
        const project = card.kind === "cost_habit" ? Number(card.payload.project) : first === undefined ? null : conv.projects.projectOf(first) ?? null;
        const sidW = await this.o.startSession(project, `Wife: ${card.title}`.slice(0, 100), text, `wife-${id}`);
        this.o.store.setStatus(id, "working", { sessionId: sidW, result: "Working on it in a session." });
        this.o.store.record(card, "agree", null, "work session");
        return this.o.store.get(id)!;
      } else if (card.kind === "reminder_unscheduled") {
        const p = card.payload as { sessionId: number; content: string; dueAt: number };
        if (!this.o.scheduleMessage) throw new WifeError(409, "scheduled messages are not available");
        if (!(p.dueAt > now)) throw new WifeError(409, "that time has passed");
        await this.o.scheduleMessage(p.sessionId, p.content, p.dueAt, `wife-reminder-${id}`);
        result = `Scheduled for ${new Date(p.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
      } else if (card.kind === "rule_idea") {
        if (!this.o.startSession) throw new WifeError(409, "sessions are not available");
        const first = card.evidence[0]?.sessionId;
        const sidR = await this.o.startSession(first === undefined ? null : conv.projects.projectOf(first) ?? null, `Wife rule idea: ${card.title}`.slice(0, 100),
          `Wife has a rule idea that needs data she does not collect yet.\n\n${card.body}\n\nIdea: ${String(card.payload.idea ?? "")}\n\nIn the luna-pi repo, start your own worktree (session_worktree) and implement it as a detector under src/wife with a test. Commit on that branch. Do not merge, and do not restart the daemon. Tell me when it is ready to review.`, `wife-${id}`);
        this.o.store.setStatus(id, "working", { sessionId: sidR, result: "Implementing the idea on a branch in a work session. Nothing merges without you." });
        this.o.store.record(card, "agree", null, "work session");
        return this.o.store.get(id)!;
      } else if (card.kind === "browser_leftover") {
        await this.o.closeBrowserTab?.(Number(card.payload.session), String(card.payload.tabId)); result = "Closed the tab.";
      } else if (card.kind === "bg_leftover") {
        this.o.closeTerminal?.(String(card.payload.terminalId)); result = "Stopped the terminal.";
      } else if (card.kind === "skill_unused") {
        if (!this.o.trashSkill) throw new WifeError(409, "skills are not available");
        this.o.trashSkill(String(card.payload.name)); result = `Moved ${card.payload.name} to the skill trash. Restore it with skill action=restore.`;
      } else if (card.kind === "prompt_repeat" || card.kind === "project_setup_repeat") {
        if (!this.o.startSession) throw new WifeError(409, "sessions are not available");
        const p = card.payload as { prompt?: string; project?: number; text?: string };
        const content = card.kind === "prompt_repeat"
          ? `Draft a cron job for this prompt that I keep sending. Use the cron tool, pick a schedule that matches how often I send it, and show me the job before enabling it.\n\nPrompt: ${p.prompt}`
          : `Add this session setup to the project's AGENTS.md (create it in the project directory if missing), so new sessions no longer need it. Keep it short and show me the change.\n\nSetup text: ${p.text}`;
        const sid2 = await this.o.startSession(card.kind === "prompt_repeat" ? null : p.project ?? null, card.title.slice(0, 100), content, `wife-work-${id}`);
        this.o.store.setStatus(id, "working", { sessionId: sid2, result: "Working on it in a session." });
        this.o.store.record(card, "agree", null, "work session");
        return this.o.store.get(id)!;
      } else if (card.kind === "goal_unfinished" || card.kind === "tool_error_repeat" || card.kind === "quota_waits") {
        if (!this.o.startSession) throw new WifeError(409, "sessions are not available");
        const first3 = card.evidence[0]?.sessionId;
        const sid3 = await this.o.startSession(first3 === undefined ? null : conv.projects.projectOf(first3) ?? null, `Wife: ${card.title}`.slice(0, 100),
          `${this.seedMessage(card).replace(/\n\nLet's talk it through\..*$/s, "")}\n\nI agreed to this. Do the work: read the evidence, fix the cause or finish the task, and report what you changed. Do not merge or delete anything.`, `wife-${id}`);
        this.o.store.setStatus(id, "working", { sessionId: sid3, result: "Working on it in a session." });
        this.o.store.record(card, "agree", null, "work session");
        return this.o.store.get(id)!;
      } else if (card.kind === "tune_rule") {
        const p = card.payload as { rule: string; key: string; from: number; to: number };
        const tune = TUNABLE[p.rule];
        if (!tune || tune.key !== p.key || !this.o.setConfig) throw new WifeError(409, "this rule cannot be tuned");
        if (this.o.config()[tune.key] !== p.from) throw new WifeError(409, "the threshold changed since this card was filed");
        this.o.setConfig(w => { w[p.key] = p.to; });
        result = `Set ${tune.label.toLowerCase()} to ${p.to}.`;
        note = `tuned:${p.rule}`;
        inverse = undefined;
      } else if (card.kind === "mute_rule" || card.kind === "mute_kind") {
        if (!this.o.setConfig) throw new WifeError(409, "settings are not available");
        const key = card.kind === "mute_rule" ? "mutedRules" : "mutedKinds";
        const value = String(card.kind === "mute_rule" ? card.payload.rule : card.payload.kind);
        this.o.setConfig(w => { const list = (w[key] as string[] | undefined) ?? []; if (!list.includes(value)) w[key] = [...list, value]; });
        result = `Muted ${value}. Remove it from the muted list in settings to bring it back.`;
      } else if (card.kind === "skill") {
        if (!this.o.startSession) throw new WifeError(409, "sessions are not available");
        const p = card.payload as { name: string; existing?: boolean; outline: string };
        const first = card.evidence[0]?.sessionId;
        const project = first === undefined ? null : conv.projects.projectOf(first) ?? null;
        const evidence = card.evidence.map(e => `session ${e.sessionId} (${e.note})`).join("; ");
        const sidNew = await this.o.startSession(project, `Wife skill: ${p.name}`.slice(0, 100),
          `${p.existing ? "Update" : "Create"} the managed skill "${p.name}" from this outline, using the evidence sessions: ${evidence}.\n\nOutline: ${p.outline}\n\nUse \`skill action=${p.existing ? "edit" : "create"}\`. Read the evidence sessions first. Report what you wrote.`, `wife-skill-${id}`);
        this.o.store.setStatus(id, "working", { sessionId: sidNew, result: "Writing the skill in a work session." });
        this.o.store.record(card, "agree", null, "work session");
        return this.o.store.get(id)!;
      } else if (card.kind === "memory") {
        if (!this.o.remember) throw new WifeError(409, "memory is not available");
        const m = card.payload as { key?: string; content: string };
        const r = this.o.remember({ key: m.key, content: m.content });
        if (r.key) inverse = { type: "restore_memory", key: r.key, content: r.before };
        result = r.key ? `Saved ${r.key}.` : "Saved a note.";
      } else if (card.kind === "feature_tip") {
        const ext = card.payload.enable as string | null;
        if (ext && this.o.extensions && !this.o.extensions.enabled(ext)) { this.o.extensions.enable(ext); result = `Enabled ${ext}. It loads on the next session.`; }
        else result = "Noted.";
      } else throw new WifeError(400, `${card.kind} cards cannot be agreed yet`);
      this.o.store.setStatus(id, "done", { result });
      if (inverse) this.o.store.setUndo(id, inverse);
      this.o.store.record(card, "agree", null, note);
    } catch (e) {
      if (e instanceof WifeError) throw e;  // a refused precondition leaves the card open
      this.o.store.setStatus(id, "failed", { result: (e as Error).message });
      this.o.store.record(card, "failed", null, (e as Error).message);
      throw e;
    }
    return this.o.store.get(id)!;
  }

  /** Reverse a done card inside its undo window. The card opens again, so it can be decided differently. */
  async undo(id: number): Promise<Suggestion> {
    const card = this.o.store.get(id);
    if (!card) throw new WifeError(404, "no such suggestion");
    const inv = this.o.store.getUndo(id);
    if (card.status !== "done" || !inv) throw new WifeError(409, "this cannot be undone");
    const conv = this.o.conversations;
    if (inv.type === "unarchive") { for (const i of inv.ids) { try { await conv.update(i, { archived: false }); } catch (e) { if (!(e instanceof ConversationError)) throw e; } } }
    else if (inv.type === "move_back") { for (const m of inv.moves) { try { await conv.move(m.id, m.projectId); } catch (e) { if (!(e instanceof ConversationError)) throw e; } } }
    else if (inv.type === "remove_project") {
      const links = conv.projects.links();
      for (const m of inv.moves) if (links.get(m.id) === inv.projectId) { try { await conv.move(m.id, m.projectId); } catch (e) { if (!(e instanceof ConversationError)) throw e; } }
      const left = [...conv.projects.links()].filter(([, pid]) => pid === inv.projectId).length;
      if (left) throw new WifeError(409, `the project now holds ${left} other sessions, so it was kept`);
      conv.projects.delete(inv.projectId);
    } else if (inv.type === "restore_memory") await this.o.restoreMemory?.(inv.key, inv.content);
    this.o.store.clearUndo(id);
    this.o.store.setStatus(id, "open", { result: null });
    this.o.store.record(card, "undo");
    return this.o.store.get(id)!;
  }

  /** Agree rate and per-rule stats for the page header. */
  stats(): { agree30: ReturnType<typeof agreeRate>; rules: ReturnType<typeof ruleStats> } {
    const now = (this.o.now ?? Date.now)();
    const all = this.o.store.outcomes(now - 60 * LDAY);
    return { agree30: agreeRate(all, now), rules: ruleStats(all, now) };
  }
}
