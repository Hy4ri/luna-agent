// Contract: Discuss opens one seeded session per card, and agreeing to a skill card starts a work session that settles when it ends.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";

const db = new Database(":memory:");
db.exec("CREATE TABLE analytics_facts(session_id INTEGER, kind TEXT, ts INTEGER, name TEXT, model TEXT, error INTEGER DEFAULT 0); CREATE TABLE analytics_sessions(id INTEGER, deleted_at INTEGER)");
function setup(over: { records?: { id: number; status: string }[]; skills?: Set<string> } = {}) {
  const sent: { project: number | null; title: string; content: string }[] = [];
  const store = new WifeStore(":memory:");
  const records = over.records ?? [];
  const wife = new WifeService({ store, conversations: { projects: { projectOf: (i: number) => (i === 5 ? 3 : undefined), list: () => [], links: () => new Map() }, board: { list: () => [] } } as never,
    analytics: () => ({ sessions: () => records, db }) as never,
    config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }),
    startSession: async (project, title, content) => { sent.push({ project, title, content }); return 900 + sent.length; },
    skillExists: n => over.skills?.has(n) ?? false });
  const card = store.file({ kind: "skill", fingerprint: "skill:deploy", title: "Deploy skill", body: "You repeat deploys.", evidence: [{ sessionId: 5, note: "deployed" }],
    payload: { name: "deploy", outline: "run build then push" }, source: "model" })!;
  return { store, wife, sent, card, records };
}

test("discuss seeds one session in the evidence project and reuses it", async () => {
  const { wife, sent, card, store } = setup();
  const sid = await wife.discuss(card.id);
  assert.equal(sid, 901);
  assert.equal(sent[0]!.project, 3);
  assert.match(sent[0]!.content, /Deploy skill/);
  assert.match(sent[0]!.content, /session 5: deployed/);
  assert.match(sent[0]!.content, /create managed skill "deploy"/);
  assert.equal(store.get(card.id)!.status, "open");
  assert.equal(await wife.discuss(card.id), 901);
  assert.equal(sent.length, 1);
});

test("agreeing to a skill card starts a work session; it becomes done when the skill exists, failed when not", async () => {
  const a = setup({ records: [{ id: 901, status: "running" }], skills: new Set() });
  const working = await a.wife.agree(a.card.id);
  assert.equal(working.status, "working");
  assert.match(a.sent[0]!.content, /skill action=create/);
  a.wife.scan();
  assert.equal(a.store.get(a.card.id)!.status, "working");   // still running
  a.records[0]!.status = "finished";
  a.wife.scan();
  assert.equal(a.store.get(a.card.id)!.status, "failed");

  const b = setup({ records: [{ id: 901, status: "finished" }], skills: new Set(["deploy"]) });
  await b.wife.agree(b.card.id);
  b.wife.scan();
  assert.equal(b.store.get(b.card.id)!.status, "done");
});

test("agree on a goal card opens a session instead of closing the card, and settling adds no second agree", async () => {
  const a = setup({ records: [{ id: 901, status: "finished" }] });
  const g = a.store.file({ kind: "goal_unfinished", fingerprint: "goal_unfinished:5", title: "Resume", body: "b", evidence: [{ sessionId: 5, note: "n" }], payload: { sessionId: 5 }, source: "detector" })!;
  const r = await a.wife.agree(g.id);
  assert.equal(r.status, "working");
  assert.equal(a.sent.length, 1);
  a.wife.scan();
  assert.equal(a.store.get(g.id)!.status, "done");
  assert.equal(a.store.outcomes().filter(o => o.suggestionId === g.id && o.action === "agree").length, 1);
});

test("worktree removal needs confirm", async () => {
  const a = setup();
  let removed = false;
  (a.wife as unknown as { o: Record<string, unknown> }).o.worktrees = () => [{ path: "/w", branch: "luna/s1", merged: true, dirty: false }];
  (a.wife as unknown as { o: Record<string, unknown> }).o.removeWorktree = async () => { removed = true; };
  const w = a.store.file({ kind: "worktree_orphan", fingerprint: "worktree_orphan:/w", title: "t", body: "b", evidence: [], payload: { path: "/w", branch: "luna/s1" }, source: "detector" })!;
  await assert.rejects(a.wife.agree(w.id), /confirm/);
  assert.equal(removed, false);
  await a.wife.agree(w.id, { confirm: true });
  assert.equal(removed, true);
});

test("admit skips muted kinds and holds model cards over the daily cap", () => {
  const a = setup();
  const cfg = (a.wife as unknown as { o: { config: () => Record<string, unknown> } }).o;
  const base = { kind: "memory" as const, fingerprint: "m", title: "t", body: "b", evidence: [], payload: {}, source: "model" as const };
  assert.equal(a.wife.admit(base), "show");
  cfg.config = () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, mutedKinds: ["memory"] });
  assert.equal(a.wife.admit(base), "skip");
  cfg.config = () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, maxNewPerDay: 0 });
  assert.equal(a.wife.admit(base), "hold");
});
