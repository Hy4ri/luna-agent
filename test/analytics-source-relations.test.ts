import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { UsageDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { conversationStorage } from "../src/conversation-storage.js";
import { Children } from "../src/delegate-state.js";
import { scanAnalyticsSession } from "../src/analytics/source.js";

test("scanAnalyticsSession preserves UsageDoc per-model ledger including compaction-only usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-rel-usage-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await harness.commit(async tx => {
      await tx.appendEntry(conv.id, {
        kind: "pi.assistant",
        model: [{
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4",
          api: "anthropic-messages",
          timestamp: 1000,
          stopReason: "stop",
          content: [{ type: "text", text: "secret assistant text" }],
          usage: {
            input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
          },
        }],
      });
      const usage = await tx.doc(UsageDoc, conv.id);
      usage.models["anthropic/claude-sonnet-4"] = {
        input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      };
      // Compaction-only model usage with no pi.assistant entry
      usage.models["openai/gpt-4o-mini"] = {
        input: 30, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 35,
        cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
      };
    }, context);

    const db = conversationStorage(harness).db;
    const scan = scanAnalyticsSession(db, Number(conv.id));
    expect(scan).toBeTruthy();
    expect(scan!.session.usage.totalTokens).toBe(215);
    expect(scan!.session.modelUsage?.["anthropic/claude-sonnet-4"]?.totalTokens).toBe(180);
    expect(scan!.session.modelUsage?.["openai/gpt-4o-mini"]?.totalTokens).toBe(35);
    expect(JSON.stringify(scan).includes("secret assistant text")).toBe(false);
  } finally {
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanAnalyticsSession reads direct codemode tool plus 2 nested SQLite tool calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-rel-nested-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await harness.commit(async tx => {
      await tx.appendEntry(conv.id, {
        kind: "pi.assistant",
        model: [{
          role: "assistant",
          provider: "test",
          model: "model",
          api: "openai-completions",
          timestamp: 1000,
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-cm", name: "codemode", arguments: { code: "secret code" } }],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }],
      });
      await tx.appendEntry(conv.id, {
        kind: "pi.tool-result",
        model: [{
          role: "toolResult",
          toolCallId: "call-cm",
          toolName: "codemode",
          content: [{ type: "text", text: "secret codemode output" }],
          isError: false,
          durationMs: 120,
          timestamp: 1200,
        }],
      });
    }, context);

    const db = conversationStorage(harness).db;
    const cid = Number(conv.id);
    // Synthesize parent task + 2 nested tool tasks & pi.tool.nested-call documents
    db.run(
      `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
       VALUES (?, ?, ?, 'terminal', 0, 0, ?)`,
      [9001, cid, JSON.stringify("pi.tool"), JSON.stringify({ id: 9001, kind: "pi.tool", startedAt: 1000, endedAt: 1200 })],
    );
    db.run(
      `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
       VALUES (?, ?, ?, 'terminal', 0, 0, ?)`,
      [9002, cid, JSON.stringify("pi.tool"), JSON.stringify({
        id: 9002,
        kind: "pi.tool",
        startedAt: 1020,
        endedAt: 1070,
        input: { kind: "nested", call: { name: "bash", arguments: { command: "secret nested cmd" } } },
      })],
    );
    db.run(
      `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
       VALUES (?, ?, ?, 'terminal', 0, 0, ?)`,
      [9003, cid, JSON.stringify("pi.tool"), JSON.stringify({
        id: 9003,
        kind: "pi.tool",
        startedAt: 1080,
        endedAt: 1130,
        input: { kind: "nested", call: { name: "skill", arguments: { action: "view", name: "git-workflows", file_path: "README.md" } } },
      })],
    );
    for (const [docId, taskId, isError] of [[9101, 9002, false], [9102, 9003, true]] as const) {
      db.run(
        `INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
         VALUES (?, ?, 0, '', 'task', 9001, 1000, NULL, '{}')`,
        [docId, JSON.stringify("pi.tool.nested-call")],
      );
      db.run(
        `INSERT INTO document_revisions (document_id, seq, kind, version, content)
         VALUES (?, 1, 'base', 1, ?)`,
        [docId, JSON.stringify({ taskId, result: { isError } })],
      );
    }

    const scan = scanAnalyticsSession(db, cid);
    expect(scan).toBeTruthy();
    const toolFacts = scan!.facts.filter(f => f.kind === "tool");
    expect(toolFacts.length).toBe(3);
    expect(toolFacts.find(f => f.name === "codemode")?.source).toBe("direct");
    const nestedBash = toolFacts.find(f => f.key === "tool:nested:9002");
    expect(nestedBash?.name).toBe("bash");
    expect(nestedBash?.source).toBe("codemode");
    expect(nestedBash?.durationMs).toBe(50);
    expect(nestedBash?.error).toBe(false);
    const nestedSkillTool = toolFacts.find(f => f.key === "tool:nested:9003");
    expect(nestedSkillTool?.name).toBe("skill");
    expect(nestedSkillTool?.error).toBe(true);
    const skillFact = scan!.facts.find(f => f.key === "skill:nested:9003");
    expect(skillFact?.name).toBe("git-workflows");
    expect(skillFact?.data.file_path).toBe("README.md");
    expect(JSON.stringify(scan).includes("secret nested cmd")).toBe(false);
    expect(JSON.stringify(scan).includes("secret codemode output")).toBe(false);
  } finally {
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanAnalyticsSession links delegated ownerless child and parent outcomes, fork ownership, model_switch, and unknown timestamps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-rel-links-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  try {
    const parent = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);

    let forkAt: { id: import("@earendil-works/pi-durable").EntryId } | undefined;
    await harness.commit(async tx => {
      // Explicit old-record fixture: historical entry without timestamp
      forkAt = await tx.appendEntry(parent.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "private parent prompt" }] as never,
      });
      await tx.appendEntry(parent.id, {
        kind: "luna.model-changed",
        data: { previous: "anthropic/claude-sonnet-4", new: "openai/gpt-4o" },
      });
      const childrenDoc = await tx.doc(Children, parent.id);
      childrenDoc.children.push({
        id: Number(child.id),
        spawnKey: "worker-1",
        task: "private child task",
        stopped: "stopped",
      });
      await tx.appendEntry(child.id, {
        kind: "delegate.child",
        data: { parent: Number(parent.id) },
      });
    }, context);

    const forked = await harness.commit(
      tx => tx.forkConversation(parent.id, forkAt!.id, { ownership: { kind: "ownerless" } }),
      context,
    );
    await harness.commit(async tx => {
      await tx.appendEntry(forked.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "private fork prompt", timestamp: 5000 }],
      });
    }, context);

    const db = conversationStorage(harness).db;

    const parentScan = scanAnalyticsSession(db, Number(parent.id));
    expect(parentScan).toBeTruthy();
    const modelSwitch = parentScan!.facts.find(f => f.kind === "model_switch");
    expect(modelSwitch).toBeTruthy();
    expect(modelSwitch!.data.previous).toBe("anthropic/claude-sonnet-4");
    expect(modelSwitch!.data.new).toBe("openai/gpt-4o");
    expect(modelSwitch!.ts).toBe(null) /* "unknown timestamps must remain null" */;
    expect(parentScan!.facts.find(f => f.kind === "turn" || f.kind === "message")?.ts ?? null).toBe(null);
    expect(JSON.stringify(parentScan).includes("private parent prompt")).toBe(false);

    const childScan = scanAnalyticsSession(db, Number(child.id));
    expect(childScan).toBeTruthy();
    const delegation = childScan!.facts.find(f => f.kind === "delegation");
    expect(delegation).toBeTruthy();
    expect(delegation!.data.sourceSessionId).toBe(Number(parent.id));
    expect(delegation!.data.targetSessionId).toBe(Number(child.id));

    const forkScan = scanAnalyticsSession(db, Number(forked.id));
    expect(forkScan).toBeTruthy();
    expect(forkScan!.session.parentId).toBe(Number(parent.id));
    expect(forkScan!.session.forkDepth).toBe(1);
    expect(forkScan!.session.userTurns).toBe(1) /* "fork must count only its own owned entries" */;
    expect(JSON.stringify(forkScan).includes("private fork prompt")).toBe(false);
  } finally {
    await harness.close(context);
    await rm(dir, { recursive: true, force: true });
  }
});
