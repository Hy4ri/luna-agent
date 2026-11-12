// Merged action tools must register through startRuntime and run end to end with a scripted model.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";

const OLD = /^(browser_tab|browser_inspect|skill_view|skill_manage|web_search|web_extract|cron_history|vision_analyze|video_analyze|cron_(create|list|get|update|toggle|remove|run|stop|runs|run_get)|inspect_runs|extract_lessons|create_goal|get_goal|update_goal|set_goal_tasks|update_goal_task|learn_review|lesson_(capture|record|assess|propose|observe|dismiss)|skill_(list|propose|rollback)|process|process_start|browser_(open|navigate|close|snapshot|screenshot|click|type|scroll)|remember|recall|forget)$/;

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
    ["cron", { action: "runs" }],
    ["cron", { action: "list" }],
    ["skill", { action: "list" }],
    ["tool_search", { query: "policy" }],
    ["media_analyze", { source: "clip.mp4", question: "what happens?", use_active_model: true }],
    ["skill", { action: "view", name: "no-such-skill" }],
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
    rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["coding", "memory", "skills", "cron", "goal", "tool-search"] }), { models, model: modelRef });
    const session = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef } }, context);
    const run = await (await session.submit({ type: "input", content: "exercise merged tools" }, context)).wait(context);
    expect(run.status).toBe("done");

    for (const name of ["memory", "goal", "cron", "skill", "web", "process_manage"]) expect(toolNames.includes(name)).toBeTruthy() /* `${name} missing from ${toolNames.join(",")}` */;
    expect(toolNames.filter(n => OLD.test(n))).toEqual([]);

    const results = (await session.entries({}, 200, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    results.sort((a, b) => a.timestamp - b.timestamp);
    expect(results.length).toBe(calls.length);
    const out = results.map(r => ({ name: r.toolName, error: r.isError, text: r.content.filter(b => b.type === "text").map(b => b.text).join("\n") }));
    const by = (i: number) => out[i]!;
    expect(by(0).error).toBe(false); expect(by(0).text).toMatch(/test\.fact|saved|#\d+/i);
    expect(by(1).error).toBe(false); expect(by(1).text).toMatch(/scratch fact/);
    expect(by(2).error).toBe(true);
    expect(by(3).error).toBe(false);
    expect(by(4).error).toBe(false); expect(by(4).text).toMatch(/scratch objective/);
    expect(by(5).error).toBe(true); expect(by(5).text).toMatch(/update_task needs/);
    for (const i of [6, 7, 8, 9, 10]) expect(by(i).error).toBe(false) /* `${by(i).name}: ${by(i).text}` */;
    expect(by(11).error).toBe(true); expect(by(11).text).toMatch(/apply to images only/);
    expect(by(12).error).toBe(true); expect(by(12).text).toMatch(/Unknown skill "no-such-skill"/);
  } finally {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

