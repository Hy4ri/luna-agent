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

    const badSlash = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/schedule test", dueAt: now + 60_000, requestId: "req-slash" }),
    });
    assert.equal(badSlash.status, 400);

    const badTimestampRange = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", dueAt: 9e15, requestId: "req-range" }),
    });
    assert.equal(badTimestampRange.status, 400);

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
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => ref,
    parseResetTime: async () => ({ resetAt: now + 30_000, exact: true }),
    now: () => now,
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

test("limit recovery parser called once and failing Continue does not trigger second parse or schedule across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-rec-restart-"));
  const dbPath = join(dir, "luna.db");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again in 30s." }),
    // Second response when Continue runs: also limit fails!
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached again." }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  let now = Date.now();
  let convId: number;
  let parseCount = 0;

  const h1 = await openLuna({ dbPath, models, memory: false, coding: false });
  const s1 = new ScheduledMessagesService({ harness: h1, log: () => {}, now: () => now });
  await s1.start();
  const r1 = new LimitRecoveryService({
    harness: h1,
    scheduledMessages: s1,
    log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => ref,
    parseResetTime: async () => {
      parseCount++;
      return { resetAt: now + 30_000, exact: true };
    },
    now: () => now,
  });
  await r1.start();

  try {
    const conv = await h1.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    convId = Number(conv.id);
    const failed = await (await conv.submit({ type: "input", content: "first work" }, context)).wait(context);
    assert.equal(failed.status, "unanswered");

    const sched = await until(async () => {
      const list = await h1.commit((tx) => s1.list(tx, convId), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "initial recovery schedule");
    assert.equal(sched.status, "scheduled");
    assert.equal(parseCount, 1, "parser called exactly once");
  } finally {
    await r1.close();
    await s1.close();
    await h1.close(context);
  }

  // Daemon restarts, time advances to dueAt + 10s
  now += 100_000;
  const h2 = await openLuna({ dbPath, models, memory: false, coding: false });
  const s2 = new ScheduledMessagesService({ harness: h2, log: () => {}, now: () => now });
  await s2.start();
  let r2ParseCount = 0;
  const r2 = new LimitRecoveryService({
    harness: h2,
    scheduledMessages: s2,
    log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => ref,
    parseResetTime: async () => {
      r2ParseCount++;
      return { resetAt: now + 30_000, exact: true };
    },
    now: () => now,
  });
  await r2.start();

  try {
    // Overdue Continue fires, runs, and fails with second 429
    await until(async () => {
      const list = await h2.commit((tx) => s2.list(tx, convId), context);
      const first = list.find((s) => s.source.kind === "limit_recovery");
      return first?.status === "delivered" ? first : undefined;
    }, "first recovery delivered");

    // Await actual failed Continue terminal turn failure and durable ledger consumed state
    const { RecoveryStateDoc } = await import("../src/recovery-state.js");
    const state = await until(async () => {
      const s = await h2.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(RecoveryStateDoc))), context);
      const consumed = Object.values(s.attempts).find((a: any) => a.conversationId === convId && a.status === "consumed");
      return consumed ? s : undefined;
    }, "second failure ledgered as consumed");

    // Verify durable ledger consumed
    const consumedAttempt = Object.values(state.attempts).find((a: any) => a.conversationId === convId && a.status === "consumed");
    assert.ok(consumedAttempt, "recursive failure attempt recorded as consumed");

    // Verify NO second limit_recovery schedule or parse occurred
    const list = await h2.commit((tx) => s2.list(tx, convId), context);
    const recoveries = list.filter((s) => s.source.kind === "limit_recovery");
    assert.equal(recoveries.length, 1, "no second recovery schedule created (one-shot recursive prevention)");
    assert.equal(r2ParseCount, 0, "no second parser call on recursive failure");
  } finally {
    await r2.close();
    await s2.close();
    await h2.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("late parser result is fenced by Stop (real HTTP POST slash command /stop)", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again later." }),
    fauxAssistantMessage([fauxText("ok")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  let now = Date.now();
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();

  let finishParse: ((val: { resetAt: number; exact: boolean }) => void) | undefined;
  const parsePromise = new Promise<{ resetAt: number; exact: boolean }>((resolve) => {
    finishParse = resolve;
  });

  const recovery = new LimitRecoveryService({
    harness,
    scheduledMessages,
    log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => ref,
    parseResetTime: async () => parsePromise,
    now: () => now,
  });
  await recovery.start();
  const app = createApp({ harness, models, scheduledMessages, agent: { model: ref } });

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);
    const failed = await (await conv.submit({ type: "input", content: "do work" }, context)).wait(context);
    assert.equal(failed.status, "unanswered");

    // Wait until recovery claim is in parsing state
    await until(async () => {
      const state = await harness.commit(async (tx) => {
        const { RecoveryStateDoc } = await import("../src/recovery-state.js");
        return JSON.parse(JSON.stringify(await tx.doc(RecoveryStateDoc))) as { attempts: Record<string, { conversationId: number; status: string }> };
      }, context);
      const attempt = Object.values(state.attempts).find((a) => a.conversationId === sid);
      return attempt?.status === "parsing" ? attempt : undefined;
    }, "parsing state entered");

    // Invoke Stop via slash command in POST /v1/sessions/:id/messages
    const stopRes = await app.request(`/v1/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/stop" }),
    });
    assert.equal(stopRes.status, 200);

    // Now complete the delayed parser resolution
    finishParse!({ resetAt: now + 30_000, exact: true });

    // Allow finish() to execute
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Verify recovery was fenced and did NOT schedule
    const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
    assert.equal(list.filter((s) => s.source.kind === "limit_recovery").length, 0, "no schedule created after Stop");
  } finally {
    await recovery.close();
    await scheduledMessages.close();
    await harness.close(context);
  }
}, 15_000);

test("deterministic reset evidence lower bound and unknown structured window produce exact: false", async () => {
  const faux = fauxProvider();
  let now = Date.now();
  faux.setResponses([
    {
      ...fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." }),
      diagnostics: [{
        type: "luna.usage-limit",
        timestamp: now,
        details: {
          kind: "wait",
          windows: [
            { id: "tokens", resetAt: now + 30_000 },
            { id: "requests", resetAt: null }, // unknown structured window produces exact: false
          ],
        },
      }],
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();

  // Parser returns a resetAt that is EARLIER than evidence (now + 10s < now + 30s)
  const recovery = new LimitRecoveryService({
    harness,
    scheduledMessages,
    log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => ref,
    parseResetTime: async () => ({ resetAt: now + 10_000, exact: true }),
    now: () => now,
  });
  await recovery.start();

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);
    const failed = await (await conv.submit({ type: "input", content: "work" }, context)).wait(context);
    assert.equal(failed.status, "unanswered");

    const sched = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "scheduled recovery");

    // Lower bound preserved: evidence is now + 30s, grace is 60s -> dueAt >= now + 90s
    assert.ok(sched.dueAt >= now + 90_000, `dueAt ${sched.dueAt} should be >= ${now + 90_000}`);
    assert.equal(sched.source.kind, "limit_recovery");
    assert.equal(sched.source.exact, false, "exact must be false because requests window has resetAt null");
  } finally {
    await recovery.close();
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("cancellation of queued scheduled input does not abort an unrelated running turn", async () => {
  const faux = fauxProvider();
  let release: (() => void) | undefined;
  const latch = new Promise<void>((r) => { release = r; });
  faux.setResponses([
    async () => {
      await latch;
      return fauxAssistantMessage([fauxText("turn 1 reply")]);
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  let now = 1_700_000_000_000;
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);

    // Start active turn that blocks in faux response factory until latch release
    const runningTurn = await conv.submit({ type: "input", content: "active turn" }, context);

    // Wait until faux provider has actually been called and is holding the latch
    while (faux.state.callCount < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Create a scheduled message that is already due and fire scheduleChanged
    now += 10_000;
    const { schedule } = await harness.commit(
      (tx) => scheduledMessages.create(tx, { conversationId: sid, content: "queued msg", dueAt: now - 1000, allowPast: true, requestId: "q1", source: { kind: "user" } }),
      context,
    );
    await scheduledMessages.scheduleChanged();

    // Wait until scheduled message is admitted and queued behind active turn
    const queued = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
      const s = list.find((item) => item.id === schedule.id);
      return s?.status === "queued" ? s : undefined;
    }, "schedule status queued");
    assert.equal(queued.status, "queued");

    // Cancel the queued schedule directly
    const cancelRes = await scheduledMessages.cancel(sid, schedule.id, "cancelled by user");
    assert.equal(cancelRes.status, "cancelled");

    // Release the active turn stream latch
    release!();
    const result = await runningTurn.wait(context);
    assert.equal(result.status, "done", "active turn was not aborted and completed successfully");
  } finally {
    release?.();
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("lost post / deduplication after due stable request id", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxText("reply 1")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  let now = 1_700_000_000_000;
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();
  const app = createApp({ harness, models, scheduledMessages, agent: { model: ref } });

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);
    const originalDueAt = now + 5000;

    // First creation via HTTP API
    const res1 = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "stable msg", dueAt: originalDueAt, requestId: "stable-req-1" }),
    });
    assert.equal(res1.status, 201);
    const b1 = await res1.json() as { schedule: { id: string } };

    // Advance time past dueAt and deliver it
    now += 10_000;
    await scheduledMessages.scheduleChanged();

    await until(async () => {
      const rec = (await harness.commit((tx) => scheduledMessages.list(tx, sid), context)).find((s) => s.id === b1.schedule.id);
      return rec?.status === "delivered" ? rec : undefined;
    }, "delivered exactly once");

    // Lost-post retry: duplicate POST arrives AFTER delivery with identical requestId, content, and original dueAt
    const res2 = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "stable msg", dueAt: originalDueAt, requestId: "stable-req-1" }),
    });
    assert.equal(res2.status, 200, "must return 200 replay for duplicate after due");
    const b2 = await res2.json() as { schedule: { id: string; status: string } };
    assert.equal(b2.schedule.id, b1.schedule.id, "must return existing schedule ID");

    const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
    assert.equal(list.length, 1, "exactly one schedule entry exists");
    assert.equal(list[0]!.status, "delivered");
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("shared provider evidence floor postpones same-route schedule without serial recovery loops", async () => {
  const now = Date.now();
  const faux = fauxProvider();
  faux.setResponses([
    // Conv 1 fails with 30s limit
    {
      ...fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." }),
      diagnostics: [{
        type: "luna.usage-limit",
        timestamp: now,
        details: {
          kind: "wait",
          receivedAt: now,
          windows: [{ id: "req", resetAt: now + 30_000 }],
        },
      }],
    },
    // Conv 2 fails with 120s limit on same route
    {
      ...fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." }),
      diagnostics: [{
        type: "luna.usage-limit",
        timestamp: now,
        details: {
          kind: "wait",
          receivedAt: now,
          windows: [{ id: "req", resetAt: now + 120_000 }],
        },
      }],
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const routeRef = { provider: model.provider, modelId: model.id };

  const scheduledMessages = new ScheduledMessagesService({
    harness,
    log: () => {},
    now: () => now,
    recoveryPolicy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => routeRef,
  });
  await scheduledMessages.start();

  const recovery = new LimitRecoveryService({
    harness,
    scheduledMessages,
    log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }),
    defaultModel: () => routeRef,
    now: () => now,
  });
  await recovery.start();

  try {
    // Session 1 fails on routeRef (evidence = now + 30s)
    const conv1 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: routeRef } }, context);
    const sid1 = Number(conv1.id);
    const f1 = await (await conv1.submit({ type: "input", content: "work 1" }, context)).wait(context);
    assert.equal(f1.status, "unanswered");

    const sched1 = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid1), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "conv1 recovery scheduled");
    assert.equal(sched1.dueAt, now + 30_000 + 60_000);

    // Session 2 fails on same routeRef with larger limit (evidence = now + 120s)
    const conv2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: routeRef } }, context);
    const sid2 = Number(conv2.id);
    const f2 = await (await conv2.submit({ type: "input", content: "work 2" }, context)).wait(context);
    assert.equal(f2.status, "unanswered");

    const sched2 = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid2), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "conv2 recovery scheduled");
    assert.equal(sched2.dueAt, now + 120_000 + 60_000);

    // Schedule changed reconciliation runs in scheduledMessages service:
    // Session 1's pending automatic dueAt must be postponed to shared floor (now + 120s) + 60s margin
    const sched1Updated = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid1), context);
      const s = list.find((item) => item.id === sched1.id);
      return s && s.dueAt >= now + 120_000 + 60_000 ? s : undefined;
    }, "conv1 dueAt postponed to shared floor");

    assert.equal(sched1Updated.dueAt, now + 120_000 + 60_000);
    assert.ok(sched1Updated.source.kind === "limit_recovery");
    assert.equal(sched1Updated.source.resetSource, "shared_provider_evidence");
    assert.equal(sched1Updated.source.exact, false);
  } finally {
    await recovery.close();
    await scheduledMessages.close();
    await harness.close(context);
  }
});
