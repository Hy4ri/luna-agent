import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
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
    expect(f.analytics.store.getSession(Number(conv.id))?.userTurns).toBe(1);
    await f.harness.commit(tx => tx.appendEntry(conv.id, { kind: "pi.user", model: [{ role: "user", content: "dirty latest", timestamp: 2000 }] }), context);
    await f.conversations.delete(Number(conv.id));
    const saved = f.analytics.store.getSession(Number(conv.id));
    expect(saved?.deletedAt).toBeTruthy();
    expect(saved.title).toBe("Saved title");
    expect(saved.userTurns).toBe(2);
    expect(saved.lastActivity).toBe(2000);
    expect(conversationStorage(f.harness).db.query("SELECT 1 FROM conversations WHERE id=?").get(Number(conv.id))).toBe(null);
    f.analytics.close();
    const restarted = new AnalyticsService(f.harness, f.conversations);
    try { await restarted.ready(); expect(restarted.store.getSession(Number(conv.id))?.userTurns).toBe(2); }
    finally { restarted.close(); }
  } finally { await f.close(); }
});

test("analytics refuses destructive deletion when its preservation hook fails", async () => {
  const f = await fixture();
  try {
    const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const detach = f.conversations.subscribeBeforeDelete(() => { throw new Error("preservation unavailable"); });
    await expect(f.conversations.delete(Number(conv.id))).rejects.toThrow(/preservation unavailable/);
    expect(conversationStorage(f.harness).db.query("SELECT 1 FROM conversations WHERE id=?").get(Number(conv.id))).toBeTruthy();
    detach();
    await f.conversations.delete(Number(conv.id));
  } finally { await f.close(); }
});
