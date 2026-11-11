// Cost, context, and weekly-recap detectors. Pure functions over plain inputs.
import type { AnalyticsSessionRecord } from "../analytics/types.js";
import type { NewSuggestion } from "./store.js";

const DAY = 86_400_000;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export interface CostRow { session: number; model: string; cost: number; turns: number }
/** A project whose cost per response in the window (rows must already be limited to it) is more than `factor` times the median of all projects. */
export function costHabit(rows: CostRow[], sessions: AnalyticsSessionRecord[], week: string, factor = 2, minTurns = 20): NewSuggestion[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  const by = new Map<number, { name: string; cost: number; turns: number; models: Map<string, number>; sessions: Set<number> }>();
  for (const r of rows) {
    const s = byId.get(r.session);
    if (!s || s.deletedAt !== null || s.projectId === 0) continue;
    const g = by.get(s.projectId) ?? { name: s.projectName, cost: 0, turns: 0, models: new Map<string, number>(), sessions: new Set<number>() };
    g.cost += r.cost; g.turns += r.turns; g.sessions.add(r.session); g.models.set(r.model, (g.models.get(r.model) ?? 0) + r.cost);
    by.set(s.projectId, g);
  }
  const eligible = [...by.entries()].filter(([, g]) => g.turns >= minTurns && g.cost > 0);
  if (eligible.length < 3) return [];
  const med = median(eligible.map(([, g]) => g.cost / g.turns));
  if (med <= 0) return [];
  return eligible.filter(([, g]) => g.cost / g.turns > factor * med).map(([id, g]) => {
    const top = [...g.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
    const per = g.cost / g.turns;
    return { kind: "cost_habit" as const, fingerprint: `cost_habit:${id}:${week}`, source: "detector" as const, title: `Project "${g.name}" costs ${(per / med).toFixed(1)}x the median per response`,
      body: `$${per.toFixed(3)} per response over ${g.turns} responses in 30 days, against a median of $${med.toFixed(3)}. Most of it went to ${top}. Agree opens a session to look at a cheaper model or thinking level.`,
      evidence: [...g.sessions].slice(0, 3).map(sid => ({ sessionId: sid, note: "in this project" })), payload: { project: id, model: top, perTurn: per, median: med } };
  });
}

/** A session that compacted `min` or more times and is still in use. */
export function compactionHeavy(rows: { session: number; n: number }[], sessions: AnalyticsSessionRecord[], now: number, min = 3): NewSuggestion[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  return rows.filter(r => r.n >= min).flatMap(r => {
    const s = byId.get(r.session);
    if (!s || s.deletedAt !== null || s.archived || (s.lastActivity ?? 0) < now - 14 * DAY) return [];
    return [{ kind: "compaction_heavy" as const, fingerprint: `compaction_heavy:${s.id}:${Math.floor(r.n / min)}`, source: "detector" as const, title: `"${s.title?.trim() || `Session ${s.id}`}" compacted ${r.n} times`,
      body: "A session this long loses detail each time it compacts. Agree opens a session to split the work into smaller ones.", evidence: [{ sessionId: s.id, note: `${r.n} compactions` }], payload: { sessionId: s.id } }];
  });
}

export interface RecapCard { project: number; id: number; subject: string; status: string; updated: number }
/** One card per week: what finished, what is open, what is stuck on the boards. Nothing when no board has cards. */
export function weeklyRecap(cards: RecapCard[], now: number, week: string): NewSuggestion[] {
  if (!cards.length) return [];
  const done = cards.filter(c => c.status === "done" && now - c.updated < 7 * DAY);
  const open = cards.filter(c => c.status === "in_progress" || c.status === "review" || c.status === "todo");
  const stuck = cards.filter(c => (c.status === "in_progress" || c.status === "review") && now - c.updated >= 5 * DAY);
  if (!done.length && !open.length) return [];
  const list = (cs: RecapCard[]) => cs.slice(0, 8).map(c => `- board ${c.project} #${c.id} ${c.subject}`).join("\n") || "- none";
  const body = `Done this week: ${done.length}. Open: ${open.length}. Stuck: ${stuck.length}.`;
  return [{ kind: "weekly_recap", fingerprint: `weekly_recap:${week}`, source: "detector", title: "Your week on the boards", body,
    evidence: [], payload: { recap: `Done this week:\n${list(done)}\n\nStill open:\n${list(open)}\n\nStuck for 5+ days:\n${list(stuck)}` } }];
}
