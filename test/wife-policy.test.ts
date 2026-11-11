import assert from "node:assert/strict";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { inQuietHours, inScope } from "../src/wife/policy.js";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";

const at = (h: number, m = 0) => new Date(2026, 5, 10, h, m).getTime();

test("quiet hours handle a window that crosses midnight", () => {
  const q = { enabled: true, from: "22:00", to: "08:00" };
  assert.equal(inQuietHours(q, at(23)), true);
  assert.equal(inQuietHours(q, at(3)), true);
  assert.equal(inQuietHours(q, at(8)), false);
  assert.equal(inQuietHours(q, at(12)), false);
  assert.equal(inQuietHours(null, at(23)), false);
  assert.equal(inQuietHours({ enabled: true, from: "09:00", to: "17:00" }, at(10)), true);
});

test("project scope: all, only, except", () => {
  assert.equal(inScope({ mode: "all", ids: [] }, 3), true);
  assert.equal(inScope({ mode: "only", ids: [3] }, 3), true);
  assert.equal(inScope({ mode: "only", ids: [3] }, 4), false);
  assert.equal(inScope({ mode: "except", ids: [3] }, 3), false);
});

function service(cfg: Record<string, unknown>, sessions: unknown[], clock: { t: number }) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE analytics_facts(session_id INTEGER, kind TEXT, ts INTEGER, name TEXT, model TEXT, error INTEGER DEFAULT 0, cost_total REAL); CREATE TABLE analytics_sessions(id INTEGER, deleted_at INTEGER)");
  const store = new WifeStore(":memory:", () => clock.t);
  const conversations = { projects: { list: () => [], links: () => new Map() }, board: { list: () => [] } } as never;
  const wife = new WifeService({ store, conversations, analytics: () => ({ sessions: () => sessions, db }) as never, now: () => clock.t,
    config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, ...cfg }) as never });
  return { store, wife };
}
const stale = (id: number, projectId = 0) => ({ id, title: `s${id}`, parentId: null, projectId, worker: "main", cwd: null, createdAt: 0, lastActivity: 0, status: "idle", archived: false, pinned: false,
  deletedAt: null, workflow: { goals: 0, completedGoals: 0, todos: 0, completedTodos: 0 } });

test("the daily cap holds extra cards, and they show the next day", () => {
  const clock = { t: at(12) };
  // 3 archive cards and 2 delete cards: no group is large enough to batch.
  const spread = [1, 2, 3].map(i => stale(i)).concat([4, 5].map(i => ({ ...stale(i), archived: true })));
  const { store, wife } = service({ maxNewPerDay: 2 }, spread, clock);
  const r = wife.scan();
  assert.equal(store.count("open"), 2);
  assert.equal(r.held, 3);
  clock.t += 86_400_000;
  wife.scan();
  assert.equal(store.count("open"), 2 + 2);
});

test("quiet hours hide new cards until they end; the badge count stays frozen", () => {
  const clock = { t: at(23) };
  const { store, wife } = service({ quietHours: { enabled: true, from: "22:00", to: "08:00" } }, [stale(1)], clock);
  wife.scan();
  assert.equal(store.count("open"), 0);
  assert.equal(store.list().length, 0);
  clock.t = at(9) + 86_400_000;
  wife.scan();
  assert.equal(store.count("open"), 1);
});

test("a muted project gets no cards, and 'ask wife' on one session bypasses cap and quiet hours", () => {
  const clock = { t: at(23) };
  const { store, wife } = service({ projects: { mode: "except", ids: [7] }, quietHours: { enabled: true, from: "22:00", to: "08:00" } }, [stale(1, 7), stale(2, 8)], clock);
  wife.scan();
  assert.equal(store.has("archive_session:1"), false);
  assert.equal(store.count("open"), 0); // session 2 is held by quiet hours
  const r = wife.scan({ session: 2 });
  assert.equal(r.filed, 0);
  assert.equal(store.count("open"), 1);
});

test("Scan now fills the page up to the cap even when today's cap is used; the timer does not", () => {
  const clock = { t: at(12) };
  const { store, wife } = service({ maxNewPerDay: 2 }, [1, 2, 3].map(i => stale(i)).concat([4, 5].map(i => ({ ...stale(i), archived: true }))), clock);
  wife.scan();
  assert.equal(store.count("open"), 2);
  for (const c of store.list("open")) store.setStatus(c.id, "dismissed");
  assert.equal(wife.scan().shown, 0);  // the timer respects the used cap
  assert.equal(store.count("open"), 0);
  const r = wife.scan({ manual: true });
  assert.equal(r.shown, 2);
  assert.equal(store.count("open"), 2);
  assert.equal(r.held, 1);
});

test("Ask Wife shows held cards about the session and reports how many match", () => {
  const clock = { t: at(12) };
  const { store, wife } = service({ maxNewPerDay: 0 }, [stale(1), stale(2)], clock);
  wife.scan();
  assert.equal(store.count("open"), 0);
  const r = wife.scan({ session: 1 });
  assert.equal(r.matched, 1);
  assert.equal(store.count("open"), 1);
  assert.equal(wife.scan({ session: 99 }).matched, 0);
});

test("held cards are released by value: an unfinished goal before a weekly recap", () => {
  const clock = { t: at(12) };
  const store = new WifeStore(":memory:", () => clock.t);
  const card = (kind: string, fp: string) => ({ kind, fingerprint: fp, title: fp, body: "b", evidence: [], payload: {}, source: "detector" }) as never;
  store.file(card("weekly_recap", "a"), false);
  store.file(card("compaction_heavy", "b"), false);
  store.file(card("goal_unfinished", "c"), false);
  assert.equal(store.release(1), 1);
  assert.deepEqual(store.list().map(c => c.fingerprint), ["c"]);
});
