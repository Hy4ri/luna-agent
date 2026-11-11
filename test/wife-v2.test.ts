// Contract: v2 cards (cost, compaction, recap, rule trials, reminders) fire on their thresholds and act only on Agree.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { compactionHeavy, costHabit, weeklyRecap } from "../src/wife/detectors4.js";
import { matchTips, TipSchema } from "../src/wife/tips.js";
import { buildCard } from "../src/wife/tool.js";
import { WifeStore } from "../src/wife/store.js";

const DAY = 86_400_000, NOW = 100 * DAY;
const sess = (id: number, project: number, cost: number, turns: number, extra = {}) => ({ id, projectId: project, projectName: `p${project}`, deletedAt: null, archived: false, lastActivity: NOW - DAY, title: null,
  assistantTurns: turns, usage: { cost: { total: cost } }, modelUsage: { "m/x": { cost: { total: cost } } }, ...extra }) as never;

test("cost_habit flags only a project above 2x the median", () => {
  const s = [sess(1, 1, 1, 100), sess(2, 2, 1, 100), sess(3, 3, 1, 100), sess(4, 4, 5, 100)];
  const c = costHabit(s, NOW, "w");
  assert.deepEqual(c.map(x => x.payload.project), [4]);
  assert.equal(costHabit(s.slice(0, 3), NOW, "w").length, 0);
});

test("compaction_heavy needs 3 compactions in a live session", () => {
  const s = [sess(1, 1, 0, 0), sess(2, 1, 0, 0, { archived: true })];
  assert.deepEqual(compactionHeavy([{ session: 1, n: 3 }, { session: 2, n: 5 }, { session: 9, n: 4 }, { session: 1, n: 2 }].slice(0, 3), s, NOW).map(c => c.payload.sessionId), [1]);
});

test("weekly_recap summarises boards, and stays quiet with none", () => {
  const cards = [{ project: 1, id: 1, subject: "a", status: "done", updated: NOW - DAY }, { project: 1, id: 2, subject: "b", status: "in_progress", updated: NOW - 6 * DAY }];
  const [r] = weeklyRecap(cards, NOW, "w");
  assert.match(r!.body, /Done this week: 1\. Open: 1\. Stuck: 1/);
  assert.equal(weeklyRecap([], NOW, "w").length, 0);
});

test("shadow rules fire only in shadow mode, and fact kinds pick the counts", () => {
  const tip = TipSchema.parse({ id: "t", title: "t", body: "b", status: "shadow", when: { tool: "x", minCalls: 1, minSessions: 1, kind: "skill" } });
  const counts = (_d: number, k: string) => new Map(k === "skill" ? [["x", { calls: 2, sessions: 2 }]] : []);
  assert.equal(matchTips([tip], counts as never).length, 0);
  assert.equal(matchTips([tip], counts as never, () => false, true).length, 1);
});

test("shadow hits log once per day", () => {
  const s = new WifeStore(":memory:");
  s.logShadow("t", "a", NOW); s.logShadow("t", "a", NOW + 1000); s.logShadow("t", "a", NOW + DAY);
  assert.equal(s.shadowHits("t").length, 2);
});

test("model new_rule and reminder cards are validated", () => {
  const ok = () => true;
  const rule = { action: "suggest", kind: "new_rule", title: "r", body: "b", evidence: [{ sessionId: 1, note: "n" }], payload: { tip: { id: "r1", title: "t", body: "b", when: { tool: "bash" } } } } as never;
  assert.equal((buildCard(rule, ok) as { fingerprint: string }).fingerprint, "new_rule:r1");
  assert.match(buildCard({ ...(rule as object), payload: { tip: { id: "BAD ID" } } } as never, ok) as string, /not valid/);
  const rem = { action: "suggest", kind: "reminder_unscheduled", title: "r", body: "b", evidence: [{ sessionId: 1, note: "n" }], payload: { sessionId: 1, content: "ping", dueAt: Date.now() - 5 } } as never;
  assert.match(buildCard(rem, ok) as string, /future/);
});
