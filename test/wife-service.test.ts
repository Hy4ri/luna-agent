// Contract: project detectors find the right sessions, and agreeing to a card changes real state, re-checking the target first.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "luna-wife-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const app = join(await realpath(dir), "work", "app");
  await mkdir(join(app, "src"), { recursive: true });
  const store = new WifeStore(":memory:");
  let records: unknown[] = [];
  const wife = new WifeService({ store, conversations, analytics: () => ({ sessions: () => records }) as never,
    config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }) });
  const session = async () => Number((await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id);
  const rec = (id: number, over: object = {}) => ({ id, title: `s${id}`, parentId: null, projectId: 0, projectName: "General", worker: "main", cwd: app,
    createdAt: Date.now(), lastActivity: Date.now(), status: "idle", archived: false, pinned: false, deletedAt: null, ...over });
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
