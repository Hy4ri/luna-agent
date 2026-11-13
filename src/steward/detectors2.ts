// More deterministic detectors. Each one is a pure function over plain inputs, so tests need no daemon.
import type { AnalyticsSessionRecord } from "../analytics/types.js";
import type { NewSuggestion } from "./store.js";

const DAY = 86_400_000;
const label = (s: AnalyticsSessionRecord) => s.title?.trim() || `Session ${s.id}`;

/** A session idle for more than `days` that still has an open goal or unfinished todos. */
export function goalUnfinished(sessions: AnalyticsSessionRecord[], now: number, days = 3): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const s of sessions) {
    if (s.deletedAt !== null || s.archived || s.parentId !== null || s.status === "running") continue;
    const last = s.lastActivity ?? s.createdAt; if (last == null || now - last < days * DAY) continue;
    const goals = s.workflow.goals - s.workflow.completedGoals, todos = s.workflow.todos - s.workflow.completedTodos;
    if (goals <= 0 && todos <= 0) continue;
    const what = [goals > 0 ? `${goals} open goal${goals > 1 ? "s" : ""}` : "", todos > 0 ? `${todos} unfinished todo${todos > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    out.push({ kind: "goal_unfinished", fingerprint: `goal_unfinished:${s.id}`, source: "detector", title: `Resume "${label(s)}"`,
      body: `Idle for ${Math.floor((now - last) / DAY)} days with ${what}.`, evidence: [{ sessionId: s.id, note: what }], payload: { sessionId: s.id } });
  }
  return out;
}

export interface CronJobView { id: number; name: string; enabled: boolean; runs: { status: string; output: string | null; startedAt: number }[] }
/** A job whose last 3 runs all failed, or whose last 7 runs all report that there was nothing to do. Runs are newest first. */
export function cronFailing(jobs: CronJobView[]): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const j of jobs) {
    if (!j.enabled) continue;
    const errors = j.runs.slice(0, 3);
    const nothing = j.runs.slice(0, 7);
    const failing = errors.length === 3 && errors.every(r => r.status === "error");
    const idle = nothing.length === 7 && nothing.every(r => r.status === "ok" && /^\s*(nothing|no (changes|updates|new)|nothing to report)/i.test(r.output ?? ""));
    if (!failing && !idle) continue;
    out.push({ kind: "cron_failing", fingerprint: `cron_failing:${j.id}:${failing ? "error" : "idle"}:${j.runs[0]!.startedAt}`, source: "detector",
      title: failing ? `Cron job "${j.name}" keeps failing` : `Cron job "${j.name}" has nothing to report`,
      body: failing ? "The last 3 runs all ended in an error. Disable it until it is fixed." : "The last 7 runs all said there was nothing to do. Disable it if it is not needed.",
      evidence: [], payload: { jobId: j.id } });
  }
  return out;
}

/** More than `max` quota waits for one model in the window. */
export function quotaWaits(rows: { model: string; waits: number; sessions: number }[], week: string, max = 5): NewSuggestion[] {
  return rows.filter(r => r.waits > max).map(r => ({ kind: "quota_waits" as const, fingerprint: `quota_waits:${r.model}:${week}`, source: "detector" as const,
    title: `${r.model} hit its quota ${r.waits} times this week`, body: `${r.sessions} sessions waited for the limit to reset. Set a fallback model or switch the default.`,
    evidence: [], payload: { model: r.model, waits: r.waits } }));
}

export interface StuckCard { project: number; id: number; subject: string; status: string; updated: number; ownerSession: number | null }
/** A card in progress or in review for more than `days`, whose owner session is idle or gone. */
export function boardStuck(cards: StuckCard[], idle: (sessionId: number) => boolean, now: number, days = 5): NewSuggestion[] {
  return cards.filter(c => (c.status === "in_progress" || c.status === "review") && now - c.updated >= days * DAY && (c.ownerSession === null || idle(c.ownerSession)))
    .map(c => ({ kind: "board_stuck" as const, fingerprint: `board_stuck:${c.project}:${c.id}:${c.updated}`, source: "detector" as const,
      title: `Card #${c.id} "${c.subject}" is stuck`, body: `${c.status.replace("_", " ")} for ${Math.floor((now - c.updated) / DAY)} days with no active session. Move it back to todo.`,
      evidence: c.ownerSession ? [{ sessionId: c.ownerSession, note: "owner session is idle" }] : [], payload: { project: c.project, card: c.id } }));
}
