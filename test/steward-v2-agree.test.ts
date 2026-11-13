// Contract: the v2 Agree actions change exactly what they say, and a rule trial only turns on through its promote card.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";
import { browserLeftovers } from "../src/wife/detectors3.js";

const DAY = 86_400_000;
function setup(now = 1000 * DAY) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE analytics_facts(session_id INTEGER, kind TEXT, ts INTEGER, name TEXT, model TEXT, error INTEGER DEFAULT 0, cost_total REAL); CREATE TABLE analytics_sessions(id INTEGER, deleted_at INTEGER, project_id INTEGER, cwd TEXT, last_activity INTEGER)");
  const cfg: Record<string, unknown> = { enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, tips: [] };
  const sent: string[] = [], scheduled: unknown[][] = [], closedTabs: string[] = [];
  const store = new WifeStore(":memory:", () => now);
  const wife = new WifeService({ store, conversations: { projects: { projectOf: () => 3, list: () => [], links: () => new Map() }, board: { list: () => [] } } as never,
    analytics: () => ({ sessions: () => [{ id: 1, projectId: 3, status: "ready", archived: false, deletedAt: null, lastActivity: now - 5 * DAY, createdAt: 0 }], db }) as never,
    config: () => cfg as never, now: () => now,
    setConfig: fn => fn(cfg), startSession: async (_p, _t, content) => { sent.push(content); return 900 + sent.length; },
    scheduleMessage: async (...a) => { scheduled.push(a); },
    browserTabs: () => [{ tabId: "t1", session: 1, url: "https://example.com/x" }], closeBrowserTab: async (_s, t) => { closedTabs.push(t); } });
  return { store, wife, cfg, sent, scheduled, closedTabs, db, advance: (n: number) => { now += n; } };
}
const file = (a: ReturnType<typeof setup>, kind: string, payload: Record<string, unknown>, extra = {}) =>
  a.store.file({ kind: kind as never, fingerprint: `${kind}:x`, title: "T", body: "B", evidence: [{ sessionId: 1, note: "n" }], payload, source: "model", ...extra })!;

test("a new_rule card adds a shadow rule; the rule only turns on through its promote card; dismissing the promote card deletes it", async () => {
  const a = setup();
  const tip = { id: "r1", title: "Rule", body: "b", when: { tool: "bash", minCalls: 1, minSessions: 1, withinDays: 30 } };
  await a.wife.agree(file(a, "new_rule", { tip }).id);
  let rules = a.cfg.tips as { id: string; status: string }[];
  expect(rules.map(r => [r.id, r.status])).toEqual([["r1", "shadow"]]);
  // the rule would fire: log it, but never file a feature_tip
  a.db.run("INSERT INTO analytics_facts(session_id, kind, ts, name) VALUES (1,'tool',?,'bash')", [1000 * DAY - 1000]);
  a.db.run("INSERT INTO analytics_sessions(id, project_id) VALUES (1, 3)");
  a.wife.scan();
  expect(a.store.list().filter(c => c.kind === "feature_tip").length).toBe(0);
  expect(a.store.shadowHits("r1").length).toBe(1);
  expect(a.store.list().filter(c => c.kind === "promote_rule").length).toBe(0);   // too early
  a.advance(8 * DAY);
  a.wife.scan();
  const promote = a.store.list().find(c => c.kind === "promote_rule")!;
  expect(promote.body).toMatch(/would have flagged 2 times/);
  await a.wife.agree(promote.id);
  rules = a.cfg.tips as never;
  expect(rules[0]!.status).toBe("on");
  // a second trial, dismissed: the rule is deleted
  const b = setup();
  await b.wife.agree(file(b, "new_rule", { tip }).id);
  b.advance(8 * DAY); b.wife.scan();
  const p2 = b.store.list().find(c => c.kind === "promote_rule")!;
  b.store.dismiss(p2.id); b.wife.onDismiss(b.store.get(p2.id)!);
  expect(b.cfg.tips).toEqual([]);
});

test("a new_rule card with a duplicate id or an invalid rule is refused", async () => {
  const a = setup();
  a.cfg.tips = [{ id: "r1", title: "x", body: "x", when: { tool: "bash" } }];
  await expect(a.wife.agree(file(a, "new_rule", { tip: { id: "r1", title: "t", body: "b", when: { tool: "bash" } } }).id)).rejects.toThrow(/already exists/);
  await expect(a.wife.agree(file(a, "new_rule", { tip: { id: "BAD ID" } }, { fingerprint: "new_rule:y" }).id)).rejects.toThrow(/not valid/);
});

test("rule conditions: project, cwd and idle days narrow what counts", () => {
  const a = setup();
  a.db.run("INSERT INTO analytics_sessions(id, project_id, cwd) VALUES (1, 3, '/home/m/app'), (2, 4, '/other')");
  for (const [sid, ts] of [[1, 1000 * DAY - 10 * DAY], [2, 1000 * DAY - DAY]] as [number, number][]) a.db.run("INSERT INTO analytics_facts(session_id, kind, ts, name) VALUES (?,'tool',?,'bash')", [sid, ts]);
  const rule = (when: object) => ({ id: "c", title: "C", body: "b", status: "on", when: { tool: "bash", minCalls: 1, minSessions: 1, withinDays: 30, kind: "tool", ...when } });
  const run = (when: object) => { a.cfg.tips = [rule(when)]; a.wife.scan(); const open = a.store.list().filter(c => c.kind === "feature_tip" && c.status === "open"); for (const c of open) a.db.run("SELECT 1") && a.store.db.run("DELETE FROM suggestions WHERE id=?", [c.id]); return open.length; };
  expect(run({})).toBe(1);
  expect(run({ project: 9 })).toBe(0);
  expect(run({ cwd: "/home/m" })).toBe(1);
  expect(run({ project: 3, idleDays: 5 })).toBe(1);    // project 3's last call was 10 days ago
  expect(run({ project: 4, idleDays: 5 })).toBe(0);    // project 4 called yesterday
});

test("a reminder card schedules into its session; a past time is refused", async () => {
  const a = setup();
  const due = 1000 * DAY + DAY;
  await a.wife.agree(file(a, "reminder_unscheduled", { sessionId: 1, content: "ping", dueAt: due }).id);
  expect(a.scheduled[0]!.slice(0, 3)).toEqual([1, "ping", due]);
  await expect(a.wife.agree(file(a, "reminder_unscheduled", { sessionId: 1, content: "old", dueAt: 5 }, { fingerprint: "r2" }).id)).rejects.toThrow(/passed/);
  expect(a.scheduled.length).toBe(1);
});

test("cost, compaction, recap and rule-idea cards each open one work session and wait as working", async () => {
  const a = setup();
  for (const [k, payload] of [["cost_habit", { project: 3 }], ["compaction_heavy", { sessionId: 1 }], ["weekly_recap", { recap: "Done: x" }], ["rule_idea", { idea: "flag idle cron" }]] as const) {
    const r = await a.wife.agree(file(a, k, payload, { fingerprint: `${k}:1` }).id);
    expect(r.status).toBe("working") /* k */;
  }
  expect(a.sent.length).toBe(4);
  expect(a.sent[3]!).toMatch(/session_worktree/); expect(a.sent[3]!).toMatch(/Do not merge/);
  expect(a.sent[0]!).toMatch(/Change nothing yourself/);
});

test("a leftover browser tab in an idle session files a card; agree closes it", async () => {
  expect(browserLeftovers([{ tabId: "a", session: 1, url: "https://x.io" }, { tabId: "b", session: 2, url: "https://y.io" }], s => s === 1).length).toBe(1);
  const a = setup();
  a.advance(3 * DAY);   // session 1 is now 8 days idle
  a.wife.scan();
  const card = a.store.list().find(c => c.kind === "browser_leftover")!;
  await a.wife.agree(card.id);
  expect(a.closedTabs).toEqual(["t1"]);
});

test("the model pass stays home when no session was active since the last run", () => {
  const a = setup();
  a.db.run("INSERT INTO analytics_sessions(id, last_activity) VALUES (1, 500), (2, 900)");
  expect(a.wife.activitySince(1000)).toBe(false);
  expect(a.wife.activitySince(800)).toBe(true);
  expect(a.wife.activitySince(800, id => id === 2)).toBe(false);   // a cron session does not count
});
