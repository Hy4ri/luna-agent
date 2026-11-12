import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { conversationStorage } from "../src/conversation-storage.js";
import { scanAnalyticsSession } from "../src/analytics/source.js";

test("source reads measured message durations and settles a tool across incremental boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-measurements-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await harness.commit(tx => tx.appendEntry(conv.id, {
      kind: "pi.assistant", model: [{ role: "assistant", provider: "test", model: "model", api: "openai-completions", durationMs: 321, timestamp: 1000, stopReason: "toolUse", content: [{ type: "toolCall", id: "call-A", name: "bash", arguments: { command: "private args" } }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }],
    }), context);
    const db = conversationStorage(harness).db;
    const first = scanAnalyticsSession(db, Number(conv.id))!;
    expect(first.facts.find(f => f.kind === "response")?.durationMs).toBe(321);
    expect(first.facts.find(f => f.kind === "tool")?.durationMs).toBe(null);
    await harness.commit(tx => tx.appendEntry(conv.id, {
      kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "call-A", toolName: "bash", content: [{ type: "text", text: "private output" }], isError: true, durationMs: 43, timestamp: 3000 }],
    }), context);
    const next = scanAnalyticsSession(db, Number(conv.id), first.session)!;
    const tool = next.facts.find(f => f.kind === "tool");
    expect(tool).toBeTruthy() /* "a late tool result must update the stored tool fact" */;
    expect(tool!.durationMs).toBe(43) /* "never subtract timestamps to invent tool execution duration" */;
    expect(tool!.error).toBe(true);
    expect(tool!.model).toBe("test/model");
    expect(JSON.stringify(next).includes("private output")).toBe(false);
    expect(JSON.stringify(next).includes("private args")).toBe(false);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});
