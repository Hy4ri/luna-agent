import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
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
