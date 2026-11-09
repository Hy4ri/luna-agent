import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(release => { resolve = release; });
  return { promise, resolve };
}

// Protect the HTTP busy-policy exception, not Pi's configuration implementation.
test("busy sessions accept thinking-only changes without interrupting the run; model and instruction changes stay blocked", async () => {
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
    // null resets to the model default; with no settings that is medium, never off.
    assert.equal((await patch({ thinkingLevel: null })).status, 200);
    assert.equal((await conv.agent(context)).thinkingLevel, "medium");
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

// The draft UI needs the same default as POST /v1/sessions before any message exists.
test("model catalog exposes the live new-session reasoning default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-thinking-default-"));
  const faux = fauxProvider({ models: [{ id: "thinking", reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel("thinking")!;
  const ref = { provider: model.provider, modelId: model.id };
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  try {
    const app = createApp({ harness, models, agent: { model: ref, thinkingLevel: "high" } });
    assert.equal((await (await app.request("/v1/models")).json() as { defaultThinkingLevel: string }).defaultThinkingLevel, "high");
    const unset = createApp({ harness, models, agent: { model: ref } });
    assert.equal((await (await unset.request("/v1/models")).json() as { defaultThinkingLevel: string }).defaultThinkingLevel, "medium");
    const settings = new SettingsStore(join(dir, "config.json"), dir);
    const live = createApp({ harness, models, settings, agent: { model: ref, thinkingLevel: "high" } });
    // The faux model maps no max level, so a max setting clamps to high in both places.
    for (const [level, effective] of [["max", "high"], ["minimal", "minimal"], ["off", "off"]] as const) {
      settings.update(s => { s.thinkingLevel = level; });
      assert.equal((await (await live.request("/v1/models")).json() as { defaultThinkingLevel: string }).defaultThinkingLevel, effective);
      const created = await live.request("/v1/sessions", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      assert.equal(created.status, 201);
      const { id } = await created.json() as { id: number };
      const session = await (await live.request(`/v1/sessions/${id}?view=ui`)).json() as { agent: { thinkingLevel: string } };
      assert.equal(session.agent.thinkingLevel, effective, "empty session and catalog must agree");
    }
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each catalog entry names its levels and its start level; sessions store only levels the model runs.
test("reasoning levels follow the model: catalog, per-model defaults, and clamping on change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-thinking-clamp-"));
  const faux = fauxProvider({ models: [{ id: "thinking", reasoning: true }, { id: "plain", reasoning: false }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const thinking = { provider: faux.provider.id, modelId: "thinking" };
  const plain = { provider: faux.provider.id, modelId: "plain" };
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  try {
    const settings = new SettingsStore(join(dir, "config.json"), dir);
    settings.update(s => {
      s.thinkingLevel = "low";
      s.modelThinkingLevels = { [`${thinking.provider}/${thinking.modelId}`]: "high" };
    });
    const app = createApp({ harness, models, settings, conversations: new ConversationStore(harness), agent: { model: thinking } });
    const catalog = await (await app.request("/v1/models")).json() as {
      models: { id: string; thinkingLevels: string[]; defaultThinkingLevel: string }[];
    };
    const entry = (id: string) => catalog.models.find(m => m.id === id)!;
    assert.deepEqual(entry("thinking").thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
    assert.equal(entry("thinking").defaultThinkingLevel, "high", "the per-model default wins over the global one");
    assert.deepEqual(entry("plain").thinkingLevels, ["off"]);
    assert.equal(entry("plain").defaultThinkingLevel, "off");

    const create = async (body: object) => {
      const r = await app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(r.status, 201);
      return (await r.json() as { id: number }).id;
    };
    const level = async (id: number) => (await (await harness.conversation(id as never, context))!.agent(context)).thinkingLevel;
    assert.equal(await level(await create({})), "high");
    assert.equal(await level(await create({ model: thinking, thinkingLevel: "max" })), "high", "an unsupported request clamps");
    assert.equal(await level(await create({ model: plain, thinkingLevel: "high" })), "off");

    const id = await create({ model: thinking, thinkingLevel: "minimal" });
    const patch = async (body: object) => {
      const r = await app.request(`/v1/sessions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(r.status, 200);
      return (await r.json() as { thinkingLevel: string }).thinkingLevel;
    };
    assert.equal(await patch({ thinkingLevel: "xhigh" }), "high", "PATCH returns the stored, clamped level");
    assert.equal(await level(id), "high");
    assert.equal(await patch({ model: plain }), "off", "a model switch clamps the kept level");
    settings.update(s => { s.modelThinkingLevels = {}; });
    assert.equal(await patch({ model: thinking }), "off", "the kept level survives a switch back when no per-model default exists");
    assert.equal(await patch({ thinkingLevel: null }), "low", "null resets to the global default");
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
