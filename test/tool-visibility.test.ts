// Contract (#196): a tool hidden by settings has neither declarations nor removals in the outgoing request,
// and the stored history is not changed. A removal without a matching declaration breaks native replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { filterHiddenTools } from "../src/tool-visibility.js";

const tool = (name: string): Tool => ({ name, description: name, parameters: { type: "object", properties: {} } as Tool["parameters"] });
const user: Message = { role: "user", content: "hi", timestamp: 2 };

test("hidden tools are removed from additions and removals; other messages are untouched", () => {
  const history: Message[] = [
    { role: "system", content: "base", toolsAdded: [tool("bash"), tool("vision_analyze")], timestamp: 1 },
    user,
    { role: "system", content: "", toolsRemoved: [{ name: "vision_analyze" }, { name: "bash" }], timestamp: 3 },
  ];
  const before = structuredClone(history);
  const out = filterHiddenTools(history, new Set(["vision_analyze"]));
  assert.deepEqual(out.map(m => m.role === "system" ? [m.toolsAdded?.map(t => t.name), m.toolsRemoved?.map(t => t.name)] : m.role),
    [[["bash"], undefined], "user", [undefined, ["bash"]]]);
  assert.deepEqual(history, before, "stored history is not mutated");
  assert.equal(out[1], user, "unrelated messages keep their identity");
});

test("messages without hidden tools keep their identity", () => {
  const system: Message = { role: "system", content: "base", toolsAdded: [tool("bash")], timestamp: 1 };
  const out = filterHiddenTools([system], new Set(["vision_analyze"]));
  assert.equal(out[0], system);
});
