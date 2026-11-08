// Contract: Send now reaches the current tool boundary even with an active child.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openLuna, context } from "../src/luna.js";
import { Children } from "../src/delegate-state.js";
import { interruptBlocked } from "../src/busy-input.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("Send now steers after tools while a child remains active, without losing either submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-send-now-"));
  const entered = { parent: gate(), child: gate() };
  const finish = { parent: gate(), child: gate() };
  const faux = fauxProvider({ models: [{ id: "parent" }, { id: "child" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = { parent: 0, child: 0 };
  const requests: string[] = [];
  faux.setResponses(Array.from({ length: 8 }, () => (request, _options, _state, model) => {
    const who = model.id as "parent" | "child";
    if (calls[who]++ === 0)
      return fauxAssistantMessage([fauxToolCall("hold", { who })], { stopReason: "toolUse" });
    if (who === "parent") requests.push(JSON.stringify(request.messages));
    return fauxAssistantMessage([fauxText("finished")]);
  }));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false,
    extensions: [defineExtension({ name: "hold", tools: [defineTool({
      name: "hold", description: "Hold a tool boundary.", parameters: Type.Object({ who: Type.Union([Type.Literal("parent"), Type.Literal("child")]) }),
      async execute({ who }) {
        entered[who].release();
        await finish[who].promise;
        return { output: [{ type: "text", text: "tool finished" }] };
      },
    })] })],
  });
  try {
    const parentModel = faux.getModel("parent")!;
    const childModel = faux.getModel("child")!;
    const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: parentModel.provider, modelId: parentModel.id } } }, context);
    const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: childModel.provider, modelId: childModel.id } } }, context);
    await harness.commit(async tx => {
      (await tx.doc(Children, parent.id)).children.push({ id: Number(child.id), spawnKey: "child", task: "work" });
    }, context);
    const original = await parent.submit({ type: "input", content: "work" }, context);
    const childRun = await child.submit({ type: "input", content: "work" }, context);
    await Promise.all([entered.parent.promise, entered.child.promise]);
    const queued = await parent.submit({ type: "input", content: "CORRECTION_SENTINEL", whenBusy: "followUp" }, context);
    assert.equal((await queued.status(context)).status, "queued");
    const app = createApp({ harness, conversations: new ConversationStore(harness), models,
      agent: { model: { provider: parentModel.provider, modelId: parentModel.id } },
    });
    const response = await app.request(`/v1/sessions/${parent.id}/submissions/${queued.id}/send-now`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "CORRECTION_SENTINEL" }),
    });
    assert.equal(response.status, 202);
    const receipt = await response.json() as { action: string; submissionId: string };
    assert.equal(receipt.action, "steered", "active children must not requeue a tool-boundary correction");
    const promoted = await harness.submission(receipt.submissionId as never, context);
    assert.ok(promoted);
    finish.parent.release();
    assert.equal((await promoted.wait(context)).status, "done");
    assert.equal((await original.wait(context)).status, "done");
    assert.equal(requests.length, 1, "correction belongs to the original run, not a later turn");
    assert.match(requests[0]!, /CORRECTION_SENTINEL/);
    assert.equal((await childRun.status(context)).status, "placed", "promotion must not stop the child");
    assert.equal(await harness.commit(tx => interruptBlocked(tx, parent.id), context), true,
      "without a tool boundary, active children still block cancellation");
    finish.child.release();
    assert.equal((await childRun.wait(context)).status, "done");
  } finally {
    finish.parent.release(); finish.child.release();
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
