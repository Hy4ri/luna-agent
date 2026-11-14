import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { conversationStorage } from "../src/conversation-storage.js";
import { createApp } from "../src/server.js";
import { NON_USER_KINDS } from "../src/user-messages.js";

const user = (content: unknown) => ({ role: "user", content, timestamp: 1 });

// The rail index reads SQLite directly. Protect fork inheritance, order, kinds, and label rules at the HTTP route.
test("user-messages lists user turns oldest first, includes fork-parent turns up to the fork point, and uses the kind index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-user-messages-"));
  const models = createModels();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  try {
    const parent = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const append = (id: typeof parent.id, entry: Record<string, unknown>) =>
      harness.commit(tx => tx.appendEntry(id, entry as never), context);
    await append(parent.id, { kind: "pi.user", model: [user("first message")] });
    await append(parent.id, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "reply" }] }] });
    await append(parent.id, { kind: "pi.user", model: [user([{ type: "text", text: "second   message" }, { type: "image", data: "x" }, { type: "text", text: "x".repeat(100) }])] });
    await append(parent.id, { kind: "pi.user", model: [user("Background process 0a1b-2c finished: exit 0")] });
    // The transcript shows these kinds as muted rows, so the rail has nothing to jump to.
    await append(parent.id, { kind: "pi.compaction", model: [user("The conversation history before this point was compacted")] });
    await append(parent.id, { kind: "pi.reset", model: [user("context reset")] });
    await append(parent.id, { kind: "luna.model-changed", model: [user("model changed")] });
    const forkAt = (await parent.entries({ order: "descending" }, 1, undefined, context)).items[0]!.id;
    await append(parent.id, { kind: "luna.xsession.msg", model: [user("parent only")] });
    const forked = await harness.commit(tx => tx.forkConversation(parent.id, forkAt, { ownership: { kind: "ownerless" } }), context);
    await append(forked.id, { kind: "luna.scheduled-message", model: [user([{ type: "image", data: "x" }])] });

    const app = createApp({ harness, conversations: new ConversationStore(harness), models });
    const read = async (id: unknown) => {
      const res = await app.request(`/v1/sessions/${id}/user-messages`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { messages: { id: number; label: string }[] }).messages;
    };
    const second = `second message ${"x".repeat(65)}…`;
    const parentRail = await read(parent.id);
    expect(parentRail.map(m => m.label)).toEqual(["first message", second, "parent only"]);
    expect(parentRail.map(m => m.id)).toEqual([...parentRail.map(m => m.id)].sort((a, b) => a - b));
    expect((await read(forked.id)).map(m => m.label)).toEqual(["first message", second, "Message"]);
    expect((await app.request("/v1/sessions/999999/user-messages")).status).toBe(404);

    const plan = conversationStorage(harness).db.query("EXPLAIN QUERY PLAN SELECT id, json_extract(record, '$.kind') AS kind FROM entries WHERE conversation_id = ? AND json_extract(record, '$.kind') NOT IN (" + NON_USER_KINDS.map(kind => `'${kind}'`).join(", ") + ")").all(1) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("COVERING INDEX luna_entries_by_conversation_kind"))).toBeTruthy() /* JSON.stringify(plan) */;
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
