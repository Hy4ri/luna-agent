// Contract: v2 cards (cost, compaction, recap, rule trials, reminders) fire on their thresholds and act only on Agree.
import { test, expect } from "bun:test";
import { compactionHeavy, costHabit, weeklyRecap } from "../src/wife/detectors4.js";
import { matchTips, TipSchema } from "../src/wife/tips.js";
import { buildCard } from "../src/wife/tool.js";
import { WifeStore } from "../src/wife/store.js";

const DAY = 86_400_000, NOW = 100 * DAY;
const sess = (id: number, project: number, cost: number, turns: number, extra = {}) => ({ id, projectId: project, projectName: `p${project}`, deletedAt: null, archived: false, lastActivity: NOW - DAY, title: null,
  assistantTurns: turns, usage: { cost: { total: cost } }, modelUsage: { "m/x": { cost: { total: cost } } }, ...extra }) as never;

test("cost_habit uses window rows only and flags only a project above 2x the median", () => {
  const ss = [sess(1, 1, 0, 0), sess(2, 2, 0, 0), sess(3, 3, 0, 0), sess(4, 4, 0, 0)];
  const row = (session: number, cost: number) => ({ session, model: "m/x", cost, turns: 100 });
  expect(costHabit([row(1, 1), row(2, 1), row(3, 1), row(4, 5)], ss, "w").map(x => x.payload.project)).toEqual([4]);
  expect(costHabit([row(1, 1), row(2, 1), row(3, 1)], ss, "w").length).toBe(0);
  expect(costHabit([row(1, 1), row(2, 1), row(3, 1), { ...row(4, 50), turns: 5 }], ss, "w").length).toBe(0);
});

test("compaction_heavy needs 5 compactions in a live session and folds every hit into one weekly card", () => {
  const s = [sess(1, 1, 0, 0), sess(2, 1, 0, 0, { archived: true }), sess(3, 1, 0, 0), sess(4, 1, 0, 0, { lastActivity: NOW - 20 * DAY })];
  expect(compactionHeavy([{ session: 1, n: 4 }], s, NOW, "w").length).toBe(0);
  const cards = compactionHeavy([{ session: 1, n: 5 }, { session: 2, n: 9 }, { session: 9, n: 9 }, { session: 3, n: 8 }, { session: 4, n: 9 }], s, NOW, "w");
  expect(cards.length).toBe(1);
  expect(cards[0]!.fingerprint).toBe("compaction_heavy:w");
  expect(cards[0]!.payload.sessionIds).toEqual([3, 1]);
  expect(cards[0]!.title).toMatch(/2 sessions compacted 5\+ times/);
});

test("weekly_recap summarises boards, and stays quiet with none", () => {
  const cards = [{ project: 1, id: 1, subject: "a", status: "done", updated: NOW - DAY }, { project: 1, id: 2, subject: "b", status: "in_progress", updated: NOW - 6 * DAY }];
  const [r] = weeklyRecap(cards, NOW, "w");
  expect(r!.body).toMatch(/Done this week: 1\. Open: 1\. Stuck: 1/);
  expect(weeklyRecap([], NOW, "w").length).toBe(0);
});

test("shadow rules fire only in shadow mode, and fact kinds pick the counts", () => {
  const tip = TipSchema.parse({ id: "t", title: "t", body: "b", status: "shadow", when: { tool: "x", minCalls: 1, minSessions: 1, kind: "skill" } });
  const counts = (_d: number, k: string) => new Map(k === "skill" ? [["x", { calls: 2, sessions: 2 }]] : []);
  expect(matchTips([tip], counts as never).length).toBe(0);
  expect(matchTips([tip], counts as never, () => false, true).length).toBe(1);
});

test("shadow hits log once per day", () => {
  const s = new WifeStore(":memory:");
  s.logShadow("t", "a", NOW); s.logShadow("t", "a", NOW + 1000); s.logShadow("t", "a", NOW + DAY);
  expect(s.shadowHits("t").length).toBe(2);
});

test("model new_rule and reminder cards are validated", () => {
  const ok = () => true;
  const rule = { action: "suggest", kind: "new_rule", title: "r", body: "b", evidence: [{ sessionId: 1, note: "n" }], payload: { tip: { id: "r1", title: "t", body: "b", when: { tool: "bash" } } } } as never;
  expect((buildCard(rule, ok) as { fingerprint: string }).fingerprint).toBe("new_rule:r1");
  expect(buildCard({ ...(rule as object), payload: { tip: { id: "BAD ID" } } } as never, ok) as string).toMatch(/not valid/);
  const rem = { action: "suggest", kind: "reminder_unscheduled", title: "r", body: "b", evidence: [{ sessionId: 1, note: "n" }], payload: { sessionId: 1, content: "ping", dueAt: Date.now() - 5 } } as never;
  expect(buildCard(rem, ok) as string).toMatch(/future/);
});
