import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
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
    expect((await patch({ thinkingLevel: "high" })).status).toBe(200);
    expect((await conv.agent(context)).thinkingLevel).toBe("high");
    for (const body of [{ model: ref }, { instructions: "changed" }, { thinkingLevel: "max", model: null }, { thinkingLevel: "max", instructions: null }]) {
      expect((await patch(body)).status).toBe(409);
    }
    expect((await patch({ thinkingLevel: "invalid" })).status).toBe(400);
    expect((await patch({ thinkingLevel: "" })).status).toBe(400);
    // null resets to the model default; with no settings that is medium, never off.
    expect((await patch({ thinkingLevel: null })).status).toBe(200);
    expect((await conv.agent(context)).thinkingLevel).toBe("medium");
    expect((await patch({ thinkingLevel: "high" })).status).toBe(200);
    expect((await run.status(context)).status).toBe("placed") /* "configuration must not stop the run" */;
    finish.resolve();
    expect((await run.wait(context)).status).toBe("done");
    expect(requests).toEqual(["low", "high"]) /* "the next model request uses the saved level in the same run" */;
    expect((await patch({ instructions: "idle change" })).status).toBe(200);
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
    expect((await (await app.request("/v1/models")).json() as { defaultThinkingLevel: string }).defaultThinkingLevel).toBe("high");
    const unset = createApp({ harness, models, agent: { model: ref } });
    expect((await (await unset.request("/v1/models")).json() as { defaultThinkingLevel: string }).defaultThinkingLevel).toBe("medium");
    const settings = new SettingsStore(join(dir, "config.json"), dir);
    const live = createApp({ harness, models, settings, agent: { model: ref, thinkingLevel: "high" } });
    // The faux model maps no max level, so a max setting clamps to high in both places.
    for (const [level, effective] of [["max", "high"], ["minimal", "minimal"], ["off", "off"]] as const) {
      settings.update(s => { s.thinkingLevel = level; });
      expect((await (await live.request("/v1/models")).json() as { defaultThinkingLevel: string }).defaultThinkingLevel).toBe(effective);
      const created = await live.request("/v1/sessions", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(created.status).toBe(201);
      const { id } = await created.json() as { id: number };
      const session = await (await live.request(`/v1/sessions/${id}?view=ui`)).json() as { agent: { thinkingLevel: string } };
      expect(session.agent.thinkingLevel).toBe(effective) /* "empty session and catalog must agree" */;
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
  let catalogReads = 0;
  models.setProvider({ ...faux.provider, getModels: () => {
    catalogReads++;
    return faux.provider.getModels();
  } });
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
    catalogReads = 0;
    const catalog = await (await app.request("/v1/models")).json() as {
      models: { id: string; thinkingLevels: string[]; defaultThinkingLevel: string }[];
    };
    expect(catalogReads <= 2).toBeTruthy() /* `catalog projection must not rebuild the provider catalog for each model (read ${catalogReads} times)` */;
    const entry = (id: string) => catalog.models.find(m => m.id === id)!;
    expect(entry("thinking").thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(entry("thinking").defaultThinkingLevel).toBe("high") /* "the per-model default wins over the global one" */;
    expect(entry("plain").thinkingLevels).toEqual(["off"]);
    expect(entry("plain").defaultThinkingLevel).toBe("off");

    const create = async (body: object) => {
      const r = await app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(r.status).toBe(201);
      return (await r.json() as { id: number }).id;
    };
    const level = async (id: number) => (await (await harness.conversation(id as never, context))!.agent(context)).thinkingLevel;
    expect(await level(await create({}))).toBe("high");
    expect(await level(await create({ model: thinking, thinkingLevel: "max" }))).toBe("high") /* "an unsupported request clamps" */;
    expect(await level(await create({ model: plain, thinkingLevel: "high" }))).toBe("off");

    const id = await create({ model: thinking, thinkingLevel: "minimal" });
    const patch = async (body: object) => {
      const r = await app.request(`/v1/sessions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(r.status).toBe(200);
      return (await r.json() as { thinkingLevel: string }).thinkingLevel;
    };
    expect(await patch({ thinkingLevel: "xhigh" })).toBe("high") /* "PATCH returns the stored, clamped level" */;
    expect(await level(id)).toBe("high");
    expect(await patch({ model: plain })).toBe("off") /* "a model switch clamps the kept level" */;
    settings.update(s => { s.modelThinkingLevels = {}; });
    expect(await patch({ model: thinking })).toBe("off") /* "the kept level survives a switch back when no per-model default exists" */;
    expect(await patch({ thinkingLevel: null })).toBe("low") /* "null resets to the global default" */;
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
