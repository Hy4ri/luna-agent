// Contract: delegation removes Luna's personal identity, not task policy or forked task history.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";

for (const fork of [false, true]) {
  test(`${fork ? "forked" : "fresh"} subagent has a neutral identity and delivers its result`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-delegate-"));
    writeFileSync(join(dir, "SOUL.md"), "PERSONA_SENTINEL: You are Luna, the user's wife.");
    writeFileSync(join(dir, "USER.md"), "USER_SENTINEL");
    writeFileSync(join(dir, "MEMORY.md"), "MEMORY_SENTINEL");
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
        case 0: return fauxAssistantMessage([fauxToolCall("delegate_task", { action: "spawn", task: "Return an empty receipt.", fork, ...(fork ? { profile: "worker" } : {}) })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("delegate_task", { action: "wait" })], { stopReason: "toolUse" });
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
      assert.equal(run.status, "done");
      assert.equal(childPrompts.length, 2, "child must execute and report through the real delegate tool");
      for (const prompt of childPrompts) {
        assert.doesNotMatch(prompt, /PERSONA_SENTINEL|USER_SENTINEL|MEMORY_SENTINEL/);
        assert.match(prompt, /task-focused subagent/);
        assert.match(prompt, /TASK_POLICY: Never publish without approval/);
        if (fork) assert.match(prompt, /Implement only the assigned scope/);
      }
      assert.ok(parentPrompts.every(prompt => prompt.includes("PERSONA_SENTINEL")), "top-level identity must remain unchanged");
      assert.equal(childHistories[0]!.includes("PARENT_HISTORY_SENTINEL"), fork, "forked task history is preserved");
      const entries = (await session.entries({}, 50, undefined, context)).items;
      const results = entries.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
      assert.match(JSON.stringify(results), /child delivered/);
      assert.match(JSON.stringify(results), /validated result/);
    } finally {
      await rt?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
