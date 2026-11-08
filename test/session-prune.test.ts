import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { SessionCreated } from "../src/session-activity.js";

// Prune caches subagent links and message ages between calls. Later writes must still protect sessions.
test("prune: links and ages written after a cached preview still protect sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-prune-test-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  try {
    const store = new ConversationStore(harness);
    const old = Date.now() - 10 * 86400000;
    const session = async (at: number, parent?: ConversationId) => {
      const c = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      await harness.commit(async tx => {
        (await tx.doc(SessionCreated, c.id)).at = old;
        if (parent) await tx.appendEntry(c.id, { kind: "delegate.child", data: { task: "t", parent: Number(parent) } });
        await tx.appendEntry(c.id, { kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: at }] });
      }, BACKGROUND_CONTEXT);
      return c.id;
    };
    const options = { days: 1, includeArchived: false, excludeIds: [] as number[] };
    const p = await session(old), c = await session(old, p), e = await session(old);

    const first = await store.prune(options);
    assert.deepEqual(first.ids, [p, c, e].map(Number).sort((a, b) => a - b));
    assert.deepEqual(first.sessions.find(s => s.id === Number(p))?.ids, [Number(p), Number(c)]);

    // A recent subagent created after the cached read protects its parent; new activity protects a session.
    const d = await session(Date.now(), p);
    await harness.commit(async tx => {
      await tx.appendEntry(e, { kind: "pi.user", model: [{ role: "user", content: "again", timestamp: Date.now() }] });
    }, BACKGROUND_CONTEXT);
    const second = await store.prune(options);
    assert.deepEqual(second.ids, [Number(c)]);

    // An excluded session keeps its subagents.
    assert.deepEqual((await store.prune({ ...options, excludeIds: [Number(p)] })).ids, []);
    // Deletion forgets the cached links, so a deleted subagent no longer protects its parent.
    await store.delete(Number(d));
    assert.deepEqual((await store.prune(options)).ids, [p, c].map(Number).sort((a, b) => a - b));
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(dir, { recursive: true, force: true });
  }
});
