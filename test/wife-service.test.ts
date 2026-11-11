// Contract: project detectors find the right sessions, and agreeing to a card changes real state, re-checking the target first.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";

function emptyAnalytics() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE analytics_facts(session_id INTEGER, kind TEXT, ts INTEGER, name TEXT, model TEXT); CREATE TABLE analytics_sessions(id INTEGER, deleted_at INTEGER)");
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
    assert.equal(f.wife.scan().filed, 1);
    const card = f.store.list("open")[0]!;
    assert.equal(card.kind, "new_project");
    assert.equal(card.fingerprint, `new_project:main:${f.app}`);
    const done = await f.wife.agree(card.id);
    assert.equal(done.status, "done");
    const project = f.conversations.projects.list().find(p => p.name === "app");
    assert.equal(project?.cwd, f.app);
    for (const id of ids) assert.equal(f.conversations.projects.links().get(id), project!.id);
    f.set(ids.map(id => f.rec(id, { projectId: project!.id, projectName: "app" })));
    f.wife.scan();
    assert.equal(f.store.list("open").length, 0);
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
    assert.equal(card.kind, "move_session");
    assert.deepEqual(card.payload, { sessionId: id, projectId: project.id });
    await f.wife.agree(card.id);
    assert.equal(f.conversations.projects.links().get(id), project.id);
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
    assert.equal(card.kind, "delete_session");
    await assert.rejects(f.wife.agree(card.id), /confirm/);
    assert.equal(f.store.get(card.id)!.status, "open");
    await f.conversations.update(id, { pinned: true });
    await assert.rejects(f.wife.agree(card.id, { confirm: true }), /pinned/);
    await f.conversations.update(id, { pinned: false });
    assert.equal((await f.wife.agree(card.id, { confirm: true })).status, "done");
  } finally { await f.close(); }
});

test("a feature tip needs heavy use of one tool and none of the other, and agree enables its extension", async () => {
  const { matchTips, DEFAULT_TIPS, TipSchema } = await import("../src/wife/tips.js");
  const heavy = (extra: [string, number][] = []) => () => new Map<string, { calls: number; sessions: number }>([["bash", { calls: 500, sessions: 40 }], ...extra.map(([n, c]) => [n, { calls: c, sessions: 3 }] as [string, { calls: number; sessions: number }])]);
  assert.deepEqual(matchTips(DEFAULT_TIPS, heavy()).map(c => c.fingerprint), ["feature_tip:codemode", "feature_tip:background-processes"]);
  assert.deepEqual(matchTips(DEFAULT_TIPS, heavy([["codemode", 1]])).map(c => c.fingerprint), ["feature_tip:background-processes"]);
  assert.deepEqual(matchTips(DEFAULT_TIPS, () => new Map([["bash", { calls: 10, sessions: 2 }]])), []);
  assert.deepEqual(matchTips(DEFAULT_TIPS, heavy(), n => n === "codemode").map(c => c.fingerprint), ["feature_tip:background-processes"]);
  const bad = TipSchema.safeParse({ id: "x", title: "t", body: "b", when: { tool: "bash", minCalls: 0 } });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error!.issues[0]!.path), /minCalls/);

  const f = await fixture();
  try {
    const enabled = new Set<string>();
    const card = f.store.file({ kind: "feature_tip", fingerprint: "feature_tip:codemode", title: "t", body: "b", evidence: [], source: "detector", payload: { tipId: "codemode", enable: "codemode" } })!;
    const wife = new WifeService({ store: f.store, conversations: f.conversations, analytics: () => ({}) as never, config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }),
      extensions: { enabled: n => enabled.has(n), enable: n => void enabled.add(n) } });
    const done = await wife.agree(card.id);
    assert.equal(done.status, "done");
    assert.ok(enabled.has("codemode"));
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
    assert.equal(open.length, 1);
    assert.deepEqual((open[0]!.payload.sessionIds as number[]), ids);
    await f.conversations.update(ids[4]!, { pinned: true });
    const done = await f.wife.agree(open[0]!.id, { targets: ids.slice(0, 4) });
    assert.equal(done.result, "Archived 4.");
    for (const id of ids.slice(0, 4)) assert.equal(f.conversations.get(id).archived, true);
    assert.equal(f.conversations.get(ids[4]!).archived, false);
    assert.ok(f.store.get(done.id)!.undoUntil! > Date.now());
    const back = await f.wife.undo(done.id);
    assert.equal(back.status, "open");
    for (const id of ids) assert.equal(f.conversations.get(id).archived, false);
    await assert.rejects(f.wife.undo(done.id), /cannot be undone/);
  } finally { await f.close(); }
});

test("undoing a new project moves its sessions back and removes it", async () => {
  const f = await fixture();
  try {
    const ids = [await f.session(), await f.session(), await f.session()];
    f.set(ids.map(id => f.rec(id)));
    f.wife.scan();
    const done = await f.wife.agree(f.store.list("open")[0]!.id);
    assert.ok(f.conversations.projects.list().some(p => p.name === "app"));
    await f.wife.undo(done.id);
    assert.ok(!f.conversations.projects.list().some(p => p.name === "app"));
    for (const id of ids) assert.equal(f.conversations.projects.links().get(id) ?? 0, 0);
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
    assert.equal(done.undoUntil, null);
    await assert.rejects(f.wife.undo(done.id), /cannot be undone/);
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
    assert.equal(open.length, 1);
    assert.equal(open[0]!.kind, "tune_rule");
    assert.deepEqual(open[0]!.payload, { rule: "archive_session", key: "staleDays", from: 14, to: 28 });
    await wife.agree(open[0]!.id);
    assert.equal(cfg.staleDays, 28);
    wife.scan();
    assert.equal(f.store.list("open").length, 0);  // the old dismissals no longer count
    assert.equal(wife.stats().agree30.agrees, 0);
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
    assert.deepEqual(kinds, ["mute_kind", "mute_rule"]);
    for (const c of f.store.list("open")) await wife.agree(c.id);
    assert.deepEqual(cfg.mutedRules, ["tip:codemode"]);
    assert.deepEqual(cfg.mutedKinds, ["feature_tip"]);
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
    assert.equal(enabled, false);
    wife.scan();
    assert.equal(f.store.list("open").filter(c => c.kind === "cron_failing").length, 0);
  } finally { await f.close(); }
});
