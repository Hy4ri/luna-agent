import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { openLuna } from "../src/luna.js";
import { ScheduledMessagesDoc, ScheduledMessagesService } from "../src/scheduled-messages.js";
import { LimitRecoveryService } from "../src/limit-recovery.js";
import { RecoveryStateDoc, recoveryKey, recoveryResetFloor } from "../src/recovery-state.js";
import { readTurnFailure } from "../src/session-status.js";

function provider() {
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { faux, models, ref: { provider: model.provider, modelId: model.id } };
}

test("terminal schedule migration bounds hot state and preserves history and request dedup across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-schedule-retention-")), dbPath = join(dir, "luna.db");
  const { faux, models, ref } = provider();
  faux.setResponses([fauxAssistantMessage([fauxText("OK")])]);
  let now = Date.now(), sid = 0, firstId = "", deliveredId = "";
  const dueAt = now + 60_000;
  let h = await openLuna({ dbPath, models, memory: false, coding: false });
  let s = new ScheduledMessagesService({ harness: h, now: () => now, log: () => {} });
  try {
    const conv = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    sid = Number(conv.id);
    await h.commit(async tx => {
      for (let i = 0; i < 64; i++) {
        const result = await s.create(tx, { conversationId: sid, content: `old ${i}`, dueAt, requestId: `old-${i}`, source: { kind: "user" } });
        if (!i) firstId = result.schedule.id;
        // Persisted pre-upgrade terminal records, including their original request receipts.
        (await tx.doc(ScheduledMessagesDoc)).schedules[result.schedule.id]!.status = "cancelled";
      }
      deliveredId = (await s.create(tx, { conversationId: sid, content: "Never use blue.", dueAt, requestId: "manual", source: { kind: "user" } })).schedule.id;
    }, context);
    await s.start();
    const hot = await h.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(ScheduledMessagesDoc))), context);
    assert.equal(Object.keys(hot.schedules).length, 1);
    assert.equal(Object.keys(hot.requests).length, 1);
    assert.equal((await h.commit(tx => s.list(tx, sid), context)).length, 65);
    const replay = await h.commit(tx => s.create(tx, { conversationId: sid, content: "old 0", dueAt, requestId: "old-0", source: { kind: "user" } }), context);
    assert.equal(replay.created, false); assert.equal(replay.schedule.id, firstId);
    await assert.rejects(h.commit(tx => s.create(tx, { conversationId: sid, content: "changed", dueAt, requestId: "old-0", source: { kind: "user" } }), context), /requestId already belongs/);
    assert.equal((await s.cancel(sid, firstId)).status, "already_cancelled");
    now = dueAt + 1;
    await s.deliverDue();
    assert.equal((await s.cancel(sid, deliveredId)).status, "already_delivered");
    const empty = await h.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(ScheduledMessagesDoc))), context);
    assert.equal(Object.keys(empty.schedules).length, 0);
    assert.equal(Object.keys(empty.requests).length, 0);
    await s.close(); await h.close(context);
    h = await openLuna({ dbPath, models, memory: false, coding: false });
    s = new ScheduledMessagesService({ harness: h, now: () => now, log: () => {} });
    await s.start();
    const afterRestart = await h.commit(tx => s.create(tx, { conversationId: sid, content: "Never use blue.", dueAt, requestId: "manual", source: { kind: "user" } }), context);
    assert.equal(afterRestart.created, false);
    assert.equal(afterRestart.schedule.id, deliveredId);
    assert.equal(afterRestart.schedule.status, "delivered");
    assert.equal((await h.commit(tx => s.list(tx, sid), context)).length, 65);
  } finally { await s.close(); await h.close(context); rmSync(dir, { recursive: true, force: true }); }
});

test("fireOne and reconciliation classify an unplaced run_failed receipt identically", async () => {
  const { models, ref } = provider();
  const h = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  let now = Date.now();
  const s = new ScheduledMessagesService({ harness: h, now: () => now, log: () => {} });
  try {
    const conv = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    const sid = Number(conv.id), ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      await h.commit(async tx => {
        const { schedule } = await s.create(tx, { conversationId: sid, content: `work ${i}`, dueAt: now + 1000, requestId: `failed-${i}`, source: { kind: "user" } });
        ids.push(schedule.id);
      }, context);
      await h.commit(async tx => {
        const rec = (await tx.doc(ScheduledMessagesDoc)).schedules[ids[i]!]!;
        await tx.createSubmission({ conversationId: conv.id, requestId: rec.requestId, type: "input", status: "unanswered", reason: "run_failed" });
      }, context);
    }
    await h.commit(async tx => { (await tx.doc(ScheduledMessagesDoc)).schedules[ids[1]!]!.status = "queued"; }, context);
    now += 2000;
    await s.fireOne(ids[0]!);
    await s.reconcile();
    const list = await h.commit(tx => s.list(tx, sid), context);
    assert.deepEqual(list.map(r => [r.status, r.terminalReason]), [["failed", "run_failed"], ["failed", "run_failed"]]);
  } finally { await s.close(); await h.close(context); }
});

test("recovery compaction retains latest entitlement and older future structured floors, never parsed guesses", async () => {
  const { faux, models, ref } = provider();
  faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." })));
  const now = Date.now();
  const h = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const s = new ScheduledMessagesService({ harness: h, now: () => now, log: () => {} });
  let calls = 0;
  const r = new LimitRecoveryService({ harness: h, scheduledMessages: s, now: () => now, log: () => {}, defaultModel: () => ref,
    policy: () => ({ enabled: true, maxWaitHours: 24 }), parseResetTime: async () => { calls++; return { resetAt: now + 600_000 }; } });
  try {
    const conv = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    let latest = 0;
    for (let i = 0; i < 4; i++) {
      await (await conv.submit({ type: "input", content: `work ${i}` }, context)).wait(context);
      await h.commit(async tx => {
        const failure = await readTurnFailure(tx, conv.id); assert.ok(failure);
        latest = failure.boundary;
        (await tx.doc(RecoveryStateDoc)).attempts[recoveryKey(Number(conv.id), latest)] = {
          conversationId: Number(conv.id), boundary: latest, generation: failure.generation, provider: ref.provider, model: ref.modelId,
          status: "stopped", ...(i === 0 ? { evidenceAt: now + 120_000 } : {}),
        };
      }, context);
    }
    await r.start();
    const state = await h.commit(async tx => JSON.parse(JSON.stringify(await tx.doc(RecoveryStateDoc))), context);
    assert.equal(Object.keys(state.attempts).length, 1);
    assert.equal(state.claimedThrough[String(conv.id)], latest);
    assert.equal(recoveryResetFloor(state, ref.provider, ref.modelId), now + 120_000);
    assert.equal(recoveryResetFloor(state, ref.provider, "another-model"), 0);
    assert.equal(calls, 0);
  } finally { await r.close(); await s.close(); await h.close(context); }
});

test("an interrupted claim with expired evidence reports the passed reset, not unknown timing", async () => {
  const { faux, models, ref } = provider();
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Rate limit reached." })]);
  const now = Date.now();
  const h = await openLuna({ dbPath: ":memory:", models, memory: false, coding: false });
  const s = new ScheduledMessagesService({ harness: h, now: () => now, log: () => {} });
  let calls = 0;
  const r = new LimitRecoveryService({ harness: h, scheduledMessages: s, now: () => now, log: () => {}, defaultModel: () => ref,
    policy: () => ({ enabled: true, maxWaitHours: 24 }), parseResetTime: async () => { calls++; return undefined; } });
  try {
    const conv = await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    await (await conv.submit({ type: "input", content: "work" }, context)).wait(context);
    await h.commit(async tx => {
      const failure = await readTurnFailure(tx, conv.id); assert.ok(failure);
      (await tx.doc(RecoveryStateDoc)).attempts[recoveryKey(Number(conv.id), failure.boundary)] = {
        conversationId: Number(conv.id), boundary: failure.boundary, generation: failure.generation, provider: ref.provider, model: ref.modelId,
        status: "parsing", evidenceAt: now - 120_000, exact: true,
      };
    }, context);
    await r.start();
    const summary = await h.commit(tx => s.recovery(tx, conv.id), context);
    assert.match(summary?.pausedReason ?? "", /reset.*passed/i);
    assert.equal(calls, 0);
  } finally { await r.close(); await s.close(); await h.close(context); }
});
