import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { Todo, TodoDoc, applyTodo } from "../src/todo.js";
import { conversationStorage } from "../src/conversation-storage.js";
import { scanAnalyticsSession } from "../src/analytics/source.js";

// Protects ownership and incremental analytics against double counting fork history.
test("analytics source parses owned entries only, then only the appended tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-source-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const firstEntry = await harness.commit(tx => tx.appendEntry(conv.id, {
      kind: "pi.user", model: [{ role: "user", content: "private message not to be stored", timestamp: 1000 }],
    }), context);
    const db = conversationStorage(harness).db;
    const first = scanAnalyticsSession(db, Number(conv.id));
    assert.ok(first);
    assert.equal(first.session.userTurns, 1);
    assert.equal(first.entriesScanned, 1);
    assert.equal(first.session.lastEntryId, Number(firstEntry.id));
    assert.equal(JSON.stringify(first).includes("private message not to be stored"), false);
    const unchanged = scanAnalyticsSession(db, Number(conv.id), first.session);
    assert.ok(unchanged);
    assert.equal(unchanged.entriesScanned, 0);
    assert.equal(unchanged.session.userTurns, 1);
    await harness.commit(tx => tx.appendEntry(conv.id, {
      kind: "pi.user", model: [{ role: "user", content: "new message", timestamp: 2000 }],
    }), context);
    const next = scanAnalyticsSession(db, Number(conv.id), first.session);
    assert.ok(next);
    assert.equal(next.entriesScanned, 1);
    assert.equal(next.session.userTurns, 2);
    assert.equal(next.session.lastActivity, 2000);
    assert.equal(next.rebuild, false);
    assert.equal(scanAnalyticsSession(db, 999999999), undefined);
  } finally {
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

// Protects workflow.todos against counting deleted tombstones as unfinished work.
test("analytics source excludes deleted luna.todo tombstones from workflow todo counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-todo-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false, extensions: [Todo] });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(TodoDoc, conv.id);
      let state = { tasks: doc.tasks, nextId: doc.nextId };
      state = applyTodo(state, { action: "create", subject: "Finish feature" }).state;
      state = applyTodo(state, { action: "create", subject: "Blocker no longer needed" }).state;
      state = applyTodo(state, { action: "update", id: 1, status: "completed" }).state;
      state = applyTodo(state, { action: "update", id: 2, status: "deleted" }).state;
      doc.tasks = state.tasks as never;
      doc.nextId = state.nextId;
    }, context);

    const db = conversationStorage(harness).db;
    const scan = scanAnalyticsSession(db, Number(conv.id));
    assert.ok(scan);
    assert.equal(scan.session.workflow.todos, 1);
    assert.equal(scan.session.workflow.completedTodos, 1);

    await harness.commit(async (tx) => {
      const doc = await tx.doc(TodoDoc, conv.id);
      let state = { tasks: doc.tasks, nextId: doc.nextId };
      state = applyTodo(state, { action: "create", subject: "Active follow-up" }).state;
      doc.tasks = state.tasks as never;
      doc.nextId = state.nextId;
    }, context);

    const updated = scanAnalyticsSession(db, Number(conv.id), scan.session);
    assert.ok(updated);
    assert.equal(updated.session.workflow.todos, 2);
    assert.equal(updated.session.workflow.completedTodos, 1);
  } finally {
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});
