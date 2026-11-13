import { test, expect } from "bun:test";
import { boardStuck, cronFailing, goalUnfinished, quotaWaits } from "../src/steward/detectors2.js";

const D = 86_400_000, now = 100 * D;
const run = (status: string, output: string | null = null, t = 1) => ({ status, output, startedAt: t });
const sess = (o: Record<string, unknown>) => ({ id: 1, title: "x", deletedAt: null, archived: false, parentId: null, status: "ready", lastActivity: now - 5 * D, createdAt: 0,
  workflow: { goals: 1, completedGoals: 0, todos: 0, completedTodos: 0 }, ...o }) as never;

test("goal_unfinished needs an idle session with an open goal or todo", () => {
  expect(goalUnfinished([sess({})], now).length).toBe(1);
  expect(goalUnfinished([sess({ lastActivity: now - D })], now).length).toBe(0);
  expect(goalUnfinished([sess({ workflow: { goals: 1, completedGoals: 1, todos: 2, completedTodos: 2 } })], now).length).toBe(0);
  expect(goalUnfinished([sess({ archived: true })], now).length).toBe(0);
});

test("cron_failing: 3 errors or 7 nothing-reports, not fewer, not disabled", () => {
  const job = (runs: ReturnType<typeof run>[], enabled = true) => ({ id: 1, name: "j", enabled, runs });
  expect(cronFailing([job([run("error"), run("error"), run("error")])]).length).toBe(1);
  expect(cronFailing([job([run("error"), run("ok", "done"), run("error")])]).length).toBe(0);
  expect(cronFailing([job(Array(7).fill(run("ok", "Nothing to report")))]).length).toBe(1);
  expect(cronFailing([job(Array(6).fill(run("ok", "Nothing to report")))]).length).toBe(0);
  expect(cronFailing([job([run("error"), run("error"), run("error")], false)]).length).toBe(0);
});

test("quota_waits fires above the limit only", () => {
  expect(quotaWaits([{ model: "m", waits: 6, sessions: 2 }, { model: "n", waits: 5, sessions: 1 }], "w").length).toBe(1);
});

test("board_stuck needs age, an active column, and an idle owner", () => {
  const card = (o: Record<string, unknown>) => ({ project: 1, id: 2, subject: "s", status: "in_progress", updated: now - 6 * D, ownerSession: 9, ...o });
  expect(boardStuck([card({})], () => true, now).length).toBe(1);
  expect(boardStuck([card({})], () => false, now).length).toBe(0);
  expect(boardStuck([card({ status: "todo" })], () => true, now).length).toBe(0);
  expect(boardStuck([card({ updated: now - D })], () => true, now).length).toBe(0);
});
