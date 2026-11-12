// Contract: the UI history view drops provider-only data but keeps everything the transcript displays.
import { test, expect } from "bun:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntryForUi } from "../src/session-history-view.js";

test("UI view drops signatures, system sections, and tool definitions; displayed content is kept", () => {
  const tool = { name: "bash", description: "x".repeat(500), parameters: {} };
  const entry = {
    id: 1, conversationId: 1, kind: "pi.assistant",
    model: [
      { role: "system", content: "", sections: { soul: "long" }, toolsAdded: [tool], toolsRemoved: [tool], timestamp: 1 },
      { role: "assistant", stopReason: "stop", timestamp: 2, content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "s".repeat(4000) },
        { type: "text", text: "answer", textSignature: "t".repeat(4000) },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ] },
    ],
  } as unknown as EntryRecord;
  const before = JSON.stringify(entry);
  const projected = projectEntryForUi(entry) as unknown as { model: Record<string, unknown>[] };
  const [system, assistant] = projected.model;
  expect(system).toEqual({ role: "system", content: "", sections: {}, sectionsOmitted: true, toolsOmitted: true, timestamp: 1 });
  expect(assistant!.content).toEqual([
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "answer" },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
  ]);
  expect(assistant!.stopReason).toBe("stop");
  expect(JSON.stringify(entry)).toBe(before) /* "the stored entry is not mutated" */;
});

test("entries without provider-only data keep their identity", () => {
  const entry = { id: 2, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 1 }] } as unknown as EntryRecord;
  expect(projectEntryForUi(entry)).toBe(entry);
});
