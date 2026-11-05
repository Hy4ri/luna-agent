import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

// Protect the HTTP busy-policy exception, not Pi's configuration implementation.
test("busy sessions accept thinking-only changes without interrupting the run; model and instruction changes stay blocked", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-thinking-http-"));
  const entered = gate();
  const finish = gate();
  const faux = fauxProvider({ models: [{ id: "thinking", reasoning: true }] });
  const requests: (string | undefined)[] = [];
  faux.setResponses([
    (_request, options) => {
      requests.push(options?.reasoning);
      return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
    },
    (_request, options) => {
      requests.push(options?.reasoning);
      return fauxAssistantMessage("finished");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel("thinking")!;
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false,
    extensions: [defineExtension({ name: "hold", tools: [defineTool({
      name: "hold", description: "Hold a tool boundary.", parameters: Type.Object({}),
      async execute() {
        entered.resolve();
        await finish.promise;
        return { output: [{ type: "text", text: "tool finished" }] };
      },
    })] })],
  });
  try {
    const ref = { provider: model.provider, modelId: model.id };
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref, thinkingLevel: "low" } }, context);
    const app = createApp({ harness, conversations: new ConversationStore(harness), models });
    const patch = (body: object) => app.request(`/v1/sessions/${conv.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const run = await conv.submit({ type: "input", content: "work" }, context);
    await entered.promise;
    assert.equal((await patch({ thinkingLevel: "high" })).status, 200);
    assert.equal((await conv.agent(context)).thinkingLevel, "high");
    for (const body of [{ model: ref }, { instructions: "changed" }, { thinkingLevel: "max", model: null }, { thinkingLevel: "max", instructions: null }]) {
      assert.equal((await patch(body)).status, 409);
    }
    assert.equal((await patch({ thinkingLevel: "invalid" })).status, 400);
    assert.equal((await patch({ thinkingLevel: "" })).status, 400);
    assert.equal((await patch({ thinkingLevel: null })).status, 200);
    assert.equal((await conv.agent(context)).thinkingLevel, "off");
    assert.equal((await patch({ thinkingLevel: "high" })).status, 200);
    assert.equal((await run.status(context)).status, "placed", "configuration must not stop the run");
    finish.resolve();
    assert.equal((await run.wait(context)).status, "done");
    assert.deepEqual(requests, ["low", "high"], "the next model request uses the saved level in the same run");
    assert.equal((await patch({ instructions: "idle change" })).status, 200);
  } finally {
    finish.resolve();
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
