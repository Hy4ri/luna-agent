import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { defineDoc } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { ScheduledMessagesDoc, ScheduledMessagesService } from "../src/scheduled-messages.js";
import { RecoveryStateDoc } from "../src/recovery-state.js";
import { LimitWaitsDoc } from "../src/limit-continue.js";

const UnknownGlobalDoc = defineDoc<{ n: number }>({ checkpointWhen: () => false, kind: "test.unknown-global", version: 1, scope: "session", initial: () => ({ n: 0 }) });

// A session-scope document write used to clear every cached list row, so the next list rebuilt all sessions on
// the main thread (1.8 s warm, 9.8 s cold on 493 production sessions). Only the conversations whose row inputs
// changed may be rebuilt.
test("session-scope document writes rebuild only the list rows whose inputs changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-session-rows-"));
  const models = createModels();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => 1 });
  const built: number[] = [];
  const summary = scheduledMessages.summary.bind(scheduledMessages);
  scheduledMessages.summary = (tx, id) => { built.push(id); return summary(tx, id); };
  try {
    const create = () => harness.commit(async tx => Number((await tx.createConversation({ ownership: { kind: "ownerless" } })).id), context);
    const a = await create(), b = await create();
    const app = createApp({ harness, conversations: new ConversationStore(harness), models, scheduledMessages });
    const list = async () => {
      built.length = 0;
      const res = await app.request("/v1/sessions?limit=50");
      expect(res.status).toBe(200);
      const body = await res.json() as { sessions?: { id: number; scheduled?: { count: number } }[] } | { id: number; scheduled?: { count: number } }[];
      const sessions = Array.isArray(body) ? body : body.sessions ?? [];
      return { rebuilt: [...built].sort((x, y) => x - y), scheduled: (id: number) => sessions.find(s => Number(s.id) === id)?.scheduled?.count };
    };
    const write = (fn: (tx: any) => Promise<void>) => harness.commit(fn, context);

    expect((await list()).rebuilt).toEqual([a, b].sort((x, y) => x - y));
    // The first list creates per-conversation status documents, which invalidates those rows once.
    await list();
    expect((await list()).rebuilt).toEqual([]) /* "warm list reuses every row" */;

    await write(async tx => { (await tx.doc(LimitWaitsDoc)).routes = { r: { claimedAt: 1 } }; });
    expect((await list()).rebuilt).toEqual([]) /* "documents no row reads leave the cache valid" */;

    await write(async tx => {
      (await tx.doc(ScheduledMessagesDoc)).schedules.s1 = { id: "s1", conversationId: a, createdAt: 1, dueAt: 9e12, content: "later", status: "scheduled", source: { kind: "user" }, requestId: "r1" } as never;
    });
    const afterSchedule = await list();
    expect(afterSchedule.rebuilt).toEqual([a]) /* "a schedule for one conversation rebuilds only that row" */;
    expect(afterSchedule.scheduled(a)).toBe(1);

    await write(async tx => { (await tx.doc(RecoveryStateDoc)).attempts[`${b}:1`] = { status: "stopped", reason: "test" } as never; });
    expect((await list()).rebuilt).toEqual([b]) /* "a recovery attempt rebuilds only its conversation" */;

    await write(async tx => { delete (await tx.doc(ScheduledMessagesDoc)).schedules.s1; });
    const afterDelete = await list();
    expect(afterDelete.rebuilt).toEqual([a]) /* "removing a schedule rebuilds the row that had it" */;
    expect(afterDelete.scheduled(a)).toBe(0);

    await write(async tx => { (await tx.doc(UnknownGlobalDoc)).n = 1; });
    expect((await list()).rebuilt).toEqual([a, b].sort((x, y) => x - y)) /* "an unknown session-scope document still rebuilds every row" */;
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
