// Real durable harness + faux provider: a limit failure schedules a continuation, which runs without user input.
// Covers exact reset, backoff, fatal errors, disabled setting, user-message cancel, API cancel, attempt cap, restart.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createModels, context, openLuna } from "./luna.js";
import { createApp } from "./server.js";
import { CONTINUATION_TAG, LimitContinuer, type AutoContinuePolicy } from "./limit-continue.js";

const dir = mkdtempSync(join(tmpdir(), "luna-limit-continue-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const policy: AutoContinuePolicy = { enabled: true, maxWaitHours: 1, maxAttempts: 3 };
const logs: string[] = [];
type ConversationHandle = Awaited<ReturnType<Awaited<ReturnType<typeof openLuna>>["createConversation"]>>;
const open = () => openLuna({ dbPath: join(dir, "test.db"), models, memory: false, coding: false });
const continuer = (h: Awaited<ReturnType<typeof open>>, backoffMs = [80, 80, 80]) =>
  new LimitContinuer({ harness: h, policy: () => policy, log: m => logs.push(m), graceMs: 0, backoffMs });

let harness = await open();
let lc = continuer(harness); await lc.start();
let app = createApp({ harness, agent: { model }, limitContinuer: lc });

const err = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });
const create = () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
const send = async (conv: ConversationHandle, content = "Work on the task") => {
  await conv.submit({ type: "input", content, whenBusy: "reject" }, context); await conv.waitForIdle(context);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() > end) throw new Error("deadline: " + JSON.stringify(v)); await sleep(20); }
}
const userTexts = async (conv: ConversationHandle) => {
  const page = await conv.entries({ order: "ascending" }, 500, undefined, context);
  return page.items.filter(e => e.kind === "pi.user").map(e => (e.model ?? []).map((m: any) => typeof m.content === "string" ? m.content : m.content.map((b: any) => b.text ?? "").join("")).join(""));
};
const continuations = async (conv: ConversationHandle) => (await userTexts(conv)).filter(t => t.startsWith(`<${CONTINUATION_TAG}`)).length;
const detail = async (id: number) => (await (await app.request(`/v1/sessions/${id}`)).json()) as any;

try {
  // 1. Exact reset time: waits until it, then continues by itself and finishes.
  {
    const conv = await create();
    const reset = Math.ceil((Date.now() + 1200) / 1000);
    faux.setResponses([err(`You have hit your ChatGPT usage limit (plus plan). (resets_at=${reset})`), fauxAssistantMessage("continued and done")]);
    await send(conv);
    const d = await until(() => detail(conv.id), d => d.resumeAt !== null);
    assert.equal(d.status, "limit_reached"); assert.equal(d.resumeAt, reset * 1000);
    assert.equal(await continuations(conv), 0, "must not resume before the reset");
    await until(() => continuations(conv), n => n === 1);
    await conv.waitForIdle(context);
    const after = await until(() => detail(conv.id), d => !d.running && d.status !== "limit_reached");
    assert.equal(after.resumeAt, null);
    assert.ok(Date.now() >= reset * 1000);
    console.log("OK exact reset: waited for resets_at, continued without user input, finished");
  }

  // 2. No time: backoff, then continue. (pi-durable retries short transient errors such as a bare 429 inside the
  // turn first; these tests use limits it hands back immediately.)
  {
    const conv = await create();
    faux.setResponses([err("You've hit your session limit"), fauxAssistantMessage("ok")]);
    await send(conv);
    await until(() => continuations(conv), n => n === 1);
    await conv.waitForIdle(context);
    assert.match((await userTexts(conv)).at(-1)!, /attempt="1"/);
    console.log("OK limit without a time: backoff continuation");
  }

  // 3. Fatal errors never wait.
  {
    const conv = await create();
    faux.setResponses([err("400 prompt is too long: 210000 tokens > 200000 maximum")]);
    await send(conv); await sleep(300);
    assert.equal((await detail(conv.id)).resumeAt, null); assert.equal(await continuations(conv), 0);
    faux.setResponses([err("429: insufficient_quota. You exceeded your current quota, please check your plan and billing details.")]);
    await send(conv); await sleep(300);
    assert.equal(await continuations(conv), 0);
    console.log("OK context overflow and empty balance do not wait");
  }

  // 4. Disabled setting: nothing is scheduled.
  {
    policy.enabled = false;
    const conv = await create();
    faux.setResponses([err("You've hit your session limit")]);
    await send(conv); await sleep(300);
    assert.equal(await continuations(conv), 0); assert.equal((await detail(conv.id)).resumeAt, null);
    policy.enabled = true;
    console.log("OK disabled setting schedules nothing");
  }

  // 5. A user message during the wait cancels it.
  {
    await lc.close(); lc = continuer(harness, [600]); await lc.start(); app = createApp({ harness, agent: { model }, limitContinuer: lc });
    const conv = await create();
    faux.setResponses([err("Claude usage limit reached"), fauxAssistantMessage("user reply")]);
    await send(conv);
    await until(() => detail(conv.id), d => d.resumeAt !== null);
    await send(conv, "never mind, do this instead");
    await sleep(900);
    assert.equal(await continuations(conv), 0);
    console.log("OK user message cancels the pending wait");

    // 6. API cancel.
    faux.setResponses([err("Claude usage limit reached")]);
    await send(conv);
    await until(() => detail(conv.id), d => d.resumeAt !== null);
    const res = await app.request(`/v1/sessions/${conv.id}/limit-wait`, { method: "DELETE" });
    assert.deepEqual(await res.json(), { cancelled: true });
    assert.equal((await detail(conv.id)).resumeAt, null);
    await sleep(900);
    assert.equal(await continuations(conv), 0);
    console.log("OK DELETE /limit-wait cancels");
  }

  // 7. Attempt cap: repeated limits stop after maxAttempts continuations.
  {
    await lc.close(); lc = continuer(harness); await lc.start();
    policy.maxAttempts = 2;
    const conv = await create();
    faux.setResponses(Array.from({ length: 6 }, () => err("You've hit your session limit")));
    await send(conv);
    await until(() => continuations(conv), n => n === 2);
    await sleep(500); await conv.waitForIdle(context);
    assert.equal(await continuations(conv), 2);
    assert.ok(logs.some(l => /stopped after 2 attempts/.test(l)));
    policy.maxAttempts = 3;
    console.log("OK attempt cap stops repeated continuations");
  }

  // 8. Restart: a stored wait is armed again by a new process.
  {
    await lc.close(); lc = continuer(harness, [700]); await lc.start();
    const conv = await create();
    faux.setResponses([err("You've hit your session limit")]);
    await send(conv);
    await until(async () => (await harness.commit(async tx => (await tx.doc((await import("./limit-continue.js")).LimitWaitsDoc)).waits[String(conv.id)], context)), w => !!w);
    await lc.close(); await harness.close(context);
    harness = await open(); harness.resume();
    faux.setResponses([fauxAssistantMessage("resumed after restart")]);
    lc = continuer(harness); await lc.start();
    const reopened = (await harness.conversation(conv.id, context))!;
    await until(() => continuations(reopened), n => n === 1);
    await reopened.waitForIdle(context);
    console.log("OK wait survives restart");
  }

  // 9. Subagent conversations (delegate.child marker) never continue; the parent turn gets the failure.
  {
    const parent = await create();
    const child = await create();
    await harness.commit(tx => tx.appendEntry(child.id, { kind: "delegate.child", data: { task: "sub", parent: parent.id as number } }), context);
    faux.setResponses([err("You've hit your session limit")]);
    await send(child); await sleep(300);
    assert.equal(await continuations(child), 0);
    console.log("OK subagent conversations are skipped");
  }
  console.log("LIMIT_CONTINUE_OK");
} catch (e) { console.error(logs.join("\n")); throw e; } finally {
  await lc.close();
  await harness.close(context).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
