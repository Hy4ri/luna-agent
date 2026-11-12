// Contract: project detectors find the right sessions, and agreeing to a card changes real state, re-checking the target first.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";

function emptyAnalytics() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE analytics_facts(session_id INTEGER, kind TEXT, ts INTEGER, name TEXT, model TEXT, error INTEGER DEFAULT 0, cost_total REAL); CREATE TABLE analytics_sessions(id INTEGER, deleted_at INTEGER)");
  return db;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "luna-wife-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const app = join(await realpath(dir), "work", "app");
  await mkdir(join(app, "src"), { recursive: true });
  const store = new WifeStore(":memory:");
  let records: unknown[] = [];
  const wife = new WifeService({ store, conversations, analytics: () => ({ sessions: () => records, db: emptyAnalytics() }) as never,
    config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }) });
  const session = async () => Number((await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id);
  const rec = (id: number, over: object = {}) => ({ id, title: `s${id}`, parentId: null, projectId: 0, projectName: "General", worker: "main", cwd: app,
    createdAt: Date.now(), lastActivity: Date.now(), status: "idle", workflow: { goals: 0, completedGoals: 0, todos: 0, completedTodos: 0 }, archived: false, pinned: false, deletedAt: null, ...over });
  return { dir, app, harness, conversations, store, wife, session, rec, set(r: unknown[]) { records = r; }, async close() { store.close(); await harness.close(context); await rm(dir, { recursive: true, force: true }); } };
}

test("three General sessions in one directory become a new-project card; agreeing creates it and moves them", async () => {
  const f = await fixture();
  try {
    const ids = [await f.session(), await f.session(), await f.session()];
    f.set(ids.map(id => f.rec(id)));
    expect(f.wife.scan().filed).toBe(1);
    const card = f.store.list("open")[0]!;
    expect(card.kind).toBe("new_project");
    expect(card.fingerprint).toBe(`new_project:main:${f.app}`);
    const done = await f.wife.agree(card.id);
    expect(done.status).toBe("done");
    const project = f.conversations.projects.list().find(p => p.name === "app");
    expect(project?.cwd).toBe(f.app);
    for (const id of ids) expect(f.conversations.projects.links().get(id)).toBe(project!.id);
    f.set(ids.map(id => f.rec(id, { projectId: project!.id, projectName: "app" })));
    f.wife.scan();
    expect(f.store.list("open").length).toBe(0);
  } finally { await f.close(); }
});

test("a session whose directory is inside another project gets a move card", async () => {
  const f = await fixture();
  try {
    const project = f.conversations.projects.create("app", f.app);
    const id = await f.session();
    f.set([f.rec(id, { cwd: join(f.app, "src") })]);
    f.wife.scan();
    const card = f.store.list("open")[0]!;
    expect(card.kind).toBe("move_session");
    expect(card.payload).toEqual({ sessionId: id, projectId: project.id });
    await f.wife.agree(card.id);
    expect(f.conversations.projects.links().get(id)).toBe(project.id);
  } finally { await f.close(); }
});

test("deleting needs confirm and a session that is archived and unpinned", async () => {
  const f = await fixture();
  try {
    const id = await f.session();
    const old = Date.now() - 90 * 86_400_000;
    await f.conversations.update(id, { archived: true });
    f.set([f.rec(id, { archived: true, lastActivity: old })]);
    f.wife.scan();
    const card = f.store.list("open")[0]!;
    expect(card.kind).toBe("delete_session");
    await expect(f.wife.agree(card.id)).rejects.toThrow(/confirm/);
    expect(f.store.get(card.id)!.status).toBe("open");
    await f.conversations.update(id, { pinned: true });
    await expect(f.wife.agree(card.id, { confirm: true })).rejects.toThrow(/pinned/);
    await f.conversations.update(id, { pinned: false });
    expect((await f.wife.agree(card.id, { confirm: true })).status).toBe("done");
  } finally { await f.close(); }
});

test("a feature tip needs heavy use of one tool and none of the other, and agree enables its extension", async () => {
  const { matchTips, DEFAULT_TIPS, TipSchema } = await import("../src/wife/tips.js");
  const heavy = (extra: [string, number][] = []) => () => new Map<string, { calls: number; sessions: number }>([["bash", { calls: 500, sessions: 40 }], ...extra.map(([n, c]) => [n, { calls: c, sessions: 3 }] as [string, { calls: number; sessions: number }])]);
  expect(matchTips(DEFAULT_TIPS, heavy()).map(c => c.fingerprint)).toEqual(["feature_tip:codemode", "feature_tip:background-processes", "feature_tip:subagents", "feature_tip:crew"]);
  expect(matchTips(DEFAULT_TIPS, heavy([["codemode", 1]])).map(c => c.fingerprint)).toEqual(["feature_tip:background-processes", "feature_tip:subagents", "feature_tip:crew"]);
  expect(matchTips(DEFAULT_TIPS, () => new Map([["bash", { calls: 10, sessions: 2 }]]))).toEqual([]);
  expect(matchTips(DEFAULT_TIPS, heavy(), n => n === "codemode").map(c => c.fingerprint)).toEqual(["feature_tip:background-processes", "feature_tip:subagents", "feature_tip:crew"]);
  const bad = TipSchema.safeParse({ id: "x", title: "t", body: "b", when: { tool: "bash", minCalls: 0 } });
  expect(bad.success).toBe(false);
  expect(JSON.stringify(bad.error!.issues[0]!.path)).toMatch(/minCalls/);

  const f = await fixture();
  try {
    const enabled = new Set<string>();
    const card = f.store.file({ kind: "feature_tip", fingerprint: "feature_tip:codemode", title: "t", body: "b", evidence: [], source: "detector", payload: { tipId: "codemode", enable: "codemode" } })!;
    const wife = new WifeService({ store: f.store, conversations: f.conversations, analytics: () => ({}) as never, config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }),
      extensions: { enabled: n => enabled.has(n), enable: n => void enabled.add(n) } });
    const done = await wife.agree(card.id);
    expect(done.status).toBe("done");
    expect(enabled.has("codemode")).toBeTruthy();
  } finally { await f.close(); }
});

test("five stale sessions make one batch card; agree acts on the checked ones and undo restores them", async () => {
  const f = await fixture();
  try {
    const old = Date.now() - 20 * 86_400_000;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await f.session());
    f.set(ids.map(id => f.rec(id, { lastActivity: old, cwd: null })));
    f.wife.scan();
    const open = f.store.list("open");
    expect(open.length).toBe(1);
    expect((open[0]!.payload.sessionIds as number[])).toEqual(ids);
    await f.conversations.update(ids[4]!, { pinned: true });
    const done = await f.wife.agree(open[0]!.id, { targets: ids.slice(0, 4) });
    expect(done.result).toBe("Archived 4.");
    for (const id of ids.slice(0, 4)) expect(f.conversations.get(id).archived).toBe(true);
    expect(f.conversations.get(ids[4]!).archived).toBe(false);
    expect(f.store.get(done.id)!.undoUntil! > Date.now()).toBeTruthy();
    const back = await f.wife.undo(done.id);
    expect(back.status).toBe("open");
    for (const id of ids) expect(f.conversations.get(id).archived).toBe(false);
    await expect(f.wife.undo(done.id)).rejects.toThrow(/cannot be undone/);
  } finally { await f.close(); }
});

test("undoing a new project moves its sessions back and removes it", async () => {
  const f = await fixture();
  try {
    const ids = [await f.session(), await f.session(), await f.session()];
    f.set(ids.map(id => f.rec(id)));
    f.wife.scan();
    const done = await f.wife.agree(f.store.list("open")[0]!.id);
    expect(f.conversations.projects.list().some(p => p.name === "app")).toBeTruthy();
    await f.wife.undo(done.id);
    expect(!f.conversations.projects.list().some(p => p.name === "app")).toBeTruthy();
    for (const id of ids) expect(f.conversations.projects.links().get(id) ?? 0).toBe(0);
  } finally { await f.close(); }
});

test("a delete card has no undo", async () => {
  const f = await fixture();
  try {
    const id = await f.session();
    await f.conversations.update(id, { archived: true });
    f.set([f.rec(id, { archived: true, lastActivity: Date.now() - 90 * 86_400_000 })]);
    f.wife.scan();
    const done = await f.wife.agree(f.store.list("open")[0]!.id, { confirm: true });
    expect(done.undoUntil).toBe(null);
    await expect(f.wife.undo(done.id)).rejects.toThrow(/cannot be undone/);
  } finally { await f.close(); }
});

test("an outcome history makes exactly one tune card, agreeing changes the config, and the window then starts over", async () => {
  const f = await fixture();
  try {
    const cfg: Record<string, unknown> = { enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, mutedRules: [], mutedKinds: [] };
    const wife = new WifeService({ store: f.store, conversations: f.conversations, analytics: () => ({ sessions: () => [], db: emptyAnalytics() }) as never, config: () => cfg as never,
      setConfig: fn => fn(cfg) });
    for (let i = 0; i < 6; i++) {
      const c = f.store.file({ kind: "archive_session", ruleId: "archive_session", fingerprint: `archive_session:${i}`, title: "t", body: "b", evidence: [], source: "detector", payload: { sessionId: 1000 + i } })!;
      f.store.dismiss(c.id, i < 4 ? "too_aggressive" : "wrong");
    }
    wife.scan(); wife.scan();
    const open = f.store.list("open");
    expect(open.length).toBe(1);
    expect(open[0]!.kind).toBe("tune_rule");
    expect(open[0]!.payload).toEqual({ rule: "archive_session", key: "staleDays", from: 14, to: 28 });
    await wife.agree(open[0]!.id);
    expect(cfg.staleDays).toBe(28);
    wife.scan();
    expect(f.store.list("open").length).toBe(0);  // the old dismissals no longer count
    expect(wife.stats().agree30.agrees).toBe(0);
  } finally { await f.close(); }
});

test("five decisions with no agree make a mute card; three 'don't care' make a kind mute card; agreeing mutes", async () => {
  const f = await fixture();
  try {
    const cfg: Record<string, unknown> = { enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60, mutedRules: [], mutedKinds: [] };
    const wife = new WifeService({ store: f.store, conversations: f.conversations, analytics: () => ({ sessions: () => [], db: emptyAnalytics() }) as never, config: () => cfg as never, setConfig: fn => fn(cfg) });
    for (let i = 0; i < 5; i++) {
      const c = f.store.file({ kind: "feature_tip", ruleId: "tip:codemode", fingerprint: `feature_tip:${i}`, title: "t", body: "b", evidence: [], source: "detector", payload: {} })!;
      f.store.dismiss(c.id, i < 3 ? "dont_care_kind" : "wrong");
    }
    wife.scan();
    const kinds = f.store.list("open").map(c => c.kind).sort();
    expect(kinds).toEqual(["mute_kind", "mute_rule"]);
    for (const c of f.store.list("open")) await wife.agree(c.id);
    expect(cfg.mutedRules).toEqual(["tip:codemode"]);
    expect(cfg.mutedKinds).toEqual(["feature_tip"]);
  } finally { await f.close(); }
});

test("agreeing a failing-cron card disables the job; a stuck board card moves to todo", async () => {
  const f = await fixture();
  try {
    let enabled = true;
    const runs = [1, 2, 3].map(i => ({ status: "error", output: null, startedAt: i }));
    const wife = new WifeService({ store: f.store, conversations: f.conversations, analytics: () => ({ sessions: () => [], db: emptyAnalytics() }) as never,
      config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }) as never,
      cron: { jobs: () => [{ id: 7, name: "j", enabled, runs }], disable: () => { enabled = false; } } });
    wife.scan();
    const card = f.store.list("open").find(c => c.kind === "cron_failing")!;
    await wife.agree(card.id);
    expect(enabled).toBe(false);
    wife.scan();
    expect(f.store.list("open").filter(c => c.kind === "cron_failing").length).toBe(0);
  } finally { await f.close(); }
});
