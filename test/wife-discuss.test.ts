// Contract: Discuss opens one seeded session per card, and agreeing to a skill card starts a work session that settles when it ends.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";

const db = new Database(":memory:");
db.exec("CREATE TABLE analytics_facts(session_id INTEGER, kind TEXT, ts INTEGER, name TEXT, model TEXT, error INTEGER DEFAULT 0, cost_total REAL); CREATE TABLE analytics_sessions(id INTEGER, deleted_at INTEGER)");
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
  expect(sid).toBe(901);
  expect(sent[0]!.project).toBe(3);
  expect(sent[0]!.content).toMatch(/Deploy skill/);
  expect(sent[0]!.content).toMatch(/session 5: deployed/);
  expect(sent[0]!.content).toMatch(/create managed skill "deploy"/);
  expect(store.get(card.id)!.status).toBe("open");
  expect(await wife.discuss(card.id)).toBe(901);
  expect(sent.length).toBe(1);
});

test("agreeing to a skill card starts a work session; it becomes done when the skill exists, failed when not", async () => {
  const a = setup({ records: [{ id: 901, status: "running" }], skills: new Set() });
  const working = await a.wife.agree(a.card.id);
  expect(working.status).toBe("working");
  expect(a.sent[0]!.content).toMatch(/skill action=create/);
  a.wife.scan();
  expect(a.store.get(a.card.id)!.status).toBe("working");   // still running
  a.records[0]!.status = "finished";
  a.wife.scan();
  expect(a.store.get(a.card.id)!.status).toBe("failed");

  const b = setup({ records: [{ id: 901, status: "finished" }], skills: new Set(["deploy"]) });
  await b.wife.agree(b.card.id);
  b.wife.scan();
  expect(b.store.get(b.card.id)!.status).toBe("done");
});

test("agree on a goal card opens a session instead of closing the card, and settling adds no second agree", async () => {
  const a = setup({ records: [{ id: 901, status: "finished" }] });
  const g = a.store.file({ kind: "goal_unfinished", fingerprint: "goal_unfinished:5", title: "Resume", body: "b", evidence: [{ sessionId: 5, note: "n" }], payload: { sessionId: 5 }, source: "detector" })!;
  const r = await a.wife.agree(g.id);
  expect(r.status).toBe("working");
  expect(a.sent.length).toBe(1);
  a.wife.scan();
  expect(a.store.get(g.id)!.status).toBe("done");
  expect(a.store.outcomes().filter(o => o.suggestionId === g.id && o.action === "agree").length).toBe(1);
});

test("worktree removal needs confirm", async () => {
  const a = setup();
  let removed = false;
  (a.wife as unknown as { o: Record<string, unknown> }).o.worktrees = () => [{ path: "/w", branch: "luna/s1", merged: true, dirty: false }];
  (a.wife as unknown as { o: Record<string, unknown> }).o.removeWorktree = async () => { removed = true; };
  const w = a.store.file({ kind: "worktree_orphan", fingerprint: "worktree_orphan:/w", title: "t", body: "b", evidence: [], payload: { path: "/w", branch: "luna/s1" }, source: "detector" })!;
  await expect(a.wife.agree(w.id)).rejects.toThrow(/confirm/);
  expect(removed).toBe(false);
  await a.wife.agree(w.id, { confirm: true });
  expect(removed).toBe(true);
});

test("admit skips muted kinds and holds model cards over the daily cap", () => {
  const a = setup();
  const cfg = (a.wife as unknown as { o: { config: () => Record<string, unknown> } }).o;
  const base = { kind: "memory" as const, fingerprint: "m", title: "t", body: "b", evidence: [], payload: {}, source: "model" as const };
  expect(a.wife.admit(base)).toBe("show");
  cfg.config = () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, mutedKinds: ["memory"] });
  expect(a.wife.admit(base)).toBe("skip");
  cfg.config = () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, maxNewPerDay: 0 });
  expect(a.wife.admit(base)).toBe("hold");
});

test("the agree seed for a goal card authorizes the work", async () => {
  const a = setup({ records: [{ id: 901, status: "finished" }] });
  const g = a.store.file({ kind: "goal_unfinished", fingerprint: "goal_unfinished:6", title: "Resume", body: "b", evidence: [{ sessionId: 5, note: "n" }], payload: { sessionId: 5 }, source: "detector" })!;
  await a.wife.agree(g.id);
  expect(a.sent[0]!.content).not.toMatch(/Do not change anything/);
  expect(a.sent[0]!.content).toMatch(/Do the work/);
});

test("admit checks the action target session, not only the evidence", () => {
  const a = setup();
  (a.wife as unknown as { o: { config: () => Record<string, unknown>; analytics: () => unknown } }).o.config = () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, projects: { mode: "only", ids: [1] } });
  (a.wife as unknown as { o: { analytics: () => unknown } }).o.analytics = () => ({ sessions: () => [{ id: 1, projectId: 1 }, { id: 2, projectId: 2 }] });
  const card = { kind: "reminder_unscheduled" as const, fingerprint: "r", title: "t", body: "b", evidence: [{ sessionId: 1, note: "n" }], payload: { sessionId: 2 }, source: "model" as const };
  expect(a.wife.admit(card)).toBe("skip");
  expect(a.wife.admit({ ...card, payload: { sessionId: 1 } })).toBe("show");
});
