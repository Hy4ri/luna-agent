import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, GenerationTask, CompactionTask, UserEntry, AssistantEntry, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { createModels, context, openLuna } from "./luna.js";
import { createApp } from "./server.js";
import { Children } from "./delegate.js";
import { type BusyMode } from "./busy-input.js";

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Busy-input gate timed out")), 10_000); })]); }
  finally { clearTimeout(timer!); }
}
const dir = mkdtempSync(join(tmpdir(), "luna-busy-"));
let count = 0;
async function setup(mode: BusyMode = "interrupt", acknowledgements = true, coding = false, slow = false, holdFinal = false, holdCompact = false) {
  const faux = fauxProvider(slow ? { tokensPerSecond: 100, tokenSize: { min: 2, max: 2 } } : {}); const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
  const toolStart = gate(), toolRelease = gate(), finalStart = gate(), finalRelease = gate(), compactStart = gate(), compactRelease = gate(); let toolAborted = false, heldFinal = false;
  const harness = await openLuna({ dbPath: join(dir, `${count++}.db`), models, memory: false, coding,
    compaction: holdCompact ? () => ({ enabled: true, autoEnabled: false, keepRecentTokens: 1, backgroundTokens: 0 }) : undefined,
    extensions: [defineExtension({ name: "busy-test", hooks: [hook(GenerationTask, { async onYield() {
      if (holdFinal && !heldFinal) { heldFinal = true; finalStart.resolve(); await finalRelease.promise; }
    } }), hook(CompactionTask, { async beforeCompact() {
      if (holdCompact) { compactStart.resolve(); await compactRelease.promise; return { summary: "Earlier history" }; }
    } })], tools: [defineTool({ name: "gated", description: "Controlled tool", parameters: Type.Object({}),
      async execute(_args, _api, ctx) {
        let finished = false;
        ctx.abortSignal?.addEventListener("abort", () => { if (!finished) toolAborted = true; }, { once: true });
        toolStart.resolve(); await toolRelease.promise; finished = true; return { output: [{ type: "text", text: "tool result" }] };
      },
    })] })],
  });
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const policy = { mode, acknowledgements };
  const app = createApp({ harness, agent: { model }, busyInput: () => policy });
  const post = async (content: unknown, extra: Record<string, unknown> = {}) => {
    const r = await app.request(`/v1/sessions/${conv.id}/messages?async=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, ...extra }) });
    const body = await r.json() as any; return { status: r.status, ...body };
  };
  const wait = async (id: number) => within((async () => { const sub = await harness.submission(id as never, context); assert.ok(sub); return sub.wait(context); })());
  const entries = async () => (await conv.entries({ order: "ascending" }, 1000, undefined, context)).items;
  const users = async () => (await entries()).filter(e => e.kind === "pi.user").map(e => e.model?.[0]?.role === "user" ? e.model[0].content : undefined);
  return { faux, harness, conv, post, wait, entries, users, policy, toolStart, toolRelease, toolAborted: () => toolAborted, finalStart, finalRelease, compactStart, compactRelease,
    close: async () => { toolRelease.resolve(); finalRelease.resolve(); compactRelease.resolve(); await harness.close(context); } };
}
try {
  for (const mode of ["steer", "interrupt"] as const) {
    const t = await setup(mode);
    try {
      t.faux.setResponses([fauxAssistantMessage([fauxToolCall("gated", {})], { stopReason: "toolUse" }), fauxAssistantMessage("corrected")]);
      const first = await t.post("start"); await within(t.toolStart.promise);
      const a = await t.post("  first correction  ", { requestId: "steer-1" });
      const b = await t.post("second correction", { requestId: "steer-2" });
      assert.equal(a.action, "steered"); assert.equal(b.action, "steered"); assert.ok(a.notice); assert.equal(b.notice, undefined);
      assert.equal(t.toolAborted(), false); assert.deepEqual(await t.users(), ["start"]);
      const duplicate = await t.post("  first correction  ", { requestId: "steer-1" }); assert.equal(duplicate.submissionId, a.submissionId);
      t.toolRelease.resolve();
      const [original, steered, second] = await Promise.all([t.wait(first.submissionId), t.wait(a.submissionId), t.wait(b.submissionId)]);
      assert.equal(original.status, "done"); assert.equal(steered.status, "done"); assert.equal(second.status, "done");
      assert.deepEqual(await t.users(), ["start", "first correction\nsecond correction"]);
      assert.equal(t.toolAborted(), false); assert.equal(t.faux.state.callCount, 2);
      console.log(`OK ${mode}: tool batch survives; two steers merge once and settle with original turn`);
    } finally { await t.close(); }
  }
  {
    const t = await setup("interrupt", true, false, true); const modelStart = gate(); let cancelled = false, sawPartial = false, sawCorrection = false;
    try {
      t.faux.setResponses([(_ctx, options) => {
        modelStart.resolve(); options?.signal?.addEventListener("abort", () => { cancelled = true; }, { once: true });
        return fauxAssistantMessage("Partial work kept ".repeat(100));
      }, ctx => {
        sawPartial = ctx.messages.some(m => m.role === "assistant" && m.content.some(b => b.type === "text" && b.text.startsWith("Partial")));
        sawCorrection = ctx.messages.some(m => m.role === "user" && m.content === "Change direction");
        return fauxAssistantMessage("Corrected final");
      }]);
      const first = await t.post("start"); await within(modelStart.promise);
      await within((async () => { for (;;) {
        const live = await t.harness.snapshot(LiveDoc, t.conv.id, context);
        if (live?.generation?.message?.content.some(b => b.type === "text" && b.text.startsWith("Partial"))) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      } })());
      const correction = await t.post("Change direction"); assert.equal(correction.action, "redirected");
      assert.equal((await t.wait(first.submissionId)).status, "done"); assert.equal((await t.wait(correction.submissionId)).status, "done");
      assert.ok(cancelled && sawPartial && sawCorrection); assert.equal(t.faux.state.callCount, 2);
      t.faux.setResponses([fauxAssistantMessage("next turn")]);
      const late = await t.post("after final"); assert.equal(late.action, "started"); await t.wait(late.submissionId);
      console.log("OK redirect cancels only model, preserves partial in model history, continues original turn; late redirect starts new turn");
    } finally { await t.close(); }
  }
  {
    const t = await setup("queue"); const start = gate(), release = gate(); const turns: unknown[][] = [];
    try {
      t.faux.setResponses([async () => { start.resolve(); await release.promise; return fauxAssistantMessage("first answer"); }, ctx => { turns.push(ctx.messages.filter(m => m.role === "user").map(m => m.content)); return fauxAssistantMessage("answer two"); }, ctx => { turns.push(ctx.messages.filter(m => m.role === "user").map(m => m.content)); return fauxAssistantMessage("answer three"); }]);
      const first = await t.post("one"); await within(start.promise);
      const second = await t.post("two", { requestId: "second" }), third = await t.post("/queue clear the cache");
      assert.equal(second.action, "queued"); assert.equal(third.action, "queued");
      let list = await t.post("/queue list"); assert.deepEqual(list.queue.map((r: any) => r.content), ["two", "clear the cache"]);
      const moved = await t.post("/queue move 2 to 1", { requestId: "move" }); assert.deepEqual(moved.queue.map((r: any) => r.content), ["clear the cache", "two"]);
      await t.post("/queue move 2 to 1", { requestId: "move" });
      await t.post("/queue edit 1 edited three"); list = await t.post("/queue list"); assert.deepEqual(list.queue.map((r: any) => r.content), ["edited three", "two"]);
      for (const command of ["/model other", "/compress", "/retry"]) assert.equal((await t.post(command)).status, 409);
      assert.equal((await t.post("/queue remove 0")).status, 400);
      release.resolve(); await Promise.all([t.wait(first.submissionId), t.wait(second.submissionId), t.wait(third.submissionId)]);
      assert.deepEqual(turns, [["one", "edited three"], ["one", "edited three", "two"]]);
      assert.equal(t.faux.state.callCount, 3); console.log("OK FIFO keeps separate turns; list/edit/move and command retries; busy core commands reject");
    } finally { release.resolve(); await t.close(); }
  }
  {
    const t = await setup("steer", false);
    try {
      t.faux.setResponses([fauxAssistantMessage([fauxToolCall("gated", {})], { stopReason: "toolUse" }), fauxAssistantMessage("answer"), fauxAssistantMessage("image answer")]);
      const first = await t.post("start"); await within(t.toolStart.promise);
      const image = await t.post([{ type: "text", text: "photo" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
      assert.equal(image.action, "queued"); assert.equal(image.notice, undefined);
      const removed = await t.post("/queue remove 1"); assert.deepEqual(removed.queue, []); assert.equal((await t.wait(image.submissionId)).status, "unanswered");
      const a = await t.post("/queue task A"), b = await t.post("/queue task B"); await t.post("/queue clear");
      assert.equal((await t.wait(a.submissionId)).status, "unanswered"); assert.equal((await t.wait(b.submissionId)).status, "unanswered");
      t.toolRelease.resolve(); await t.wait(first.submissionId); console.log("OK media falls back once; acknowledgements off; remove and clear settle submissions");
    } finally { await t.close(); }
  }
  {
    const t = await setup("steer"); const start = gate(), release = gate();
    try {
      t.faux.setResponses([async () => { start.resolve(); await release.promise; return fauxAssistantMessage("initial final"); }, fauxAssistantMessage("steered final"), fauxAssistantMessage("queued final")]);
      const first = await t.post("start"); await within(start.promise);
      const queued = await t.post("/queue later"), steered = await t.post("extra information");
      release.resolve(); const a = await t.wait(first.submissionId), b = await t.wait(steered.submissionId); await t.wait(queued.submissionId);
      assert.equal(a.status, "done"); assert.equal(b.status, "done");
      if (a.status === "done" && b.status === "done") assert.equal(a.answer, b.answer, "Final boundary must continue original run for steer");
      assert.deepEqual(await t.users(), ["start", "extra information", "later"]); console.log("OK steer drains at final boundary before queued follow-up");
    } finally { release.resolve(); await t.close(); }
  }
  {
    const t = await setup("steer");
    try {
      t.faux.setResponses([fauxAssistantMessage([fauxToolCall("gated", {})], { stopReason: "toolUse" })]);
      const first = await t.post("start"); await within(t.toolStart.promise); const pending = await t.post("pending steer");
      const stopped = t.post("/stop"); await new Promise(resolve => setTimeout(resolve, 30)); t.toolRelease.resolve();
      assert.equal((await within(stopped)).notice, "Stopped."); assert.equal((await t.wait(first.submissionId)).status, "unanswered"); assert.equal((await t.wait(pending.submissionId)).status, "unanswered");
      assert.deepEqual((await t.harness.snapshot(InboxDoc, t.conv.id, context))?.items, []); assert.deepEqual(await t.users(), ["start"]);
      console.log("OK hard stop clears pending steer and does not retry");
    } finally { await t.close(); }
  }
  {
    const t = await setup(); const childStart = gate(), childRelease = gate(), parentStart = gate(), parentRelease = gate();
    try {
      const child = await t.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: (await t.conv.agent(context)).model } }, context);
      await t.harness.commit(async tx => { (await tx.doc(Children, t.conv.id)).children.push({ id: child.id as unknown as number, task: "child", spawnKey: "test" }); }, context);
      t.faux.setResponses([async () => { childStart.resolve(); await childRelease.promise; return fauxAssistantMessage("child answer"); }, async () => { parentStart.resolve(); await parentRelease.promise; return fauxAssistantMessage("parent answer"); }, fauxAssistantMessage("queued answer")]);
      const cs = await child.submit({ type: "input", content: "child" }, context); await within(childStart.promise);
      const first = await t.post("parent"); await within(parentStart.promise); const extra = await t.post("correction"); assert.equal(extra.action, "queued");
      assert.ok((await t.harness.snapshot(LiveDoc, child.id, context))?.run);
      parentRelease.resolve(); childRelease.resolve(); await Promise.all([t.wait(first.submissionId), t.wait(extra.submissionId), within(cs.wait(context))]);
      console.log("OK interrupt demotes to queue while subagents run; child survives");
    } finally { parentRelease.resolve(); childRelease.resolve(); await t.close(); }
  }
  {
    const t = await setup("interrupt", true, false, false, true);
    try {
      t.faux.setResponses([fauxAssistantMessage("final already received"), fauxAssistantMessage("next task answer")]);
      const first = await t.post("start"); await within(t.finalStart.promise);
      const late = await t.post("late correction", { requestId: "late" });
      assert.equal(late.action, "queued", "A completed model call must not accept redirect");
      const duplicate = await t.post("late correction", { requestId: "late" }); assert.equal(late.submissionId, duplicate.submissionId);
      assert.equal((await t.post(" ")).status, 400); assert.equal((await t.post([{ type: "text", text: " " }])).status, 400);
      t.finalRelease.resolve(); await Promise.all([t.wait(first.submissionId), t.wait(late.submissionId)]);
      assert.deepEqual(await t.users(), ["start", "late correction"]); assert.equal(t.faux.state.callCount, 2);
      console.log("OK redirect after model completion falls back to FIFO exactly once");
    } finally { await t.close(); }
  }
  {
    const t = await setup("interrupt", true, false, false, false, true);
    try {
      await t.conv.commit(async tx => {
        await tx.appendEntry(UserEntry, t.conv.id, { model: [{ role: "user", content: "old ".repeat(2000), timestamp: 1 }] });
        await tx.appendEntry(AssistantEntry, t.conv.id, { model: [fauxAssistantMessage("old reply")] });
        await tx.appendEntry(UserEntry, t.conv.id, { model: [{ role: "user", content: "recent message", timestamp: 2 }] });
        await tx.appendEntry(AssistantEntry, t.conv.id, { model: [fauxAssistantMessage("recent reply")] });
      }, context);
      await t.conv.compact(undefined, context); await within(t.compactStart.promise);
      t.faux.setResponses([fauxAssistantMessage([fauxToolCall("gated", {})], { stopReason: "toolUse" }), fauxAssistantMessage("original answer"), fauxAssistantMessage("queued answer")]);
      const first = await t.post("start"); await within(t.toolStart.promise);
      const extra = await t.post("correction during compression"); assert.equal(extra.action, "queued");
      t.compactRelease.resolve(); t.toolRelease.resolve(); await Promise.all([t.wait(first.submissionId), t.wait(extra.submissionId)]);
      console.log("OK interrupt demotes to queue during actual context compression");
    } finally { await t.close(); }
  }
  for (const hardStop of [false, true]) {
    const t = await setup(); const started = gate(), cancelled = gate(), release = gate();
    try {
      t.faux.setResponses([async (_ctx, options) => {
        started.resolve();
        await new Promise<void>(resolve => { options?.signal?.addEventListener("abort", () => { cancelled.resolve(); resolve(); }, { once: true }); });
        await release.promise; return fauxAssistantMessage("cancelled");
      }, fauxAssistantMessage("corrected answer")]);
      const first = await t.post("start"); await within(started.promise);
      const a = await t.post("correction A"); await within(cancelled.promise);
      const b = await t.post("correction B"); assert.equal(a.action, "redirected"); assert.equal(b.action, "redirected");
      if (hardStop) {
        const stopping = t.post("/stop");
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal((await t.post("while draining")).status, 409);
        release.resolve(); await within(stopping);
        assert.equal((await t.wait(first.submissionId)).status, "unanswered");
        assert.equal((await t.wait(a.submissionId)).status, "unanswered");
        assert.equal((await t.wait(b.submissionId)).status, "unanswered");
        assert.deepEqual(await t.users(), ["start"]); assert.equal(t.faux.state.callCount, 1);
        console.log("OK hard stop wins over pending redirects; draining input is rejected without admission");
      } else {
        release.resolve(); await Promise.all([t.wait(first.submissionId), t.wait(a.submissionId), t.wait(b.submissionId)]);
        assert.deepEqual(await t.users(), ["start", "correction A\n[Additional user correction]\n\ncorrection B"]);
        assert.equal(t.faux.state.callCount, 2);
        console.log("OK multiple pending redirects combine with correction marker and each submission settles once");
      }
    } finally { release.resolve(); await t.close(); }
  }
  console.log("BUSY_INPUT_OK");
} finally { rmSync(dir, { recursive: true, force: true }); }
