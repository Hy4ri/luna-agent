import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { openLuna, ProcessOwner } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";

async function makeTempDb() {
  const dir = await mkdtemp(join(tmpdir(), "luna-conv-test-"));
  const dbPath = join(dir, "luna.db");
  return {
    dir,
    dbPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("prime harness.conversation cache for idle conversation, store.delete(id) makes it absent and remains absent on reopen", async () => {
  const tmp = await makeTempDb();
  try {
    let harness = await openLuna({
      dbPath: tmp.dbPath,
      models: createModels(),
      memory: false,
      coding: false,
    });

    const store = new ConversationStore(harness);

    // Create a new independent conversation
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const id = conv.id;

    // Prime harness conversation cache
    const cachedConv = await harness.conversation(id, BACKGROUND_CONTEXT);
    expect(cachedConv).toBeTruthy() /* "conversation should be resolvable after creation" */;
    expect(cachedConv.id).toBe(id);

    // Hard delete through store
    const deleted = await store.delete(Number(id));
    expect(deleted).toEqual([Number(id)]);

    // Observable contract: harness.conversation(id) is now absent in existing harness
    const afterDeleteConv = await harness.conversation(id, BACKGROUND_CONTEXT);
    expect(afterDeleteConv).toBe(undefined) /* "conversation should be absent after deletion" */;

    // Close harness and reopen from scratch dbPath
    await harness.close(BACKGROUND_CONTEXT);

    harness = await openLuna({
      dbPath: tmp.dbPath,
      models: createModels(),
      memory: false,
      coding: false,
    });

    const reopenedConv = await harness.conversation(id, BACKGROUND_CONTEXT);
    expect(reopenedConv).toBe(undefined) /* "conversation remains absent on reopened harness" */;

    await harness.close(BACKGROUND_CONTEXT);
  } finally {
    await tmp.cleanup();
  }
});

test("overlapping delete(a) and metadata update/append for unrelated b preserves b title and entries", async () => {
  const tmp = await makeTempDb();
  try {
    const harness = await openLuna({
      dbPath: tmp.dbPath,
      models: createModels(),
      memory: false,
      coding: false,
    });

    const store = new ConversationStore(harness);

    // Create conversation a and conversation b
    const convA = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const convB = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const idA = Number(convA.id);
    const idB = Number(convB.id);

    // Prime metadata and entries for b
    await store.update(idB, { title: "Session B Title" });
    await harness.commit(async tx => {
      await tx.appendEntry(convB.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "hello b", timestamp: 100 }],
      });
    }, BACKGROUND_CONTEXT);

    // Overlapping delete(a) while metadata update and entry append execute for unrelated b
    const [deletedA, updateBResult, appendBResult] = await Promise.all([
      store.delete(idA),
      store.update(idB, { pinned: true }),
      harness.commit(async tx => {
        return tx.appendEntry(convB.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "followup b", timestamp: 200 }],
        });
      }, BACKGROUND_CONTEXT),
    ]);

    expect(deletedA).toEqual([idA]);
    expect(updateBResult.title).toBe("Session B Title");
    expect(updateBResult.pinned).toBe(true);
    expect(appendBResult).toBeTruthy();

    // Verify conversation a is deleted
    const checkA = await harness.conversation(convA.id, BACKGROUND_CONTEXT);
    expect(checkA).toBe(undefined) /* "conversation a should be absent" */;

    // Verify conversation b survives with its title, metadata, and entries intact
    const metaB = store.get(idB);
    expect(metaB.title).toBe("Session B Title");
    expect(metaB.pinned).toBe(true);

    const checkB = await harness.conversation(convB.id, BACKGROUND_CONTEXT);
    expect(checkB).toBeTruthy() /* "conversation b must survive" */;

    const entriesPage = await checkB.entries({}, 10, undefined, BACKGROUND_CONTEXT);
    expect(entriesPage.items.length).toBe(2) /* "conversation b should have preserved all its entries" */;

    await harness.close(BACKGROUND_CONTEXT);
  } finally {
    await tmp.cleanup();
  }
});

test("root delete/recreate does not return old context or ProcessOwner", async () => {
  const tmp = await makeTempDb();
  try {
    const harness = await openLuna({
      dbPath: tmp.dbPath,
      models: createModels(),
      memory: false,
      coding: false,
    });

    const store = new ConversationStore(harness);

    // Open/create root conversation
    const rootConv1 = await harness.root(BACKGROUND_CONTEXT);
    const rootId = Number(rootConv1.id);

    // Append entry and read initial ProcessOwner token
    await harness.commit(async tx => {
      await tx.appendEntry(rootConv1.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "root message 1", timestamp: 100 }],
      });
    }, BACKGROUND_CONTEXT);

    const owner1 = await harness.snapshot(ProcessOwner, rootConv1.id, BACKGROUND_CONTEXT);
    expect(owner1?.token).toBeTruthy() /* "root conv 1 must have a ProcessOwner token" */;

    // Hard delete root conversation
    const deleted = await store.delete(rootId);
    expect(deleted).toEqual([rootId]);

    const absentCheck = await harness.conversation(rootConv1.id, BACKGROUND_CONTEXT);
    expect(absentCheck).toBe(undefined) /* "root conversation should be absent after deletion" */;

    // Recreate root conversation
    const rootConv2 = await harness.root(BACKGROUND_CONTEXT);
    expect(Number(rootConv2.id)).toBe(rootId) /* "recreated root should share the root ID" */;

    // ProcessOwner token must be fresh (different from incarnation 1)
    const owner2 = await harness.snapshot(ProcessOwner, rootConv2.id, BACKGROUND_CONTEXT);
    expect(owner2?.token).toBeTruthy() /* "root conv 2 must have a ProcessOwner token" */;
    expect(owner2.token).not.toBe(owner1.token) /* "recreated root must not inherit old ProcessOwner token" */;

    // Recreated root context should only see its new context and not old entries
    const entriesPage = await rootConv2.entries({}, 10, undefined, BACKGROUND_CONTEXT);
    // Incarnation 2 has luna.context-start appended at creation; root message 1 must be gone
    const oldEntries = entriesPage.items.filter(
      entry => entry.kind === "pi.user" && JSON.stringify(entry).includes("root message 1"),
    );
    expect(oldEntries.length).toBe(0) /* "old entries from deleted root incarnation must not be visible" */;

    await harness.close(BACKGROUND_CONTEXT);
  } finally {
    await tmp.cleanup();
  }
});
