import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { createApp } from "../src/server.js";
import { ScheduledMessagesDoc, ScheduledMessagesService } from "../src/scheduled-messages.js";
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
    expect(badEmpty.status).toBe(400);

    const badPast = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", dueAt: now - 1000, requestId: "req-past" }),
    });
    expect(badPast.status).toBe(400);

    const badSlash = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/schedule test", dueAt: now + 60_000, requestId: "req-slash" }),
    });
    expect(badSlash.status).toBe(400);

    const badTimestampRange = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello", dueAt: 9e15, requestId: "req-range" }),
    });
    expect(badTimestampRange.status).toBe(400);

    const first = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "check status", dueAt: now + 60_000, requestId: "req-1" }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { schedule: { id: string; content: string; status: string } };
    expect(firstBody.schedule.content).toBe("check status");
    expect(firstBody.schedule.status).toBe("scheduled");

    const replay = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "check status", dueAt: now + 60_000, requestId: "req-1" }),
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as { schedule: { id: string } };
    expect(replayBody.schedule.id).toBe(firstBody.schedule.id);

    const conflict = await app.request(`/v1/sessions/${sid}/scheduled-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "different", dueAt: now + 60_000, requestId: "req-1" }),
    });
    expect(conflict.status).toBe(409);
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("scheduled message edits are atomic, session-owned, and frozen after admission", async () => {
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel(), now = 1_700_000_000_000;
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  const app = createApp({ harness, models, scheduledMessages });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
    const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const original = { content: "original", dueAt: now + 60_000, requestId: "edit-create" };
    const created = await app.request(`/v1/sessions/${conv.id}/scheduled-messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(original) });
    const { schedule } = await created.json() as { schedule: { id: string } };
    const patch = (body: unknown, sid = conv.id) => app.request(`/v1/sessions/${sid}/scheduled-messages/${schedule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const updated = { content: "edited", dueAt: now + 120_000 };
    expect((await patch(updated, other.id)).status).toBe(404);
    expect((await patch({ ...updated, dueAt: now - 1 })).status).toBe(400);
    expect((await patch({ ...updated, content: "/stop" })).status).toBe(400);
    expect((await patch({ ...updated, attachments: [] })).status).toBe(400);
    expect((await patch(updated)).status).toBe(200);
    expect((await patch(updated)).status).toBe(200);
    const listed = await app.request(`/v1/sessions/${conv.id}/scheduled-messages`);
    const { schedules } = await listed.json() as { schedules: { id: string; content: string; dueAt: number }[] };
    expect(schedules.length).toBe(1);
    expect(schedules[0]!.id).toBe(schedule.id);
    expect(schedules[0]!.content).toBe("edited");
    expect(schedules[0]!.dueAt).toBe(now + 120_000);
    const replay = await app.request(`/v1/sessions/${conv.id}/scheduled-messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(original) });
    expect(replay.status).toBe(200); // Creation receipt survives editing; never duplicate delivery.
    await harness.commit(async tx => { (await tx.doc(ScheduledMessagesDoc)).schedules[schedule.id]!.status = "queued"; }, context);
    expect((await patch({ ...updated, content: "too late" })).status).toBe(409);
    expect((await patch(updated)).status).toBe(200); // Safe replay of an already applied edit.
    await harness.commit(async tx => {
      const rec = (await tx.doc(ScheduledMessagesDoc)).schedules[schedule.id]!;
      rec.status = "scheduled";
      rec.source = { kind: "limit_recovery", boundary: 0, generation: 0, provider: "test", model: "test", exact: false };
    }, context);
    expect((await patch({ ...updated, content: "manual override" })).status).toBe(409);
  } finally { await scheduledMessages.close(); await harness.close(context); }
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
    expect(conv).toBeTruthy();
    await until(async () => {
      const entries = await conv.entries({}, 20, undefined, context);
      const inputs = entries.items.filter(e => e.kind === "luna.scheduled-message");
      return inputs.length === 2 ? inputs : undefined;
    }, "both scheduled messages delivered");

    const entries = await conv.entries({}, 20, undefined, context);
    const inputs = entries.items.filter(e => e.kind === "luna.scheduled-message").reverse();
    expect(inputs.length).toBe(2);
    expect(inputs.map(e => (e.model?.[0] as { content?: string })?.content)).toEqual(["first", "second"]);
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
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { schedules: { id: string }[] };
    expect(listBody.schedules.length).toBe(2);

    // New input cancels limit_recovery but preserves user schedule
    const msgRes = await app.request(`/v1/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(msgRes.status).toBe(200);

    const afterMsg = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
    expect(afterMsg.find((s) => s.id === recSched.id)?.status).toBe("cancelled");
    expect(afterMsg.find((s) => s.id === userSched.id)?.status).toBe("scheduled");

    // /schedule cancel <id>
    const cancelRes = await app.request(`/v1/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `/schedule cancel ${userSched.id}` }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as { status: string };
    expect(cancelBody.status).toBe("cancelled");

    // Idempotent DELETE
    const delRes = await app.request(`/v1/sessions/${sid}/scheduled-messages/${userSched.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { status: string }).status).toBe("already_cancelled");
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
    expect(failed.status).toBe("unanswered");

    const sched = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "limit recovery schedule");

    expect(sched.content).toBe("Continue");
    expect(sched.dueAt).toBe(now + 90_000);
    expect(sched.status).toBe("scheduled");
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
    expect(failed.status).toBe("unanswered");

    const sched = await until(async () => {
      const list = await h1.commit((tx) => s1.list(tx, convId), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "initial recovery schedule");
    expect(sched.status).toBe("scheduled");
    expect(parseCount).toBe(1) /* "parser called exactly once" */;
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
    expect(consumedAttempt).toBeTruthy() /* "recursive failure attempt recorded as consumed" */;

    // Verify NO second limit_recovery schedule or parse occurred
    const list = await h2.commit((tx) => s2.list(tx, convId), context);
    const recoveries = list.filter((s) => s.source.kind === "limit_recovery");
    expect(recoveries.length).toBe(1) /* "no second recovery schedule created (one-shot recursive prevention)" */;
    expect(r2ParseCount).toBe(0) /* "no second parser call on recursive failure" */;
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
    expect(failed.status).toBe("unanswered");

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
    expect(stopRes.status).toBe(200);

    // Now complete the delayed parser resolution
    finishParse!({ resetAt: now + 30_000, exact: true });

    // Allow finish() to execute
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Verify recovery was fenced and did NOT schedule
    const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
    expect(list.filter((s) => s.source.kind === "limit_recovery").length).toBe(0) /* "no schedule created after Stop" */;
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
    expect(failed.status).toBe("unanswered");

    const sched = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "scheduled recovery");

    // Lower bound preserved: evidence is now + 30s, grace is 60s -> dueAt >= now + 90s
    expect(sched.dueAt >= now + 90_000).toBeTruthy() /* `dueAt ${sched.dueAt} should be >= ${now + 90_000}` */;
    expect(sched.source.kind).toBe("limit_recovery");
    expect(sched.source.exact).toBe(false) /* "exact must be false because requests window has resetAt null" */;
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
    expect(queued.status).toBe("queued");

    // Cancel the queued schedule directly
    const cancelRes = await scheduledMessages.cancel(sid, schedule.id, "cancelled by user");
    expect(cancelRes.status).toBe("cancelled");

    // Release the active turn stream latch
    release!();
    const result = await runningTurn.wait(context);
    expect(result.status).toBe("done") /* "active turn was not aborted and completed successfully" */;
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
    expect(res1.status).toBe(201);
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
    expect(res2.status).toBe(200) /* "must return 200 replay for duplicate after due" */;
    const b2 = await res2.json() as { schedule: { id: string; status: string } };
    expect(b2.schedule.id).toBe(b1.schedule.id) /* "must return existing schedule ID" */;

    const list = await harness.commit((tx) => scheduledMessages.list(tx, sid), context);
    expect(list.length).toBe(1) /* "exactly one schedule entry exists" */;
    expect(list[0]!.status).toBe("delivered");
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
    expect(f1.status).toBe("unanswered");

    const sched1 = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid1), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "conv1 recovery scheduled");
    expect(sched1.dueAt).toBe(now + 30_000 + 60_000);

    // Session 2 fails on same routeRef with larger limit (evidence = now + 120s)
    const conv2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: routeRef } }, context);
    const sid2 = Number(conv2.id);
    const f2 = await (await conv2.submit({ type: "input", content: "work 2" }, context)).wait(context);
    expect(f2.status).toBe("unanswered");

    const sched2 = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid2), context);
      return list.find((s) => s.source.kind === "limit_recovery");
    }, "conv2 recovery scheduled");
    expect(sched2.dueAt).toBe(now + 120_000 + 60_000);

    // Schedule changed reconciliation runs in scheduledMessages service:
    // Session 1's pending automatic dueAt must be postponed to shared floor (now + 120s) + 60s margin
    const sched1Updated = await until(async () => {
      const list = await harness.commit((tx) => scheduledMessages.list(tx, sid1), context);
      const s = list.find((item) => item.id === sched1.id);
      return s && s.dueAt >= now + 120_000 + 60_000 ? s : undefined;
    }, "conv1 dueAt postponed to shared floor");

    expect(sched1Updated.dueAt).toBe(now + 120_000 + 60_000);
    expect(sched1Updated.source.kind === "limit_recovery").toBeTruthy();
    expect(sched1Updated.source.resetSource).toBe("shared_provider_evidence");
    expect(sched1Updated.source.exact).toBe(false);
  } finally {
    await recovery.close();
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("recovery startup does not wait for a parser or revive unclaimed historical failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-rec-boot-"));
  const dbPath = join(dir, "luna.db");
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Resets at 3pm." })]);
  const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
  const h1 = await openLuna({ dbPath, models, memory: false, coding: false });
  let sid: number, claimedId: number;
  try {
    const conv = await h1.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    sid = Number(conv.id);
    expect((await (await conv.submit({ type: "input", content: "old work" }, context)).wait(context)).status).toBe("unanswered");
    // Persist the crash window after claim admission but before any parse result.
    faux.appendResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." })]);
    const claimed = await h1.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    claimedId = Number(claimed.id);
    await (await claimed.submit({ type: "input", content: "claimed work" }, context)).wait(context);
    const { RecoveryStateDoc, recoveryKey } = await import("../src/recovery-state.js");
    const { readTurnFailure } = await import("../src/session-status.js");
    await h1.commit(async tx => {
      const failure = await readTurnFailure(tx, claimed.id);
      expect(failure).toBeTruthy();
      (await tx.doc(RecoveryStateDoc)).attempts[recoveryKey(claimedId, failure.boundary)] = {
        conversationId: claimedId, boundary: failure.boundary, generation: failure.generation,
        provider: ref.provider, model: ref.modelId, status: "parsing", evidenceAt: Date.now() + 120_000, exact: true,
      };
    }, context);
  } finally { await h1.close(context); }
  const harness = await openLuna({ dbPath, models, memory: false, coding: false });
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {} });
  await scheduledMessages.start();
  let parserCalls = 0;
  let parserEntered!: () => void;
  const parsing = new Promise<"parser">(resolve => { parserEntered = () => resolve("parser"); });
  const recovery = new LimitRecoveryService({ harness, scheduledMessages, log: () => {},
    policy: () => ({ enabled: true, maxWaitHours: 168 }), defaultModel: () => ref,
    parseResetTime: async ({ signal }) => {
      parserCalls++;
      parserEntered();
      // A slow provider must not become part of the boot critical path.
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { resetAt: Date.now() + 3_600_000 };
    },
  });
  const starting = recovery.start();
  try {
    const first = await Promise.race([starting.then(() => "started"), parsing]);
    expect(first).toBe("started") /* "startup must not await a parser for a stored failure" */;
    expect(parserCalls).toBe(0) /* "boot must not reinterpret even a recent unclaimed historical error" */;
    expect(await harness.commit(tx => scheduledMessages.list(tx, sid), context)).toEqual([]);
    const restored = await harness.commit(tx => scheduledMessages.list(tx, claimedId), context);
    expect(restored.length).toBe(1) /* "a persisted interrupted claim still restores using captured evidence" */;
    expect(restored[0]).toBeTruthy();
    expect(restored[0].status).toBe("scheduled");
    expect(restored[0].content).toBe("Continue");
  } finally {
    await recovery.close(); await starting;
    await scheduledMessages.close(); await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live recovery rejects stale evidence and schedules fresh exact evidence without parsing", async () => {
  const { RecoveryStateDoc } = await import("../src/recovery-state.js");
  const now = Date.now(), faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const evidence: [number, number][] = [
    [now - 25 * 3_600_000, now + 60_000],
    [now, now - 60_000],
    [now, now + 60_000],
  ];
  faux.setResponses(evidence.map(([receivedAt, resetAt]) => ({
    ...fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." }),
    diagnostics: [{ type: "luna.usage-limit", timestamp: receivedAt, details: { kind: "wait", receivedAt, windows: [{ id: "tokens", resetAt }] } }],
  })));
  const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();
  let parserCalls = 0;
  const recovery = new LimitRecoveryService({ harness, scheduledMessages, log: () => {}, now: () => now,
    policy: () => ({ enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 }), defaultModel: () => ref,
    parseResetTime: async () => { parserCalls++; return { resetAt: now + 60_000 }; },
  });
  await recovery.start();
  try {
    for (let i = 0; i < 3; i++) {
      const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
      expect((await (await conv.submit({ type: "input", content: `work ${i}` }, context)).wait(context)).status).toBe("unanswered");
      const attempt = await until(async () => harness.commit(async tx => {
        const attempts = Object.values((await tx.doc(RecoveryStateDoc)).attempts);
        const value = attempts.find(a => a.conversationId === Number(conv.id) && a.status !== "parsing");
        return value ? JSON.parse(JSON.stringify(value)) as typeof value : undefined;
      }, context), "terminal recovery eligibility");
      expect(attempt.status).toBe(i < 2 ? "stopped" : "scheduled");
      expect(parserCalls).toBe(0);
      if (i === 0) expect(attempt.reason!).toMatch(/older than maxWaitHours/);
      if (i === 1) expect(attempt.reason!).toMatch(/reset.*passed/i);
    }
  } finally { await recovery.close(); await scheduledMessages.close(); await harness.close(context); }
});
