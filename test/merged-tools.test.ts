// Merged action tools must register through startRuntime and run end to end with a scripted model.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";

const OLD = /^(cron_(create|list|get|update|toggle|remove|run|stop|runs|run_get)|inspect_runs|extract_lessons|create_goal|get_goal|update_goal|set_goal_tasks|update_goal_task|learn_review|lesson_(capture|record|assess|propose|observe|dismiss)|skill_(list|propose|rollback)|process_(start|manage)|browser_(open|navigate|close|snapshot|screenshot|click|type|scroll)|remember|recall|forget)$/;

test("merged action tools register and execute through startRuntime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-merged-tools-"));
  const calls: [string, Record<string, string | number | boolean>][] = [
    ["memory", { action: "save", content: "scratch fact", key: "test.fact" }],
    ["memory", { action: "search", query: "scratch" }],
    ["memory", { action: "forget" }],
    ["goal", { action: "create", objective: "scratch objective", audit: false, max_runs: 0 }],
    ["goal", { action: "get" }],
    ["goal", { action: "update_task" }],
    ["cron", { action: "list" }],
    ["cron_history", { action: "runs" }],
    ["cron_history", { action: "lessons" }],
    ["skill_manage", { action: "list" }],
    ["tool_search", { query: "lesson curate signal" }],
    ["lesson_curate", { action: "review" }],
    ["lesson_signal", { action: "assess" }],
  ];
  let step = 0, toolNames: string[] = [];
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: calls.length + 2 }, () => request => {
    if (step === 0) toolNames = request.messages.flatMap(m => m.role === "system" ? (m.toolsAdded ?? []).map(t => t.name) : []);
    const call = calls[step++];
    return call ? fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")]);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const modelRef = { provider: model.provider, modelId: model.id };
  let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["coding", "memory", "skills", "cron", "improve", "goal", "learn", "tool-search"] }), { models, model: modelRef });
    const session = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef } }, context);
    const run = await (await session.submit({ type: "input", content: "exercise merged tools" }, context)).wait(context);
    assert.equal(run.status, "done");

    for (const name of ["memory", "goal", "cron", "cron_history", "skill_manage", "process"]) assert.ok(toolNames.includes(name), `${name} missing from ${toolNames.join(",")}`);
    assert.deepEqual(toolNames.filter(n => OLD.test(n)), []);

    const results = (await session.entries({}, 200, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    results.sort((a, b) => a.timestamp - b.timestamp);
    assert.equal(results.length, calls.length);
    const out = results.map(r => ({ name: r.toolName, error: r.isError, text: r.content.filter(b => b.type === "text").map(b => b.text).join("\n") }));
    const by = (i: number) => out[i]!;
    assert.equal(by(0).error, false); assert.match(by(0).text, /test\.fact|saved|#\d+/i);
    assert.equal(by(1).error, false); assert.match(by(1).text, /scratch fact/);
    assert.equal(by(2).error, true);
    assert.equal(by(3).error, false);
    assert.equal(by(4).error, false); assert.match(by(4).text, /scratch objective/);
    assert.equal(by(5).error, true); assert.match(by(5).text, /update_task needs/);
    for (const i of [6, 7, 8, 9, 10, 11]) assert.equal(by(i).error, false, `${by(i).name}: ${by(i).text}`);
    assert.match(by(11).text, /"policy"/);
    assert.equal(by(12).error, true); assert.match(by(12).text, /assess needs signal_id/);
  } finally {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
