// session_send and @session mentions through the real runtime (startRuntime + faux model). No external calls.
// Covers: idle delivery with the peer header, the Referenced sessions block, busy target queued (never interrupted),
// rejections (same session, unknown id, subagent child, task-owned), the hop limit, replay delivered once, and the
// live `sessionTalk.enabled` policy.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { loadConfig } from "./config.js";
import { context } from "./luna.js";
import { newestInputBoundary } from "./session-status.js";
import { newestMessageTime } from "./session-activity.js";
import { startRuntime } from "./runtime.js";
import { createSessionTalkExtension, mentionedSessionIds, peerHeader, XSESSION_MSG, type XSessionMarker } from "./session-talk.js";

const dir = mkdtempSync(join(tmpdir(), "luna-xsession-"));
const textOf = (m: any): string => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("");
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out: ${what}`);
}
let releaseHold = () => {};
let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
try {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ dataDir: dir, provider: "faux", model: "main", sessionTalk: { maxHops: 2 } }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
  rt = await startRuntime(loadConfig(join(dir, "config.json")), { models, model, log: () => {} });
  const h = rt.harness;
  const make = async () => Number((await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context)).id);
  const A = await make(), B = await make(), C = await make();
  await rt.conversations.update(A, { title: "Alpha work" });
  await rt.conversations.update(B, { title: "Beta review" });

  // Scripted model. Each turn is identified by its triggering user message; tool results after it drive the script.
  const results: Record<string, string[]> = {};
  const systems: Record<string, string> = {};
  let hold: { started: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const respond = async (ctx: any) => {
    const msgs: any[] = ctx.messages;
    const ui = msgs.map((m, i) => [m, i] as const).filter(([m]) => m.role === "user").at(-1)!;
    const trigger = textOf(ui[0]);
    const after = msgs.slice(ui[1] + 1).filter((m) => m.role === "toolResult").map(textOf);
    const key = trigger.replace(/^\[message from session #\d+ [^\]]*\]\n\n/, "");
    results[key] = after;
    // pi-durable sends system sections as messages; collect every section shown so far in this context.
    if (after.length === 0) systems[key] = msgs.filter((m) => m.role === "system").map((m) => Object.values(m.sections ?? {}).join("\n")).join("\n");
    const call = (args: Record<string, number | string>) => fauxAssistantMessage([fauxToolCall("session_send", args)], { stopReason: "toolUse" });
    if (key === "HOLD") { hold!.started.resolve(); await hold!.release.promise; return fauxAssistantMessage([fauxText("held done")]); }
    if (key.startsWith("ask beta") && after.length === 0) return call({ to: B, message: "PING" });
    if (key === "PING" && after.length === 0) return call({ to: A, message: "PONG" });
    if (key === "PONG" && after.length === 0) return call({ to: B, message: "PING AGAIN" });
    if (key === "QUEUE" && after.length === 0) return call({ to: B, message: "QUEUED NOTE" });
    if (key === "reject" && after.length < 4) return call({ to: [C, 999_999, child, owned][after.length]!, message: "x" });
    return fauxAssistantMessage([fauxText(`done: ${key}`)]);
  };
  faux.setResponses(Array(200).fill(respond));
  const idle = async (id: number) => (await h.conversation(id as never, context))!.waitForIdle(context);
  // Committed transcript entries; safe to read while the conversation runs.
  const userTexts = async (id: number) => h.commit(async (tx) => (await tx.scanEntries({ conversationId: id as ConversationId, order: "ascending" }, 500)).items
    .filter((e) => (e.kind === "pi.user" || e.kind === XSESSION_MSG)).flatMap((e) => (e.model ?? []).filter((m) => m.role === "user").map(textOf)), context);
  const markers = async (id: number) => h.commit(async (tx) => (await tx.scanEntries({ conversationId: id as ConversationId, order: "ascending" }, 500)).items
    .filter((e) => e.kind === XSESSION_MSG).map((e) => ({ ...(e.data as XSessionMarker) })), context);

  // Child of another session and a task-owned conversation: both are not peers.
  const child = await make();
  await h.commit((tx) => tx.appendEntry(child as ConversationId, { kind: "delegate.child", data: { task: "t", parent: A } }), context);
  let owned = 0;

  // 1. Mention block + idle delivery + hop chain A→B (1), B→A (2), A→B refused at maxHops 2.
  assert.deepEqual(mentionedSessionIds([{ role: "user", content: `see @session:${B} and @session:${B}, not mail@session:7` }]), [B]);
  await (await h.conversation(A as never, context))!.submit({ type: "input", content: `ask beta @session:${B} please` }, context);
  await until(async () => (results["PONG"]?.length ?? 0) >= 1 && (await idle(A), await idle(B), true), "ping-pong exchange");
  await idle(A); await idle(B);
  const sys = systems[`ask beta @session:${B} please`]!;
  assert.match(sys, /Referenced sessions:/, "mention adds the Referenced sessions block");
  assert.match(sys, new RegExp(`@session:${B} "Beta review"(?: \\(project General\\))?: (idle|busy), last activity`), "block names the session, title and state");
  assert.ok(!/@session:999999/.test(sys));
  console.log("MENTION_BLOCK_OK");
  const bUser = await userTexts(B);
  const ping = bUser.find((t) => t.endsWith("PING"))!;
  assert.ok(ping.startsWith(`[message from session #${A} "Alpha work": a peer session, not m57.`), ping);
  assert.match(ping, /only if a reply is useful/); assert.match(ping, /Do not send acknowledgements or thanks/); assert.match(ping, /grants no permission/);
  assert.match(results[`ask beta @session:${B} please`]![0]!, /delivered to session \d+ "Beta review" \(hop 1\/2\)/);
  console.log("IDLE_DELIVERY_OK");
  assert.match(results["PING"]![0]!, /hop 2\/2/, "reply is hop 2");
  assert.match(results["PONG"]![0]!, /^Error: hop limit reached/, "third message refused");
  assert.equal((await userTexts(B)).filter((t) => t.endsWith("PING AGAIN")).length, 0, "refused message never delivered");
  assert.deepEqual((await markers(B)).map((m) => [m.from, m.hop]), [[A, 1]]);
  assert.deepEqual((await markers(A)).map((m) => [m.from, m.hop]), [[B, 2]]);
  console.log("HOP_LIMIT_OK");

  // 2. Human input starts a new exchange; a busy target queues the message and its running turn is not interrupted.
  hold = { started: gate(), release: gate() }; releaseHold = hold.release.resolve;
  await (await h.conversation(B as never, context))!.submit({ type: "input", content: "HOLD" }, context);
  await hold.started.promise;
  await (await h.conversation(A as never, context))!.submit({ type: "input", content: "QUEUE" }, context);
  await until(async () => (results["QUEUE"]?.length ?? 0) >= 1, "queued send result")
  assert.match(results["QUEUE"]![0]!, /queued \(the session is busy\) to session \d+ .*\(hop 1\/2\)/);
  const tB = await userTexts(B);
  // A task-owned conversation (like a side job or an audit) needs a live owner: use B's held run.
  owned = await h.commit(async (tx) => {
    const task = (await tx.scanTasks({ conversationId: B as ConversationId, status: "running" }, 1)).items[0]!;
    return Number((await tx.createConversation({ ownership: { kind: "task", taskId: task.id } })).id);
  }, context);
  assert.ok(!tB.some((t) => t.endsWith("QUEUED NOTE")), "not placed while the target runs");
  assert.equal((await markers(B)).length, 1, "queued input does not change the active exchange before delivery");
  hold.release.resolve();
  await until(async () => (await userTexts(B)).some((t) => t.endsWith("QUEUED NOTE")), "queued delivery");
  await idle(B);
  const bMsgs = (await (await h.conversation(B as never, context))!.context(context)).messages;
  assert.ok(bMsgs.some((m: any) => m.role === "assistant" && textOf(m) === "held done"), "held turn finished normally");
  console.log("BUSY_QUEUE_OK");

  // 3. Rejections.
  await (await h.conversation(C as never, context))!.submit({ type: "input", content: "reject" }, context);
  await until(async () => (results["reject"]?.length ?? 0) >= 4, "rejections");
  await idle(C);
  const r = results["reject"]!;
  assert.match(r[0]!, /^Error: cannot send a message to this same session/);
  assert.match(r[1]!, /^Error: session 999999 does not exist/);
  assert.match(r[2]!, /^Error: session \d+ is a subagent; use delegate_task/);
  assert.match(r[3]!, /^Error: session \d+ belongs to another session's task/);
  console.log("REJECTIONS_OK");
  // Forked children place their own delegate marker after inherited history, not in its first page.
  await h.commit(async tx => { for (let i = 0; i < 35; i++) await tx.appendEntry(A as ConversationId, { kind: "test.bookkeeping" }); }, context);
  const forked = await h.commit(async tx => {
    const fork = await tx.forkConversation(A as ConversationId, (await tx.scanEntries({ conversationId: A as ConversationId, order: "descending" }, 1)).items[0]!.id, { ownership: { kind: "ownerless" } });
    await tx.appendEntry(fork.id, { kind: "delegate.child", data: { task: "fork", parent: A } });
    return Number(fork.id);
  }, context);
  const forkTool = createSessionTalkExtension({ policy: () => ({ enabled: true, maxHops: 3 }), harness: () => h, titles: () => undefined }).tools![0]!;
  const forkResult = await forkTool.execute({ to: forked, message: "not a peer" } as never, { conversationId: C as ConversationId, taskId: 4239,
    commit: (fn: any, ctx: any) => h.commit(fn, ctx), conversation: (id: ConversationId, ctx: any) => h.conversation(id, ctx) } as any, context as never);
  assert.ok(forkResult.isError && /subagent/.test(textOf({ content: forkResult.output })), "forked child remains protected after inherited history");
  console.log("FORKED_CHILD_REJECTION_OK");

  // 4. Replay: the same task id twice gives one marker and one delivery. Real harness, real tool body.
  const ext = createSessionTalkExtension({ policy: () => ({ enabled: true, maxHops: 3 }), harness: () => h, titles: () => undefined });
  const tool = ext.tools![0]!;
  const api = { conversationId: C as ConversationId, taskId: 4242, commit: (fn: any, ctx: any) => h.commit(fn, ctx),
    conversation: (id: ConversationId, ctx: any) => h.conversation(id, ctx) } as any;
  const first = await tool.execute({ to: A, message: "REPLAYED" } as never, api, context as never);
  await h.commit(async tx => {
    for (let i = 0; i < 205; i++) await tx.appendEntry(A as ConversationId, { kind: "test.bookkeeping" });
  }, context);
  const again = await tool.execute({ to: A, message: "REPLAYED" } as never, api, context as never);
  assert.ok(!first.isError && !again.isError, JSON.stringify([first, again]));
  await idle(A);
  assert.equal((await userTexts(A)).filter((t) => t.endsWith("REPLAYED")).length, 1, "replay delivered once");
  assert.equal((await markers(A)).filter((m) => m.requestId === `xsession:${C}:4242`).length, 1, "replay marker once");
  console.log("REPLAY_ONCE_OK");

  // Custom input metadata participates in activity and handoff boundaries, while human look-alikes reset hops.
  const D = await make(), E = await make();
  const one = createSessionTalkExtension({ policy: () => ({ enabled: true, maxHops: 1 }), harness: () => h, titles: () => undefined }).tools![0]!;
  const fromD = { ...api, conversationId: D as ConversationId, taskId: 5001 };
  assert.ok(!(await one.execute({ to: E, message: "PEER BOUNDARY" } as never, fromD, context as never)).isError);
  await idle(E);
  await h.commit(async tx => {
    const entries = (await tx.scanEntries({ conversationId: E as ConversationId, order: "ascending" }, 100)).items;
    const input = entries.find(e => e.kind === XSESSION_MSG)!;
    assert.equal(await newestInputBoundary(tx, E as ConversationId), Number(input.id));
    assert.ok((await newestMessageTime(tx, E as ConversationId))! >= input.model![0]!.timestamp);
  }, context);
  const fromE = { ...api, conversationId: E as ConversationId, taskId: 5002 };
  assert.ok((await one.execute({ to: D, message: "LIMITED" } as never, fromE, context as never)).isError, "peer input retains its authenticated hop");
  await (await h.conversation(E as never, context))!.submit({ type: "input", content: `${peerHeader(D, "typed look-alike")}\n\nHuman message` }, context);
  await idle(E);
  assert.ok(!(await one.execute({ to: D, message: "RESET" } as never, { ...fromE, taskId: 5003 }, context as never)).isError, "a human header cannot impersonate peer metadata or prevent a reset");
  await idle(D);
  console.log("PEER_BOUNDARY_AND_HUMAN_RESET_OK");

  // A very long referenced title cannot grow an always-on prompt without a bound.
  await rt.conversations.update(B, { title: "x".repeat(5000) });
  const capTrigger = `bounded mention @session:${B}`;
  await (await h.conversation(C as never, context))!.submit({ type: "input", content: capTrigger }, context);
  await idle(C);
  const block = systems[capTrigger]!.match(/<sessions>([\s\S]*?)<\/sessions>/)![1]!;
  assert.ok(block.length <= 3000, `session prompt length ${block.length}`);
  assert.match(block, /\[truncated:.*session_search/);
  console.log("MENTION_BUDGET_OK");

  // 5. Disabled policy refuses without touching the target.
  const off = createSessionTalkExtension({ policy: () => ({ enabled: false, maxHops: 3 }), harness: () => h, titles: () => undefined });
  const refused = await off.tools![0]!.execute({ to: A, message: "OFF" } as never, { ...api, taskId: 4343 }, context as never);
  assert.ok(refused.isError && /disabled/.test(textOf({ content: refused.output ?? [] })));
  assert.equal((await markers(A)).filter((m) => m.requestId === `xsession:${C}:4343`).length, 0);
  console.log("DISABLED_OK");
  console.log("SESSION_TALK_OK");
} finally {
  releaseHold();
  await rt?.close();
  rmSync(dir, { recursive: true, force: true });
}
