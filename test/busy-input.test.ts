// Contract: busy input has two modes, both native pi-durable. Steer joins the current run at its next
// boundary; Queue runs a separate later turn. Neither aborts the current model response or tool.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Harness } from "@earendil-works/pi-durable";
import { openLuna, context } from "../src/luna.js";
import { DEFAULT_BUSY_INPUT, type BusyMode } from "../src/busy-input.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { parseConfig as parse } from "../src/config.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

type Step = "tool" | "hold" | "text";
/** A faux harness whose model plays `script` in order. "hold" blocks inside the model call until `model.release()`. */
async function rig(dbPath: string, script: Step[]) {
  const faux = fauxProvider({ models: [{ id: "busy" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: string[] = [];
  const model = { entered: gate(), finish: gate(), aborted: false };
  const tool = { entered: gate(), finish: gate(), aborted: false };
  faux.setResponses(script.map(step => async (request, options) => {
    requests.push(JSON.stringify(request.messages));
    if (step === "tool") return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
    if (step === "hold") {
      model.entered.release();
      await model.finish.promise;
      model.aborted = options?.signal?.aborted === true;
    }
    return fauxAssistantMessage([fauxText(`answer ${requests.length}`)]);
  }));
  const harness = await openLuna({ dbPath, models, memory: false, coding: false,
    extensions: [defineExtension({ name: "hold", tools: [defineTool({
      name: "hold", description: "Hold a tool boundary.", parameters: Type.Object({}),
      async execute(_args, _api, ctx) {
        tool.entered.release();
        await tool.finish.promise;
        tool.aborted = ctx.abortSignal?.aborted === true;
        return { output: [{ type: "text", text: "tool finished" }] };
      },
    })] })],
  });
  const m = faux.getModel("busy")!;
  const agent = { model: { provider: m.provider, modelId: m.id } };
  const app = (mode: BusyMode) => createApp({ harness, conversations: new ConversationStore(harness), models, agent,
    busyInput: () => ({ mode, acknowledgements: true }) });
  return { harness, requests, model, tool, agent, app, release: () => { model.finish.release(); tool.finish.release(); } };
}

async function send(app: ReturnType<typeof createApp>, id: string | number, body: Record<string, unknown>) {
  const response = await app.request(`/v1/sessions/${id}/messages?async=1`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { action?: string; submissionId?: string; error?: string; notice?: string; tip?: string } };
}

const userTexts = (request: string) => (JSON.parse(request) as { role: string; content: unknown }[])
  .filter(message => message.role === "user").map(message => JSON.stringify(message.content));

test("defaults and config: Steer is the default, only steer and queue exist, and retired interrupt loads as steer", () => {
  expect(DEFAULT_BUSY_INPUT.mode).toBe("steer");
  expect(parse({ provider: "faux" }).busyInput.mode).toBe("steer");
  expect(parse({ provider: "faux", busyInput: { mode: "queue" } }).busyInput.mode).toBe("queue");
  expect(parse({ provider: "faux", busyInput: { mode: "interrupt" } }).busyInput.mode).toBe("steer");
  expect(() => parse({ provider: "faux", busyInput: { mode: "redirect" } })).toThrow(/mode/);
});

for (const phase of ["generation", "tool"] as const) {
  test(`Steer during ${phase}: joins the same run at the next boundary without aborting the current ${phase === "tool" ? "tool" : "response"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-steer-"));
    const script: Step[] = phase === "tool" ? ["tool", "text"] : ["hold", "text"];
    const r = await rig(join(dir, "luna.db"), script);
    try {
      const conv = await r.harness.createConversation({ ownership: { kind: "ownerless" }, agent: r.agent }, context);
      const original = await conv.submit({ type: "input", content: "work" }, context);
      await (phase === "tool" ? r.tool.entered.promise : r.model.entered.promise);
      const sent = await send(r.app("steer"), conv.id, { content: "STEER_SENTINEL" });
      expect(sent.status).toBe(202);
      expect(sent.body.action).toBe("steered");
      expect(`${sent.body.notice ?? ""} ${sent.body.tip ?? ""}`).not.toMatch(/interrupt|redirect|immediately/i);
      r.release();
      expect((await original.wait(context)).status).toBe("done");
      const steered = await r.harness.submission(sent.body.submissionId as never, context);
      expect((await steered!.wait(context)).status).toBe("done");
      expect(r.model.aborted || r.tool.aborted).toBe(false) /* "steer never aborts the current work" */;
      expect(r.requests.length).toBe(2) /* "the steer belongs to the original run, not a later turn" */;
      expect(r.requests[1]!).toMatch(/STEER_SENTINEL/);
      if (phase === "tool") expect(r.requests[1]!).toMatch(/tool finished/) /* "the tool batch finished before the steer was placed" */;
    } finally {
      r.release(); await r.harness.close(context); rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);

  test(`Queue during ${phase}: runs as a separate later turn, in order`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-queue-"));
    const script: Step[] = phase === "tool" ? ["tool", "text", "text", "text"] : ["hold", "text", "text"];
    const r = await rig(join(dir, "luna.db"), script);
    try {
      const conv = await r.harness.createConversation({ ownership: { kind: "ownerless" }, agent: r.agent }, context);
      const original = await conv.submit({ type: "input", content: "work" }, context);
      await (phase === "tool" ? r.tool.entered.promise : r.model.entered.promise);
      const first = await send(r.app("queue"), conv.id, { content: "QUEUE_ONE" });
      const second = await send(r.app("steer"), conv.id, { content: "/queue QUEUE_TWO" });
      expect(first.body.action).toBe("queued");
      expect(second.body.action).toBe("queued") /* "/queue overrides the steer default for one message" */;
      r.release();
      expect((await original.wait(context)).status).toBe("done");
      for (const sent of [first, second])
        expect((await (await r.harness.submission(sent.body.submissionId as never, context))!.wait(context)).status).toBe("done");
      const turns = phase === "tool" ? r.requests.slice(2) : r.requests.slice(1);
      expect(turns.length).toBe(2) /* "each queued message is its own turn" */;
      expect(r.requests[phase === "tool" ? 1 : 0]!).not.toMatch(/QUEUE_ONE/) /* "queued input never joins the current run" */;
      expect(turns[0]!).toMatch(/QUEUE_ONE/); expect(turns[0]!).not.toMatch(/QUEUE_TWO/);
      expect(turns[1]!).toMatch(/QUEUE_TWO/);
      expect(r.model.aborted || r.tool.aborted).toBe(false);
    } finally {
      r.release(); await r.harness.close(context); rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
}

test("redirect is gone: whenBusy redirect is rejected and /redirect is ordinary text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-no-redirect-"));
  const r = await rig(join(dir, "luna.db"), ["tool", "text", "text"]);
  try {
    const conv = await r.harness.createConversation({ ownership: { kind: "ownerless" }, agent: r.agent }, context);
    const original = await conv.submit({ type: "input", content: "work" }, context);
    await r.tool.entered.promise;
    const rejected = await send(r.app("steer"), conv.id, { content: "x", whenBusy: "redirect" });
    expect(rejected.status).toBe(400);
    const plain = await send(r.app("steer"), conv.id, { content: "/redirect CORRECTION" });
    expect(plain.body.action).toBe("steered") /* "/redirect is no longer a command; it is a steer of the literal text" */;
    r.release();
    expect((await original.wait(context)).status).toBe("done");
    expect(r.requests[1]!).toMatch(/\/redirect CORRECTION/);
    expect(r.tool.aborted).toBe(false);
  } finally {
    r.release(); await r.harness.close(context); rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test("a queued message becomes a steer of the current run without duplicate delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-promote-"));
  const r = await rig(join(dir, "luna.db"), ["tool", "text", "text"]);
  try {
    const conv = await r.harness.createConversation({ ownership: { kind: "ownerless" }, agent: r.agent }, context);
    const original = await conv.submit({ type: "input", content: "work" }, context);
    await r.tool.entered.promise;
    const queued = await send(r.app("queue"), conv.id, { content: "PROMOTE_SENTINEL" });
    expect(queued.body.action).toBe("queued");
    const promote = () => r.app("queue").request(`/v1/sessions/${conv.id}/submissions/${queued.body.submissionId}/steer`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "PROMOTE_SENTINEL" }) });
    const first = await promote();
    expect(first.status).toBe(202);
    const receipt = await first.json() as { action: string; submissionId: string };
    expect(receipt.action).toBe("steered");
    const retry = await (await promote()).json() as { submissionId: string };
    expect(retry.submissionId).toBe(receipt.submissionId) /* "a retry returns the same replacement" */;
    const legacy = await r.app("queue").request(`/v1/sessions/${conv.id}/submissions/${queued.body.submissionId}/send-now`, { method: "POST" });
    expect(legacy.status).toBe(404) /* "the Send now route is gone" */;
    r.release();
    expect((await original.wait(context)).status).toBe("done");
    expect((await (await r.harness.submission(receipt.submissionId as never, context))!.wait(context)).status).toBe("done");
    expect(r.requests.length).toBe(2) /* "the promoted message joined the original run once" */;
    expect(r.requests[1]!.split("PROMOTE_SENTINEL").length - 1).toBe(1);
  } finally {
    r.release(); await r.harness.close(context); rmSync(dir, { recursive: true, force: true });
  }
}, 10000);

test("restart: queued and steered input survives a daemon restart and is delivered once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-busy-restart-"));
  const dbPath = join(dir, "luna.db");
  let first: Awaited<ReturnType<typeof rig>> | undefined = await rig(dbPath, ["tool"]);
  let second: Awaited<ReturnType<typeof rig>> | undefined;
  try {
    const conv = await first.harness.createConversation({ ownership: { kind: "ownerless" }, agent: first.agent }, context);
    await conv.submit({ type: "input", content: "work" }, context);
    await first.tool.entered.promise;
    const steered = await send(first.app("steer"), conv.id, { content: "STEER_AFTER_RESTART" });
    const queued = await send(first.app("queue"), conv.id, { content: "QUEUE_AFTER_RESTART" });
    expect(steered.body.action).toBe("steered");
    expect(queued.body.action).toBe("queued");
    // Close while the tool still holds; the release after close lets the in-flight call settle harmlessly.
    const closing = first.harness.close(context);
    first.release();
    await closing;
    first = undefined;
    second = await rig(dbPath, ["tool", "text", "text", "text", "text"]);
    const h: Harness = second.harness;
    second.release();
    for (const sent of [steered, queued]) {
      const sub = await h.submission(sent.body.submissionId as never, context);
      expect(sub).toBeTruthy() /* "the admitted submission survived the restart" */;
      expect((await sub.wait(context)).status).toBe("done");
    }
    const all = second.requests.join("\n");
    expect(all.split("STEER_AFTER_RESTART").length - 1 > 0).toBe(true);
    const lastSteer = second.requests.findIndex(request => request.includes("STEER_AFTER_RESTART"));
    const firstQueue = second.requests.findIndex(request => request.includes("QUEUE_AFTER_RESTART"));
    expect(lastSteer >= 0 && firstQueue > lastSteer).toBeTruthy() /* "the steer is placed before the queued turn starts" */;
    expect(second.requests.filter(request => userTexts(request).some(text => text.includes("QUEUE_AFTER_RESTART"))).length >= 1).toBe(true);
  } finally {
    first?.release(); second?.release();
    await first?.harness.close(context); await second?.harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

for (const mode of ["queue", "steer"] as const) {
  test(`cancel ${mode}: scoped, idempotent withdrawal leaves the current run and other inputs intact`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-cancel-input-"));
    const r = await rig(join(dir, "luna.db"), ["hold", "text"]);
    try {
      const conv = await r.harness.createConversation({ ownership: { kind: "ownerless" }, agent: r.agent }, context);
      const foreign = await r.harness.createConversation({ ownership: { kind: "ownerless" }, agent: r.agent }, context);
      const original = await conv.submit({ type: "input", content: "work" }, context);
      await r.model.entered.promise;
      const app = r.app(mode);
      const pending = await send(app, conv.id, { content: "CANCEL_SENTINEL" });
      const survivor = await send(r.app("steer"), conv.id, { content: "SURVIVOR_SENTINEL" });
      const cancel = (session: string | number, submission: string | number) => app.request(
        `/v1/sessions/${session}/submissions/${submission}/cancel`, { method: "POST" });
      expect((await cancel(foreign.id, pending.body.submissionId!)).status).toBe(404);
      expect((await cancel(conv.id, "999999999")).status).toBe(404);
      expect((await cancel(conv.id, original.id)).status).toBe(409) /* "placed input cannot be cancelled" */;
      const response = await cancel(conv.id, pending.body.submissionId!);
      expect(response.status).toBe(200);
      expect((await response.json() as { cancelled: boolean }).cancelled).toBe(true);
      expect((await cancel(conv.id, pending.body.submissionId!)).status).toBe(200) /* "lost responses can retry" */;
      const withdrawn = await r.harness.submission(pending.body.submissionId as never, context);
      const record = await withdrawn!.status(context);
      expect(record.status).toBe("unanswered");
      expect(record.reason).toBe("aborted");
      expect(record.entry).toBe(undefined) /* "cancelled input never entered context" */;
      expect((await original.status(context)).status).toBe("placed") /* "current run remains active" */;
      r.release();
      expect((await original.wait(context)).status).toBe("done");
      expect((await (await r.harness.submission(survivor.body.submissionId as never, context))!.wait(context)).status).toBe("done");
      expect(r.model.aborted).toBe(false);
      expect(r.requests.join("\n")).not.toMatch(/CANCEL_SENTINEL/);
      expect(r.requests[1]!).toMatch(/SURVIVOR_SENTINEL/);
      expect((await cancel(conv.id, survivor.body.submissionId!)).status).toBe(409) /* "settled delivered input cannot be cancelled" */;
    } finally {
      r.release(); await r.harness.close(context); rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
}
