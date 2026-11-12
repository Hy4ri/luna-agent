import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openLuna } from "../src/luna.js";
import { ScheduledMessagesService } from "../src/scheduled-messages.js";
import { LimitWaitsDoc, migrateLimitWaits } from "../src/limit-continue.js";
import { RecoveryStateDoc } from "../src/recovery-state.js";
import { readTurnFailure } from "../src/session-status.js";

test("migrateLimitWaits: valid first legacy wait migrates once at max(resumeAt, nextDeliveryAt) without doubled grace", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again in 60s." }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  const now = 1_700_000_000_000;

  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();

  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id);
    const failed = await (await conv.submit({ type: "input", content: "work" }, context)).wait(context);
    expect(failed.status).toBe("unanswered");

    const failure = await harness.commit(tx => readTurnFailure(tx, conv.id), context);
    expect(failure).toBeTruthy() /* "turn failure recorded" */;

    const resumeAt = now + 60_000;
    const nextDeliveryAt = now + 90_000;

    await harness.commit(async tx => {
      const legacy = await tx.doc(LimitWaitsDoc);
      legacy.waits[String(sid)] = {
        boundary: failure!.boundary,
        resumeAt,
        nextDeliveryAt,
        attempt: 1,
        exact: true,
        generation: failure!.generation,
        provider: failure!.provider ?? ref.provider,
        model: failure!.model ?? ref.modelId,
        resetSource: "provider_evidence",
        deadline: now + 3600_000,
      };
      legacy.chains = {
        [String(sid)]: {
          boundary: failure!.boundary,
          generation: failure!.generation,
          provider: failure!.provider ?? ref.provider,
          model: failure!.model ?? ref.modelId,
          requestId: `limit-continue-${sid}-${failure!.boundary}-${failure!.generation}`,
          attemptsAdmitted: 0,
        },
      };
    }, context);

    const policy = { enabled: true, maxWaitHours: 24, resetGraceSeconds: 60 };
    await migrateLimitWaits(harness, scheduledMessages, policy, ref, now);

    // Verify scheduled message created with exact dueAt = max(resumeAt, nextDeliveryAt)
    const list = await harness.commit(tx => scheduledMessages.list(tx, sid), context);
    const migrated = list.find(s => s.source.kind === "limit_recovery");
    expect(migrated).toBeTruthy() /* "migrated schedule created" */;
    expect(migrated!.dueAt).toBe(nextDeliveryAt) /* "dueAt must be max(resumeAt, nextDeliveryAt) with no added grace" */;
    expect(migrated!.content).toBe("Continue");
    expect(migrated!.status).toBe("scheduled");
    expect(migrated!.source.kind).toBe("limit_recovery");

    // Verify recovery state recorded
    const state = await harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(RecoveryStateDoc))), context);
    expect(state.legacyMigrated).toBe(true);
    const attempt = state.attempts[`${sid}:${failure!.boundary}`];
    expect(attempt).toBeTruthy();
    expect(attempt.status).toBe("scheduled");

    // Verify legacy store emptied
    const legacyAfter = await harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(LimitWaitsDoc))), context);
    expect(legacyAfter.waits).toEqual({});
    expect(legacyAfter.chains).toEqual({});

    // Idempotent migration call must not create another schedule or re-process
    await migrateLimitWaits(harness, scheduledMessages, policy, ref, now);
    const listAfter = await harness.commit(tx => scheduledMessages.list(tx, sid), context);
    expect(listAfter.filter(s => s.source.kind === "limit_recovery").length).toBe(1);
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
  }
});

test("migrateLimitWaits: already admitted, cancelled, stale, or attempt>1 legacy waits ledger durable stopped/consumed and never schedule", async () => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again in 60s." }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again in 60s." }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again in 60s." }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached. Try again in 60s." }),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const model = faux.getModel();
  const ref = { provider: model.provider, modelId: model.id };
  const now = 1_700_000_000_000;

  const scheduledMessages = new ScheduledMessagesService({ harness, log: () => {}, now: () => now });
  await scheduledMessages.start();

  try {
    // Conv 1: already admitted in chain (attemptsAdmitted: 1)
    const c1 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid1 = Number(c1.id);
    await (await c1.submit({ type: "input", content: "work 1" }, context)).wait(context);
    const f1 = (await harness.commit(tx => readTurnFailure(tx, c1.id), context))!;

    // Conv 2: cancelled chain
    const c2 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid2 = Number(c2.id);
    await (await c2.submit({ type: "input", content: "work 2" }, context)).wait(context);
    const f2 = (await harness.commit(tx => readTurnFailure(tx, c2.id), context))!;

    // Conv 3: attempt > 1
    const c3 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid3 = Number(c3.id);
    await (await c3.submit({ type: "input", content: "work 3" }, context)).wait(context);
    const f3 = (await harness.commit(tx => readTurnFailure(tx, c3.id), context))!;

    // Conv 4: stale deadline passed (now > deadline)
    const c4 = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid4 = Number(c4.id);
    await (await c4.submit({ type: "input", content: "work 4" }, context)).wait(context);
    const f4 = (await harness.commit(tx => readTurnFailure(tx, c4.id), context))!;

    await harness.commit(async tx => {
      const legacy = await tx.doc(LimitWaitsDoc);
      // Case 1: admitted
      legacy.waits[String(sid1)] = { boundary: f1.boundary, resumeAt: now + 10_000, attempt: 1, exact: true, generation: f1.generation, provider: ref.provider, model: ref.modelId };
      legacy.chains = {
        [String(sid1)]: { boundary: f1.boundary, generation: f1.generation, provider: ref.provider, model: ref.modelId, requestId: `r1`, attemptsAdmitted: 1 },
        // Case 2: cancelled
        [String(sid2)]: { boundary: f2.boundary, generation: f2.generation, provider: ref.provider, model: ref.modelId, requestId: `r2`, attemptsAdmitted: 0, cancelled: true },
        // Case 3: attempt 2
        [String(sid3)]: { boundary: f3.boundary, generation: f3.generation, provider: ref.provider, model: ref.modelId, requestId: `r3`, attemptsAdmitted: 0 },
        // Case 4: stale deadline
        [String(sid4)]: { boundary: f4.boundary, generation: f4.generation, provider: ref.provider, model: ref.modelId, requestId: `r4`, attemptsAdmitted: 0 },
      };
      legacy.waits[String(sid2)] = { boundary: f2.boundary, resumeAt: now + 10_000, attempt: 1, exact: true, generation: f2.generation, provider: ref.provider, model: ref.modelId };
      legacy.waits[String(sid3)] = { boundary: f3.boundary, resumeAt: now + 10_000, attempt: 2, exact: true, generation: f3.generation, provider: ref.provider, model: ref.modelId };
      legacy.waits[String(sid4)] = { boundary: f4.boundary, resumeAt: now + 10_000, attempt: 1, exact: true, generation: f4.generation, provider: ref.provider, model: ref.modelId, deadline: now - 5000 };
    }, context);

    const policy = { enabled: true, maxWaitHours: 24 };
    await migrateLimitWaits(harness, scheduledMessages, policy, ref, now);

    // No scheduled messages created for any of sid1..sid4
    for (const sid of [sid1, sid2, sid3, sid4]) {
      const list = await harness.commit(tx => scheduledMessages.list(tx, sid), context);
      expect(list.filter(s => s.source.kind === "limit_recovery").length).toBe(0) /* `session ${sid} must have no scheduled recovery` */;
    }

    // Ledger checks
    const state = await harness.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(RecoveryStateDoc))), context);
    expect(state.attempts[`${sid1}:${f1.boundary}`]?.status).toBe("consumed") /* "already admitted attempt ledgered as consumed" */;
    expect(state.attempts[`${sid2}:${f2.boundary}`]?.status).toBe("stopped") /* "cancelled must be stopped" */;
    expect(state.attempts[`${sid3}:${f3.boundary}`]?.status).toBe("stopped") /* "attempt > 1 must be stopped" */;
    expect(state.attempts[`${sid4}:${f4.boundary}`]?.status).toBe("stopped") /* "stale must be stopped" */;
  } finally {
    await scheduledMessages.close();
    await harness.close(context);
  }
});
