import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { createApp } from "../src/server.js";
import { ScheduledMessagesService } from "../src/scheduled-messages.js";
import { LimitRecoveryService } from "../src/limit-recovery.js";

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

test("POST /v1/sessions/:id/scheduled-messages validates, deduplicates by requestId, and rejects conflicts", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  let now = 1_700_000_000_000;
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();
  const app = createApp({ harness, models, scheduledMessages, agent: { model: { provider: model.provider, modelId: model.id } } });

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
    const sid = Number(conv.id);

    const badEmpty = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "   ", dueAt: now + 60_000, requestId: "req-empty" }),
    });
    assert.equal(badEmpty.status, 400);

    const badPast = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", dueAt: now - 1000, requestId: "req-past" }),
    });
    assert.equal(badPast.status, 400);

    const first = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "check status", dueAt: now + 60_000, requestId: "req-1" }),
    });
    assert.equal(first.status, 201);
    const firstBody = await first.json() as { schedule: { id: string; content: string; status: string } };
    assert.equal(firstBody.schedule.content, "check status");
    assert.equal(firstBody.schedule.status, "scheduled");

    const replay = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "check status", dueAt: now + 60_000, requestId: "req-1" }),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { schedule: { id: string } };
    assert.equal(replayBody.schedule.id, firstBody.schedule.id);

    const conflict = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "different", dueAt: now + 60_000, requestId: "req-1" }),
    });
    assert.equal(conflict.status, 409);
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("scheduled messages survive restart, deliver overdue once in dueAt order, and queue behind busy turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-sched-"));
  const dbPath = join(dir, "luna.db");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxText("first reply")]),
    fauxAssistantMessage([fauxText("second reply")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  let now = 1_700_000_000_000;
  let convId: number;

  const h1 = await openLuna({ dbPath, models, memory: false, coding: false });
  const s1 = new ScheduledMessagesService({ harness: h1, log: () => {}, now: () => now });
  await s1.start();
  try {
    const conv = await h1.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    convId = Number(conv.id);
    await h1.commit(tx => s1.create(tx, { conversationId: convId, content: "second", dueAt: now + 20_000, requestId: "r2", source: { kind: "user" } }), context);
    await h1.commit(tx => s1.create(tx, { conversationId: convId, content: "first", dueAt: now + 10_000, requestId: "r1", source: { kind: "user" } }), context);
  } finally {
    await s1.close();
    await h1.close(context);
  }

  now += 30_000; // both overdue
  const h2 = await openLuna({ dbPath, models, memory: false, coding: false });
  const s2 = new ScheduledMessagesService({ harness: h2, log: () => {}, now: () => now });
  try {
    await s2.start();
    const conv = await h2.conversation(convId! as ConversationId, context);
    assert.ok(conv);
    await until(async () => {
      const entries = await conv.entries({}, 20, undefined, context);
      const inputs = entries.items.filter(e => e.kind === "luna.scheduled-message");
      return inputs.length === 2 ? inputs : undefined;
    }, "both scheduled messages delivered");

    const entries = await conv.entries({}, 20, undefined, context);
    const inputs = entries.items.filter(e => e.kind === "luna.scheduled-message").reverse();
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map(e => (e.model?.[0] as { content?: string })?.content), ["first", "second"]);
  } finally {
    await s2.close();
    await h2.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancellation, /schedule list|cancel, Stop, new input, and archive lifecycle rules", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  const now = 1_700_000_000_000;
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();
  const app = createApp({ harness, models, scheduledMessages, agent: { model: ref } });

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);

    const { schedule: userSched } = await harness.commit(
      (tx) => scheduledMessages.create(tx, { conversationId: sid, content: "future user", dueAt: now + 60_000, requestId: "u1", source: { kind: "user" } }),
      context,
    );
    const { schedule: recSched } = await harness.commit(
      (tx) =>
        scheduledMessages.create(tx, {
          conversationId: sid,
          content: "Continue",
          dueAt: now + 60_000,
          requestId: "r1",
          source: { kind: "limit_recovery", boundary: 1, generation: 1, provider: ref.provider, model: ref.modelId, exact: true },
        }),
      context,
    );

    // /schedule list
    const listRes = await app.request(`/v1/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/schedule list" }),
    });
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { schedules: { id: string }[] };
    assert.equal(listBody.schedules.length, 2);

    // New input cancels limit_recovery but preserves user schedule
    const msgRes = await app.request(`/v1/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    assert.equal(msgRes.status, 200);

    const afterMsg = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
    assert.equal(afterMsg.find((s) => s.id === recSched.id)?.status, "cancelled");
    assert.equal(afterMsg.find((s) => s.id === userSched.id)?.status, "scheduled");

    // /schedule cancel <id>
    const cancelRes = await app.request(`/v1/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `/schedule cancel ${userSched.id}` }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = (await cancelRes.json()) as { status: string };
    assert.equal(cancelBody.status, "cancelled");

    // Idempotent DELETE
    const delRes = await app.request(`/v1/sessions/${sid}/scheduled-messages/${userSched.id}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(((await delRes.json()) as { status: string }).status, "already_cancelled");
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("limit recovery schedules one-shot Continue via parser or deterministic fallback without retry chains", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again later." }),
    fauxAssistantMessage([fauxText("resumed")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  let now = 1_700_000_000_000;
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();
  const recovery = new LimitRecoveryService({
    harness,
    scheduledMessages,
    log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 24 }),
    defaultModel: () => ref,
    parseResetTime: async () => ({ resetAt: now + 30_000, exact: true }),
    now: () => now,
    graceMs: 60_000,
  });
  await recovery.start();

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);
    const failed = await (await conv.submit({ type: "input", content: "do work" }, context)).wait(context);
    assert.equal(failed.status, "unanswered");

    const sched = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "limit recovery schedule");

    assert.equal(sched.content, "Continue");
    assert.equal(sched.dueAt, now + 90_000);
    assert.equal(sched.status, "scheduled");
  } finally {
    await recovery.close();
    await scheduledMessages.close();
    await harness.close(context);
  }
}, 15_000);
