// Contract: delegation removes Luna's personal identity, not task policy or forked task history.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";

for (const fork of [false, true]) {
  test(`${fork ? "forked" : "fresh"} subagent has a neutral identity and delivers its result`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-delegate-"));
    writeFileSync(join(dir, "SOUL.md"), "PERSONA_SENTINEL: You are Luna, the user's steward.");
    const faux = fauxProvider({ models: [{ id: "parent" }, { id: "child" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parentModel = faux.getModel("parent")!;
    const modelRef = { provider: parentModel.provider, modelId: parentModel.id };
    let parentCalls = 0, childCalls = 0;
    const childPrompts: string[] = [], parentPrompts: string[] = [];
    const childHistories: string[] = [];
    const respond: FauxResponseFactory = (request, _options, _state, model) => {
      const prompt = getCurrentSystemPrompt(request.messages);
      if (model.id === "child") {
        childPrompts.push(prompt);
        childHistories.push(JSON.stringify(request.messages.filter(m => m.role !== "system")));
        return childCalls++ === 0
          ? fauxAssistantMessage([fauxToolCall("delegate_result", { value: { commit_sha: null, pr_url: null, files_changed: [], blocked_on: null } })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxText("child delivered")]);
      }
      parentPrompts.push(prompt);
      switch (parentCalls++) {
        case 0: return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", task: "Return an empty receipt.", fork, ...(fork ? { profile: "worker" } : {}) })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("subagent", { action: "wait" })], { stopReason: "toolUse" });
        default: return fauxAssistantMessage([fauxText("parent finished")]);
      }
    };
    faux.setResponses(Array.from({ length: 12 }, () => respond));
    let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
    try {
      rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["coding", "delegate", "skills"],
        subagents: { provider: parentModel.provider, model: "child" },
      }), { models, model: modelRef });
      const session = await rt.harness.createConversation({ ownership: { kind: "ownerless" },
        agent: { model: modelRef, instructions: "TASK_POLICY: Never publish without approval." },
      }, context);
      const run = await (await session.submit({ type: "input", content: "PARENT_HISTORY_SENTINEL: Delegate this task." }, context)).wait(context);
      expect(run.status).toBe("done");
      expect(childPrompts.length).toBe(2) /* "child must execute and report through the real delegate tool" */;
      for (const prompt of childPrompts) {
        expect(prompt).not.toMatch(/PERSONA_SENTINEL/);
        expect(prompt).toMatch(/task-focused subagent/);
        expect(prompt).toMatch(/TASK_POLICY: Never publish without approval/);
        if (fork) expect(prompt).toMatch(/Implement only the assigned scope/);
      }
      expect(parentPrompts.every(prompt => prompt.includes("PERSONA_SENTINEL"))).toBeTruthy() /* "top-level identity must remain unchanged" */;
      expect(childHistories[0]!.includes("PARENT_HISTORY_SENTINEL")).toBe(fork) /* "forked task history is preserved" */;
      const entries = (await session.entries({}, 50, undefined, context)).items;
      const results = entries.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
      expect(JSON.stringify(results)).toMatch(/child delivered/);
      expect(JSON.stringify(results)).toMatch(/validated result/);
    } finally {
      await rt?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Large catalogs (#531): a child's agent state holds compaction limits for its own model, not the whole catalog.
test("subagent compaction state covers only the child's model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-delegate-compaction-"));
  const extra = Array.from({ length: 200 }, (_, i) => ({ id: `extra-${i}`, contextWindow: 200_000 }));
  const faux = fauxProvider({ models: [{ id: "parent" }, { id: "child", contextWindow: 200_000 }, ...extra] });
  const models = createModels();
  models.setProvider(faux.provider);
  const parentModel = faux.getModel("parent")!;
  const modelRef = { provider: parentModel.provider, modelId: parentModel.id };
  let parentCalls = 0;
  const respond: FauxResponseFactory = (_request, _options, _state, model) => {
    if (model.id === "child") return fauxAssistantMessage([fauxText("child done")]);
    return parentCalls++ === 0
      ? fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", task: "Say done." })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("parent finished")]);
  };
  faux.setResponses(Array.from({ length: 8 }, () => respond));
  let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["coding", "delegate"],
      subagents: { provider: parentModel.provider, model: "child" },
    }), { models, model: modelRef });
    const session = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef } }, context);
    const run = await (await session.submit({ type: "input", content: "Delegate." }, context)).wait(context);
    expect(run.status).toBe("done");
    const entries = (await session.entries({}, 50, undefined, context)).items;
    const spawned = JSON.stringify(entries.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult")).match(/spawned child (\S+?)(?:\\| |")/);
    expect(spawned).toBeTruthy(); /* "spawn result names the child" */
    const child = await rt.harness.conversation(spawned![1] as never, context);
    expect(child).toBeTruthy(); /* "child conversation exists" */
    const overrides = (await child!.agent(context)).compaction?.modelOverrides ?? {};
    expect(Object.keys(overrides)).toEqual([`${parentModel.provider}/child`]);
  } finally {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
