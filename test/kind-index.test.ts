import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { openConversationStorage } from "../src/conversation-storage.js";
import { kindIndexReady, KIND_INDEX } from "../src/kind-index.js";
import { readRowHead } from "../src/session-row-head.js";

test("kind index builds off-thread; row head reads work without it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-kind-"));
  try {
    const { store } = await openConversationStorage(join(dir, "luna.db"));
    // Drop the index to simulate a pre-existing db, then check the fallback path.
    await store.kindIndex;
    assert.ok(kindIndexReady(store.db));
    store.db.exec(`DROP INDEX ${KIND_INDEX}`);
    const fresh = new (store.db.constructor as any)(join(dir, "luna.db"));
    assert.equal(kindIndexReady(fresh), false);
    assert.deepEqual(readRowHead(fresh, 1).firstUser, "");
    fresh.close();
    await store.adapter.close();
    // Reopen: the worker rebuilds the missing index.
    const again = await openConversationStorage(join(dir, "luna.db"));
    await again.store.kindIndex;
    assert.ok(kindIndexReady(again.store.db));
    await again.store.adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
