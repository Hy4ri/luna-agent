// Contract: the v2 Agree actions change exactly what they say, and a rule trial only turns on through its promote card.
import assert from "node:assert/strict";
import { test } from "bun:test";
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
  assert.deepEqual(rules.map(r => [r.id, r.status]), [["r1", "shadow"]]);
  // the rule would fire: log it, but never file a feature_tip
  a.db.run("INSERT INTO analytics_facts(session_id, kind, ts, name) VALUES (1,'tool',?,'bash')", [1000 * DAY - 1000]);
  a.db.run("INSERT INTO analytics_sessions(id, project_id) VALUES (1, 3)");
  a.wife.scan();
  assert.equal(a.store.list().filter(c => c.kind === "feature_tip").length, 0);
  assert.equal(a.store.shadowHits("r1").length, 1);
  assert.equal(a.store.list().filter(c => c.kind === "promote_rule").length, 0);   // too early
  a.advance(8 * DAY);
  a.wife.scan();
  const promote = a.store.list().find(c => c.kind === "promote_rule")!;
  assert.match(promote.body, /would have flagged 2 times/);
  await a.wife.agree(promote.id);
  rules = a.cfg.tips as never;
  assert.equal(rules[0]!.status, "on");
  // a second trial, dismissed: the rule is deleted
  const b = setup();
  await b.wife.agree(file(b, "new_rule", { tip }).id);
  b.advance(8 * DAY); b.wife.scan();
  const p2 = b.store.list().find(c => c.kind === "promote_rule")!;
  b.store.dismiss(p2.id); b.wife.onDismiss(b.store.get(p2.id)!);
  assert.deepEqual(b.cfg.tips, []);
});

test("a new_rule card with a duplicate id or an invalid rule is refused", async () => {
  const a = setup();
  a.cfg.tips = [{ id: "r1", title: "x", body: "x", when: { tool: "bash" } }];
  await assert.rejects(a.wife.agree(file(a, "new_rule", { tip: { id: "r1", title: "t", body: "b", when: { tool: "bash" } } }).id), /already exists/);
  await assert.rejects(a.wife.agree(file(a, "new_rule", { tip: { id: "BAD ID" } }, { fingerprint: "new_rule:y" }).id), /not valid/);
});

test("rule conditions: project, cwd and idle days narrow what counts", () => {
  const a = setup();
  a.db.run("INSERT INTO analytics_sessions(id, project_id, cwd) VALUES (1, 3, '/home/m/app'), (2, 4, '/other')");
  for (const [sid, ts] of [[1, 1000 * DAY - 10 * DAY], [2, 1000 * DAY - DAY]] as [number, number][]) a.db.run("INSERT INTO analytics_facts(session_id, kind, ts, name) VALUES (?,'tool',?,'bash')", [sid, ts]);
  const rule = (when: object) => ({ id: "c", title: "C", body: "b", status: "on", when: { tool: "bash", minCalls: 1, minSessions: 1, withinDays: 30, kind: "tool", ...when } });
  const run = (when: object) => { a.cfg.tips = [rule(when)]; a.wife.scan(); const open = a.store.list().filter(c => c.kind === "feature_tip" && c.status === "open"); for (const c of open) a.db.run("SELECT 1") && a.store.db.run("DELETE FROM suggestions WHERE id=?", [c.id]); return open.length; };
  assert.equal(run({}), 1);
  assert.equal(run({ project: 9 }), 0);
  assert.equal(run({ cwd: "/home/m" }), 1);
  assert.equal(run({ project: 3, idleDays: 5 }), 1);    // project 3's last call was 10 days ago
  assert.equal(run({ project: 4, idleDays: 5 }), 0);    // project 4 called yesterday
});

test("a reminder card schedules into its session; a past time is refused", async () => {
  const a = setup();
  const due = 1000 * DAY + DAY;
  await a.wife.agree(file(a, "reminder_unscheduled", { sessionId: 1, content: "ping", dueAt: due }).id);
  assert.deepEqual(a.scheduled[0]!.slice(0, 3), [1, "ping", due]);
  await assert.rejects(a.wife.agree(file(a, "reminder_unscheduled", { sessionId: 1, content: "old", dueAt: 5 }, { fingerprint: "r2" }).id), /passed/);
  assert.equal(a.scheduled.length, 1);
});

test("cost, compaction, recap and rule-idea cards each open one work session and wait as working", async () => {
  const a = setup();
  for (const [k, payload] of [["cost_habit", { project: 3 }], ["compaction_heavy", { sessionId: 1 }], ["weekly_recap", { recap: "Done: x" }], ["rule_idea", { idea: "flag idle cron" }]] as const) {
    const r = await a.wife.agree(file(a, k, payload, { fingerprint: `${k}:1` }).id);
    assert.equal(r.status, "working", k);
  }
  assert.equal(a.sent.length, 4);
  assert.match(a.sent[3]!, /session_worktree/); assert.match(a.sent[3]!, /Do not merge/);
  assert.match(a.sent[0]!, /Change nothing yourself/);
});

test("a leftover browser tab in an idle session files a card; agree closes it", async () => {
  assert.equal(browserLeftovers([{ tabId: "a", session: 1, url: "https://x.io" }, { tabId: "b", session: 2, url: "https://y.io" }], s => s === 1).length, 1);
  const a = setup();
  a.advance(3 * DAY);   // session 1 is now 8 days idle
  a.wife.scan();
  const card = a.store.list().find(c => c.kind === "browser_leftover")!;
  await a.wife.agree(card.id);
  assert.deepEqual(a.closedTabs, ["t1"]);
});
