import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, InboxDoc, ProviderDoc, UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { context, openLuna } from "./luna.js";
import { SideCommands, renderSideHistory, trimSideHistory } from "./side-commands.js";
import { createApp } from "./server.js";

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; }
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("side command test timed out")), 10000); })]); }
  finally { clearTimeout(timer!); }
}
const dir = mkdtempSync(join(tmpdir(), "luna-side-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const held = gate(), toolStarted = gate(), cancelStarted = gate(); let cancellationObserved = false; let tools = 0, mainAborted = false;
const extension = defineExtension({ name: "side-test", tools: [
  defineTool({ name: "cancel_probe", description: "Wait until the job is stopped", parameters: Type.Object({}), async execute(_args, _api, ctx) {
    cancelStarted.resolve();
    await new Promise<void>(resolve => {
      const stop = () => { cancellationObserved = true; resolve(); };
      if (ctx.abortSignal?.aborted) stop(); else ctx.abortSignal?.addEventListener("abort", stop, { once: true });
    });
    return { output: [{ type: "text", text: "cancelled" }] };
  } }),
  defineTool({ name: "hold", description: "Held main tool", parameters: Type.Object({}), async execute(_args, _api, ctx) {
    let finished = false;
    ctx.abortSignal?.addEventListener("abort", () => { if (!finished) mainAborted = true; }, { once: true });
    toolStarted.resolve(); await held.promise; finished = true; return { output: [{ type: "text", text: "main tool finished" }] };
  } }),
  defineTool({ name: "probe", description: "Count real tool calls", parameters: Type.Object({}), async execute() {
    tools++; return { output: [{ type: "text", text: "probe output" }] };
  } }),
] });
const harness = await openLuna({ models, dbPath: join(dir, "luna.db"), cwd: dir, coding: false, memory: false, extensions: [extension] });
let route: { provider: string; modelId: string } | undefined;
const side = new SideCommands({ harness, models, route: () => route });
const app = createApp({ harness, models, sideCommands: side, agent: { model }, token: "test" });
const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions: "SOURCE_INSTRUCTIONS", thinkingLevel: "low", cwd: dir } }, context);
const empty = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
const entries = () => conv.entries({ order: "ascending" }, 1000, undefined, context).then(p => p.items);
const request = (id: unknown, content: unknown, requestId?: string) => app.request(`/v1/sessions/${id}/messages?async=1`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ content, requestId }) });
async function finish(id: string, session = conv) {
  return within((async () => {
    for (;;) {
      const job = side.list(String(session.id)).find(j => j.id === id);
      assert.ok(job, "job exists");
      if (job.status !== "running") return job;
      await new Promise(r => setTimeout(r, 5));
    }
  })());
}
try {
  const done = fauxAssistantMessage("settled answer"), call = fauxAssistantMessage([fauxToolCall("probe", { secretArgument: "not in digest" })], { stopReason: "toolUse" });
  const messages: Message[] = [{ role: "system", content: "SECRET_SYSTEM", timestamp: 1 }, { role: "user", content: "old question", timestamp: 2 }, done,
    { role: "user", content: "in-flight", timestamp: 3 }, call];
  const trimmed = trimSideHistory(messages);
  assert.deepEqual(trimmed, messages.slice(0, 3)); assert.equal(messages.length, 5); assert.notEqual(trimmed, messages);
  assert.deepEqual(trimSideHistory(messages.slice(3)), []);
  const digest = renderSideHistory([...messages, { role: "toolResult", toolCallId: "x", toolName: "probe", content: [{ type: "text", text: "tool result" }], isError: false, timestamp: 4 }]);
  assert.ok(!digest.includes("SECRET_SYSTEM")); assert.ok(digest.includes("USER: old question"));
  assert.ok(digest.includes("ASSISTANT: settled answer")); assert.ok(digest.includes("TOOL RESULT: tool result"));
  assert.ok(digest.includes("probe")); assert.ok(!digest.includes("secretArgument"));
  const large = renderSideHistory(Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `message-${i}:` + "x".repeat(3000), timestamp: i })));
  assert.ok(large.length <= 24000); assert.ok(large.includes("message-39:")); assert.ok(!large.includes("message-0:"));
  assert.ok(renderSideHistory([{ role: "user", content: "y".repeat(4000), timestamp: 1 }]).length <= 2006);
  console.log("OK snapshot tail trim and bounded plain-text digest");

  assert.equal((await request(empty.id, "/btw")).status, 400);
  assert.equal((await request(empty.id, "/bg")).status, 400);
  await assert.rejects(side.start(empty, "btw", "question", "question"), /no history/);
  const broken = { ...empty, context: async () => { throw new Error("disk failed"); } } as Conversation;
  await assert.rejects(side.start(broken, "btw", "question", "question"), /history unreadable/);
  const unavailable = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "missing", modelId: "missing" } } }, context);
  await assert.rejects(side.start(unavailable, "bg", "task", "task"), /no credentials/);
  assert.equal((await request(999999, "/bg work")).status, 404);
  assert.equal(side.list(String(empty.id)).length, 0);

  faux.setResponses([fauxAssistantMessage("seed reply")]);
  await (await conv.submit({ type: "input", content: "SEED_CONTEXT" }, context)).wait(context);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
  const main = await conv.submit({ type: "input", content: "MAIN_TASK" }, context);
  await within(toolStarted.promise);
  const before = await entries(), provider = await harness.snapshot(ProviderDoc, conv.id, context);
  const originalPrefix = trimSideHistory((await conv.context(context)).messages);
  let sawPrefix = false, sawSession = false, deniedResult = false;
  faux.setResponses([(_ctx, options) => {
    sawPrefix = JSON.stringify(_ctx.messages.slice(0, originalPrefix.length)) === JSON.stringify(originalPrefix);
    sawSession = options?.sessionId === provider?.sessionId;
    assert.ok(JSON.stringify(_ctx.messages.at(-1)).includes("only the side question"));
    return fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" });
  }, ctx => {
    deniedResult = ctx.messages.some(m => m.role === "toolResult" && m.isError && JSON.stringify(m.content).includes("denied"));
    return fauxAssistantMessage("SIDE_ANSWER");
  }]);
  const receipt = await request(conv.id, "/btw explain seed", "btw-one"); assert.equal(receipt.status, 202);
  const body = await receipt.json() as any;
  assert.equal(body.command, true); assert.equal(body.submissionId, undefined);
  const btw = await finish(body.job.id);
  assert.equal(btw.status, "complete", btw.text); assert.equal(btw.text, "SIDE_ANSWER");
  assert.ok(sawPrefix && sawSession && deniedResult, "prefix, affinity, and dispatch denial");
  assert.equal(tools, 0); assert.equal(mainAborted, false);
  assert.deepEqual(await entries(), before, "btw writes no entries");
  assert.equal((await harness.snapshot(InboxDoc, conv.id, context))?.items.length ?? 0, 0);
  const usage = await harness.snapshot(UsageDoc, conv.id, context);
  assert.ok(usage?.models[`${fm.provider}/${fm.id}`]);
  assert.ok(Object.values(usage!.models).every(v => typeof v === "object" && "input" in v), "usage has only model buckets");
  assert.equal((await main.status(context)).status, "placed");
  console.log("OK /btw during tools: cache-parity replay, usage, denied tool request, no writes or interruption");

  let sawFresh = false, sawImage = false, audioPath = "";
  const audio = Buffer.from("audio-bytes"), image = "aGVsbG8=";
  faux.setResponses([ctx => {
    const serialized = JSON.stringify(ctx.messages);
    sawFresh = !serialized.includes("SEED_CONTEXT") && !serialized.includes("MAIN_TASK") && !serialized.includes("/bg");
    assert.ok(serialized.includes("SOURCE_INSTRUCTIONS"));
    const users = ctx.messages.filter(m => m.role === "user"); assert.equal(users.length, 1);
    const content = users[0]!.content;
    sawImage = Array.isArray(content) && content.some(b => b.type === "image" && b.data === image);
    const text = typeof content === "string" ? content : content.filter(b => b.type === "text").map(b => b.text).join("\n");
    audioPath = /Audio attachment available at ([^;]+);/.exec(text)?.[1] ?? "";
    assert.deepEqual(readFileSync(audioPath), audio);
    return fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" });
  }, fauxAssistantMessage("BACKGROUND_FINAL")]);
  const response = await request(conv.id, [{ type: "text", text: "/bg TASK_WITH_ATTACHMENTS" }, { type: "image", mimeType: "image/png", data: image }, { type: "audio", mimeType: "audio/wav", data: audio.toString("base64") }], "bg-one");
  assert.equal(response.status, 202); const bgReceipt = await response.json() as any;
  assert.match(bgReceipt.job.id, /^bg_\d{6}_[a-f0-9]{6}$/);
  const bg = await finish(bgReceipt.job.id); assert.equal(bg.status, "complete", bg.text); assert.equal(bg.text, "BACKGROUND_FINAL");
  assert.ok(sawFresh && sawImage && audioPath); assert.equal(tools, 1);
  assert.ok(bg.conversationId && bg.conversationId !== Number(conv.id));
  const child = await harness.conversation(bg.conversationId! as never, context); assert.ok(child);
  assert.equal((await child.agent(context)).thinkingLevel, "low"); assert.equal((await child.agent(context)).cwd, dir);
  assert.deepEqual(await entries(), before); assert.equal(mainAborted, false);
  assert.equal(side.list(String(empty.id)).length, 0);
  console.log("OK /bg is fresh, uses source choices and real tools, forwards image/audio, returns only final answer");

  faux.setResponses([fauxAssistantMessage("IDEMPOTENT")]); const count = faux.state.callCount;
  const [one, two] = await Promise.all([side.start(conv, "btw", "same", "same", "duplicate"), side.start(conv, "btw", "same", "same", "duplicate")]);
  assert.equal(one.id, two.id); await finish(one.id); assert.equal(faux.state.callCount, count + 1);
  await assert.rejects(side.start(conv, "btw", "same", [{ type: "image", data: image, mimeType: "image/png" }], "duplicate"), /conflicting/);
  await assert.rejects(side.start(conv, "btw", "changed", "same", "duplicate"), /conflicting/);
  const copy = side.list(String(conv.id)); copy[0]!.text = "corrupted";
  assert.notEqual(side.list(String(conv.id))[0]!.text, "corrupted");
  let notified = false;
  const offA = side.subscribe(String(conv.id), j => { j.text = "corrupt listener"; throw new Error("disconnected"); });
  const offB = side.subscribe(String(conv.id), j => { if (j.status === "complete") { assert.equal(j.text, "NOTIFIED"); notified = true; } });
  faux.setResponses([fauxAssistantMessage("NOTIFIED")]); const notifyJob = await side.start(conv, "btw", "notify", "notify");
  await finish(notifyJob.id); assert.ok(notified); offA(); offB();

  faux.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })));
  const failed = await finish((await side.start(conv, "btw", "tool loop", "tool loop")).id);
  assert.equal(failed.status, "failed"); assert.match(failed.text, /requested tools/); assert.equal(tools, 1);
  faux.setResponses([fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "provider exploded" })]);
  const errorJob = await finish((await side.start(conv, "btw", "error", "error")).id);
  assert.equal(errorJob.status, "failed"); assert.match(errorJob.text, /provider exploded/);
  console.log("OK retries are idempotent, observers cannot mutate jobs, tool loops and provider errors are visible");

  // Routed calls use the digest, not parent prompt sections or schemas.
  route = model; let digestRoute = false;
  faux.setResponses([ctx => { digestRoute = JSON.stringify(ctx.messages).includes("USER: SEED_CONTEXT") && !JSON.stringify(ctx.messages).includes("SOURCE_INSTRUCTIONS"); return fauxAssistantMessage("ROUTED"); }]);
  assert.equal((await finish((await side.start(conv, "btw", "routed", "routed")).id)).text, "ROUTED"); assert.ok(digestRoute); route = undefined;
  // No settled assistant: use one text-only request rather than an invalid user/user transcript.
  await empty.submit({ type: "write", entry: { kind: "pi.user", model: [{ role: "user", content: "FRESH_ONLY_USER", timestamp: Date.now() }] } }, context);
  let fallback = false;
  faux.setResponses([ctx => { fallback = ctx.messages.filter(m => m.role === "user").length === 1 && JSON.stringify(ctx.messages).includes("USER: FRESH_ONLY_USER"); return fauxAssistantMessage("FALLBACK"); }]);
  const fallbackJob = await side.start(empty, "btw", "fallback", "fallback");
  assert.equal((await finish(fallbackJob.id, empty)).text, "FALLBACK"); assert.ok(fallback);
  // Fresh /bg needs no chat history at all.
  const fresh = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  faux.setResponses([fauxAssistantMessage("FRESH_BG")]);
  assert.equal((await finish((await side.start(fresh, "bg", "fresh", "fresh")).id, fresh)).text, "FRESH_BG");

  faux.setResponses([fauxAssistantMessage("MAIN_FINISHED")]); held.resolve();
  assert.equal((await within(main.wait(context))).status, "done");
  assert.equal(mainAborted, false);
  // Stopping the source cannot cancel a separately owned job.
  const bgStarted = gate(), release = gate();
  faux.setResponses([async () => { bgStarted.resolve(); await release.promise; return fauxAssistantMessage("SURVIVED_SOURCE_STOP"); }]);
  const independent = await side.start(conv, "bg", "independent", "independent"); await within(bgStarted.promise);
  await conv.abort(context); release.resolve();
  assert.equal((await finish(independent.id)).text, "SURVIVED_SOURCE_STOP");
  // Shutdown aborts only the new background conversation and waits for its tool cleanup.
  const stopper = new SideCommands({ harness, models });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("cancel_probe", {})], { stopReason: "toolUse" })]);
  const cancelled = await stopper.start(conv, "bg", "cancel on shutdown", "cancel on shutdown");
  await within(cancelStarted.promise); await within(stopper.close());
  const stoppedJob = stopper.list(String(conv.id)).find(j => j.id === cancelled.id)!;
  assert.equal(stoppedJob.status, "failed"); assert.ok(cancellationObserved);
  const childAfterStop = await harness.conversation(stoppedJob.conversationId! as never, context);
  await within(childAfterStop!.waitForIdle(context));
  const btwStopper = new SideCommands({ harness, models }); const slowStarted = gate();
  faux.setResponses([async (_ctx, options) => {
    slowStarted.resolve();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("stopped", { stopReason: "aborted" });
  }]);
  const slow = await btwStopper.start(conv, "btw", "slow", "slow");
  await within(slowStarted.promise); await within(btwStopper.close());
  assert.equal(btwStopper.list(String(conv.id)).find(j => j.id === slow.id)!.status, "failed");
  await side.close(); assert.equal(existsSync(audioPath), false);
  await assert.rejects(side.start(conv, "bg", "late", "late"), /shutting down/);
  console.log("SIDE_COMMANDS_OK: side commands, busy isolation, fresh background sessions, fallback, routing, cleanup");
} finally { held.resolve(); await side.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); }
