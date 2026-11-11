// Runs the detectors, files their cards, and carries out an agreed card.
import type { AnalyticsStore } from "../analytics/store.js";
import { ConversationError, type ConversationStore } from "../conversations.js";
import { batchCards, misfiledSessions, newProjects, staleSessions, type DetectorConfig } from "./detectors.js";
import { agreeRate, DAY as LDAY, metaCards, META_RULES, ruleStats, TUNABLE } from "./learning.js";
import { matchTips, type ToolCounts, type WifeTip } from "./tips.js";
import type { Inverse, Suggestion, WifeStore } from "./store.js";

const DETECTOR_RULES = ["archive_session", "delete_session", "move_session", "new_project"]  // tip rules are added per tip id;
export class WifeError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) { super(message); } }

export interface WifeServiceOptions {
  store: WifeStore; analytics: () => AnalyticsStore; conversations: ConversationStore;
  config: () => DetectorConfig & { enabled: boolean; detectEveryMinutes: number; tips?: WifeTip[]; mutedRules?: string[]; mutedKinds?: string[] };
  /** Change a value in the `wife` config block. Used by tune and mute cards. */
  setConfig?: (fn: (w: Record<string, unknown>) => void) => void;
  /** Settings mutation used by a tip that enables an extension. */
  restoreMemory?: (key: string, content: string | null) => Promise<void> | void;
  extensions?: { enabled(name: string): boolean; enable(name: string): void }; now?: () => number; log?: (m: string) => void;
}

export class WifeService {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private o: WifeServiceOptions) {}
  get store() { return this.o.store; }

  /** Run every detector once. File new cards, refresh open ones, and withdraw open cards that no longer apply. */
  scan(): { filed: number; withdrawn: number } {
    const now = (this.o.now ?? Date.now)();
    this.o.store.expireSnoozed(now);
    const sessions = this.o.analytics().sessions();
    const projects = this.o.conversations.projects.list();
    const found = [...batchCards([...staleSessions(sessions, this.o.config(), now), ...misfiledSessions(sessions, projects)]), ...newProjects(sessions, projects, now)];
    const store = this.o.analytics();
    const tips = this.o.config().tips ?? [];
    const toolCounts = (days: number): ToolCounts => {
      const rows = store.db.query<{ name: string; calls: number; sessions: number }, [number]>(
        "SELECT f.name AS name, COUNT(*) AS calls, COUNT(DISTINCT f.session_id) AS sessions FROM analytics_facts f JOIN analytics_sessions s ON s.id=f.session_id WHERE f.kind='tool' AND f.ts>=? AND s.deleted_at IS NULL GROUP BY f.name").all(now - days * 86_400_000);
      return new Map(rows.map(r => [r.name, { calls: r.calls, sessions: r.sessions }]));
    };
    const tipCards = matchTips(tips, toolCounts, n => this.o.extensions?.enabled(n) ?? false);
    found.push(...tipCards);
    const cfg = this.o.config();
    const muted = (c: { ruleId?: string; kind: string }) => (cfg.mutedRules ?? []).includes(c.ruleId ?? c.kind) || (cfg.mutedKinds ?? []).includes(c.kind);
    for (let i = found.length - 1; i >= 0; i--) if (muted(found[i]!)) found.splice(i, 1);
    const tunedAt = new Map<string, number>();
    for (const o of this.o.store.outcomes()) if (o.action === "agree" && o.ruleId === "tune_rule" && o.note?.startsWith("tuned:")) tunedAt.set(o.note.slice(6), o.ts);
    found.push(...metaCards({ outcomes: this.o.store.outcomes(now - 60 * LDAY), now, tunedAt, values: { staleDays: cfg.staleDays, deleteArchivedAfterDays: cfg.deleteArchivedAfterDays },
      mutedRules: cfg.mutedRules ?? [], mutedKinds: cfg.mutedKinds ?? [] }));
    let filed = 0;
    for (const f of found) {
      const isNew = !this.o.store.has(f.fingerprint);
      this.o.store.file(f);
      if (isNew) filed++;
    }
    let withdrawn = 0;
    for (const rule of [...DETECTOR_RULES, ...META_RULES, ...tips.map(t => `tip:${t.id}`)])
      withdrawn += this.o.store.withdrawOpen(rule, new Set(found.filter(f => (f.ruleId ?? f.kind) === rule).map(f => f.fingerprint)));
    return { filed, withdrawn };
  }

  start() {
    const run = () => { try { if (this.o.config().enabled) this.scan(); } catch (e) { this.o.log?.(`wife: scan failed: ${(e as Error).message}`); } };
    run();
    this.timer = setInterval(run, Math.max(1, this.o.config().detectEveryMinutes) * 60_000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Carry out an open card. The target is checked again first. A failure is recorded on the card and thrown. */
  async agree(id: number, opts: { confirm?: boolean; targets?: number[] } = {}): Promise<Suggestion> {
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
