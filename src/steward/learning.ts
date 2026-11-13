// The learning loop: read the outcome log and file cards that tune or mute a rule. Wife never changes a rule herself; agree does.
import type { NewSuggestion, Outcome } from "./store.js";

export const STATS_DAYS = 60;
export const MIN_DECISIONS = 5;
export const DAY = 86_400_000;
/** Rules with a numeric threshold in `wife` config. A tune card proposes a larger value. */
export const TUNABLE: Record<string, { key: "staleDays" | "deleteArchivedAfterDays"; label: string; max: number }> = {
  archive_session: { key: "staleDays", label: "Archive idle sessions after (days)", max: 365 },
  delete_session: { key: "deleteArchivedAfterDays", label: "Suggest deleting archived sessions after (days)", max: 365 },
};
/** Cards that tune or mute rules are never tuned or muted themselves. */
export const META_RULES = ["tune_rule", "mute_rule", "mute_kind"];

export interface RuleStats { ruleId: string; kind: string; decisions: number; agrees: number; wrong: number; tooAggressive: number; dontCare: number; reasons: Record<string, number> }

/**
 * Per-rule counts over the window. A decision is an agree or a dismiss; `not_now` and `already_done` are not decisions on the rule.
 * `tunedAt` starts a rule's window over after its threshold was changed.
 */
export function ruleStats(outcomes: Outcome[], now: number, tunedAt: Map<string, number> = new Map(), days = STATS_DAYS): RuleStats[] {
  const out = new Map<string, RuleStats>();
  for (const o of outcomes) {
    if (o.ts < now - days * DAY || META_RULES.includes(o.ruleId) || o.ts < (tunedAt.get(o.ruleId) ?? 0)) continue;
    if (o.action !== "agree" && o.action !== "dismiss") continue;
    if (o.action === "dismiss" && (o.reason === "not_now" || o.reason === "already_done")) continue;
    const s = out.get(o.ruleId) ?? { ruleId: o.ruleId, kind: o.kind, decisions: 0, agrees: 0, wrong: 0, tooAggressive: 0, dontCare: 0, reasons: {} };
    s.decisions++;
    if (o.action === "agree") s.agrees++;
    else {
      const r = o.reason ?? "none";
      s.reasons[r] = (s.reasons[r] ?? 0) + 1;
      if (o.reason === "wrong") s.wrong++; else if (o.reason === "too_aggressive") s.tooAggressive++; else if (o.reason === "dont_care_kind") s.dontCare++;
    }
    out.set(o.ruleId, s);
  }
  return [...out.values()].sort((a, b) => b.decisions - a.decisions);
}

export interface LearnInput { outcomes: Outcome[]; now: number; tunedAt?: Map<string, number>; values: Record<string, number>; mutedRules: string[]; mutedKinds: string[] }

export function metaCards(i: LearnInput): NewSuggestion[] {
  const stats = ruleStats(i.outcomes, i.now, i.tunedAt);
  const cards: NewSuggestion[] = [];
  for (const s of stats) {
    const tune = TUNABLE[s.ruleId];
    const against = s.wrong + s.tooAggressive;
    if (s.decisions >= MIN_DECISIONS && tune && against / s.decisions >= 0.5) {
      const now = i.values[tune.key]!;
      const next = Math.min(tune.max, Math.max(now + 1, Math.round(now * 2)));
      if (next > now) {
        cards.push({ kind: "tune_rule", ruleId: "tune_rule", fingerprint: `tune_rule:${s.ruleId}:${now}:${next}`, source: "detector",
          title: `${tune.label}: ${now} to ${next}`,
          body: `You dismissed ${against} of the last ${s.decisions} "${s.kind}" cards as wrong or too aggressive. A higher threshold should file fewer of them.`,
          evidence: [], payload: { rule: s.ruleId, key: tune.key, from: now, to: next } });
        continue;
      }
    }
    if (s.decisions >= MIN_DECISIONS && s.agrees === 0 && !i.mutedRules.includes(s.ruleId))
      cards.push({ kind: "mute_rule", ruleId: "mute_rule", fingerprint: `mute_rule:${s.ruleId}`, source: "detector",
        title: `Stop suggesting "${s.ruleId}" cards`, body: `You decided on ${s.decisions} of these in the last ${STATS_DAYS} days and agreed to none.`,
        evidence: [], payload: { rule: s.ruleId } });
  }
  const byKind = new Map<string, number>();
  for (const s of stats) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + s.dontCare);
  for (const [kind, n] of byKind)
    if (n >= 3 && !i.mutedKinds.includes(kind))
      cards.push({ kind: "mute_kind", ruleId: "mute_kind", fingerprint: `mute_kind:${kind}`, source: "detector",
        title: `Stop suggesting "${kind}" cards`, body: `You said "I don't care about this kind" ${n} times in the last ${STATS_DAYS} days.`, evidence: [], payload: { kind } });
  return cards;
}

/** Agree rate over a window, for the page header. Undone actions do not count as agreed. */
export function agreeRate(outcomes: Outcome[], now: number, days = 30): { decisions: number; agrees: number; rate: number | null } {
  let d = 0, a = 0;
  const undone = new Set(outcomes.filter(o => o.action === "undo").map(o => o.suggestionId));
  for (const o of outcomes) {
    if (o.ts < now - days * DAY || META_RULES.includes(o.ruleId)) continue;
    if (o.action === "agree" && !undone.has(o.suggestionId)) { d++; a++; }
    else if (o.action === "dismiss" && o.reason !== "not_now" && o.reason !== "already_done") d++;
  }
  return { decisions: d, agrees: a, rate: d ? a / d : null };
}
