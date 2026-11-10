import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { AnalyticsService } from "../src/analytics/index.js";
import { conversationStorage } from "../src/conversation-storage.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-service-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const analytics = new AnalyticsService(harness, conversations);
  return { dir, harness, conversations, analytics, async close() { analytics.close(); await harness.close(context); await rm(dir, { recursive: true, force: true }); } };
}

test("analytics flushes the dirty tail under deletion's maintenance barrier and retains it across restart", async () => {
  const f = await fixture();
  try {
    const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await f.conversations.update(Number(conv.id), { title: "Saved title" });
    await f.harness.commit(tx => tx.appendEntry(conv.id, { kind: "pi.user", model: [{ role: "user", content: "not retained", timestamp: 1000 }] }), context);
    await f.analytics.refresh();
    assert.equal(f.analytics.store.getSession(Number(conv.id))?.userTurns, 1);
    await f.harness.commit(tx => tx.appendEntry(conv.id, { kind: "pi.user", model: [{ role: "user", content: "dirty latest", timestamp: 2000 }] }), context);
    await f.conversations.delete(Number(conv.id));
    const saved = f.analytics.store.getSession(Number(conv.id));
    assert.ok(saved?.deletedAt);
    assert.equal(saved.title, "Saved title");
    assert.equal(saved.userTurns, 2);
    assert.equal(saved.lastActivity, 2000);
    assert.equal(conversationStorage(f.harness).db.query("SELECT 1 FROM conversations WHERE id=?").get(Number(conv.id)), null);
    f.analytics.close();
    const restarted = new AnalyticsService(f.harness, f.conversations);
    try { await restarted.ready(); assert.equal(restarted.store.getSession(Number(conv.id))?.userTurns, 2); }
    finally { restarted.close(); }
  } finally { await f.close(); }
});

test("analytics refuses destructive deletion when its preservation hook fails", async () => {
  const f = await fixture();
  try {
    const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const detach = f.conversations.subscribeBeforeDelete(() => { throw new Error("preservation unavailable"); });
    await assert.rejects(f.conversations.delete(Number(conv.id)), /preservation unavailable/);
    assert.ok(conversationStorage(f.harness).db.query("SELECT 1 FROM conversations WHERE id=?").get(Number(conv.id)));
    detach();
    await f.conversations.delete(Number(conv.id));
  } finally { await f.close(); }
});
