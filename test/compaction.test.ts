// Contract: live host limits govern every model preparation, with durable delegate identity and model safety clamps.
// A regression to capacity-only thresholds sends an oversized request instead of starting/waiting for compaction.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { nativeCompaction } from "../src/compaction-limits.js";
import { Children, readChildReport } from "../src/delegate-state.js";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const scenario of [
  { name: "session below its threshold", tokens: 90000, blocking: false, child: false, capacity: 1000000, below: true },
  { name: "session background", tokens: 130000, blocking: false, child: false, capacity: 1000000 },
  { name: "session blocking", tokens: 170000, blocking: true, child: false, capacity: 1000000 },
  { name: "delegate background", tokens: 90000, blocking: false, child: true, capacity: 1000000 },
  { name: "delegate blocking", tokens: 130000, blocking: true, child: true, capacity: 1000000 },
  { name: "small-model background safety", tokens: 85000, blocking: false, child: false, capacity: 128000 },
  { name: "small-model blocking safety", tokens: 115000, blocking: true, child: false, capacity: 128000 },
]) {
  test(scenario.name, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-compaction-"));
    const faux = fauxProvider({ models: [{ id: "large", contextWindow: scenario.capacity }] });
    const models = createModels(); models.setProvider(faux.provider);
    const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
    const summaryStarted = signal();
    const answerStarted = signal();
    const releaseSummary = signal();
    const calls: string[] = [];
    const respond: FauxResponseFactory = async request => {
      if (getCurrentSystemPrompt(request.messages).includes("You are a context summarization assistant")) {
        calls.push("summary"); summaryStarted.resolve();
        await releaseSummary.promise;
        return fauxAssistantMessage("## Goal\nContinue the assigned task.\n## Progress\nOld history summarized.");
      }
      if (scenario.blocking) assert.match(JSON.stringify(request.messages), /Old history summarized/, "the resumed request must include the placed summary");
      calls.push("answer"); answerStarted.resolve();
      return fauxAssistantMessage("done");
    };
    faux.setResponses(Array.from({ length: 10 }, () => respond));
    let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
    try {
      rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: [] }), { models, model: ref });
      // A delegate child stores the subagent limits in its agent state, as delegate.ts does at spawn.
      const subagents = parseConfig({ dataDir: dir, cwd: dir }).compaction.subagents;
      const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref, ...(scenario.child ? { compaction: nativeCompaction(subagents, [model]) } : {}) } }, context);
      await rt.harness.commit(async tx => {
        // Multiple old message boundaries provide an eligible prefix while retaining the recent 20k tokens.
        for (let tokens = 0; tokens < scenario.tokens; tokens += 5000) {
          await tx.appendEntry(conv.id, { kind: "test.history", model: [{ role: "user", content: "x".repeat(20000), timestamp: 1 }] });
        }
      }, context);
      const submitted = await conv.submit({ type: "input", content: "Continue." }, context);
      if ("below" in scenario) {
        assert.equal((await submitted.wait(context)).status, "done");
        assert.deepEqual(calls, ["answer"], "large-window sessions must not use the lower delegate threshold");
        return;
      }
      await summaryStarted.promise;
      if (scenario.blocking) assert.deepEqual(calls, ["summary"], "generation must wait, not send the large request");
      else await answerStarted.promise; // A background summary must not prevent the answer.
      releaseSummary.resolve();
      assert.equal((await submitted.wait(context)).status, "done");
      assert.ok(calls.includes("answer"));
    } finally {
      releaseSummary.resolve();
      await rt?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
}

test("external settings changes apply to an existing session on its next preparation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-compaction-settings-"));
  const configPath = join(dir, "luna.config.json");
  const initial = { dataDir: dir, cwd: dir, extensions: [], compaction: { sessions: { backgroundAtTokens: 200000, blockAtTokens: 240000 } } };
  writeFileSync(configPath, JSON.stringify(initial));
  const faux = fauxProvider({ models: [{ id: "large", contextWindow: 1000000 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
  const calls: string[] = [];
  const respond: FauxResponseFactory = request => {
    const summary = getCurrentSystemPrompt(request.messages).includes("You are a context summarization assistant");
    calls.push(summary ? "summary" : "answer");
    return fauxAssistantMessage(summary ? "Summary of earlier work." : "done");
  };
  faux.setResponses(Array.from({ length: 10 }, () => respond));
  let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    rt = await startRuntime({ ...parseConfig(initial), configPath }, { models, model: ref });
    const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    await rt.harness.commit(async tx => {
      for (let i = 0; i < 18; i++) await tx.appendEntry(conv.id, { kind: "test.history", model: [{ role: "user", content: "x".repeat(20000), timestamp: 1 }] });
    }, context);
    // Lower the blocking limit below the existing 90k context without reopening the runtime or conversation.
    writeFileSync(configPath, JSON.stringify({ ...initial, compaction: { sessions: { backgroundAtTokens: 60000, blockAtTokens: 80000 } } }));
    assert.equal((await (await conv.submit({ type: "input", content: "Continue." }, context)).wait(context)).status, "done");
    assert.deepEqual(calls.slice(0, 2), ["summary", "answer"]);
    assert.ok((await conv.entries({}, 100, undefined, context)).items.some(entry => entry.kind === "pi.compaction"));
  } finally { await rt?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 10000);

test("a real forked delegate compacts inherited history below its parent's threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-compaction-fork-"));
  const faux = fauxProvider({ models: [{ id: "parent", contextWindow: 1000000 }, { id: "child", contextWindow: 1000000 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel("parent")!, ref = { provider: model.provider, modelId: model.id };
  const summaries: string[] = [];
  let parentCalls = 0, childCalls = 0;
  const respond: FauxResponseFactory = (request, _options, _state, selected) => {
    if (getCurrentSystemPrompt(request.messages).includes("You are a context summarization assistant")) {
      summaries.push(selected.id);
      return fauxAssistantMessage("Earlier inherited work is summarized. Return the assigned receipt.");
    }
    if (selected.id === "child") return childCalls++ === 0
      ? fauxAssistantMessage([fauxToolCall("delegate_result", { value: { commit_sha: null, pr_url: null, files_changed: [], blocked_on: null } })], { stopReason: "toolUse" })
      : fauxAssistantMessage("child done");
    if (parentCalls++ === 0) return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", fork: true, task: "Return an empty receipt." })], { stopReason: "toolUse" });
    if (parentCalls === 2) return fauxAssistantMessage([fauxToolCall("subagent", { action: "wait" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("parent done");
  };
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["delegate"], subagents: { provider: model.provider, model: "child" } }), { models, model: ref });
    const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: ref } }, context);
    await rt.harness.commit(async tx => {
      for (let i = 0; i < 18; i++) await tx.appendEntry(conv.id, { kind: "test.history", model: [{ role: "user", content: "x".repeat(20000), timestamp: 1 }] });
    }, context);
    assert.equal((await (await conv.submit({ type: "input", content: "Delegate the work." }, context)).wait(context)).status, "done");
    assert.ok(summaries.includes("child"), "the fork must inherit history and use the lower delegate threshold");
    assert.ok(!summaries.includes("parent"), "the parent must retain the higher session threshold");
    const children = await rt.harness.snapshot(Children, conv.id, context);
    assert.equal(children?.children.length, 1);
    const child = children!.children[0]!;
    const report = await rt.harness.commit(tx => readChildReport(tx, conv.id, child.id), context);
    assert.equal(report.resultStatus, "valid", "compaction must not lose the delegate result contract");
  } finally { await rt?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 10000);
