// Contract (#196): a tool hidden by settings has neither declarations nor removals in the outgoing request,
// and the stored history is not changed. A removal without a matching declaration breaks native replay.
import assert from "node:assert/strict";
import { test } from "bun:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { filterHiddenTools } from "../src/tool-visibility.js";
import { pinToolDeclarations } from "../src/stable-tools.js";

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

// Contract: with compat.stableTools, a tool loaded mid-conversation (tool_search) is not declared on the wire, so the
// provider's cached prefix (Gemini caches the tool list) holds. The model is told to reach it through codemode.
test("pinToolDeclarations keeps the leading tool list and moves later tools to text", () => {
  const history: Message[] = [
    { role: "system", content: "base", toolsAdded: [tool("codemode"), tool("bash")], timestamp: 1 },
    user,
    { role: "system", content: "", toolsAdded: [tool("cron_history"), tool("bash")], toolsRemoved: [{ name: "bash" }], timestamp: 3 },
    { role: "system", content: "", toolsRemoved: [{ name: "cron_history" }], timestamp: 4 },
  ];
  const before = structuredClone(history);
  const out = pinToolDeclarations(history);
  assert.deepEqual(out.map(m => m.role === "system" ? [m.toolsAdded?.map(t => t.name), m.toolsRemoved?.map(t => t.name)] : m.role),
    [[["codemode", "bash"], undefined], "user", [["bash"], ["bash"]], [undefined, undefined]]);
  const moved = out[2] as Extract<Message, { role: "system" }>;
  assert.match(typeof moved.content === "string" ? moved.content : "", /inside `codemode`[\s\S]*cron_history/);
  assert.deepEqual(history, before, "stored history is not mutated");
});

test("pinToolDeclarations changes nothing without codemode in the leading tools", () => {
  const history: Message[] = [
    { role: "system", content: "base", toolsAdded: [tool("bash")], timestamp: 1 },
    { role: "system", content: "", toolsAdded: [tool("cron_history")], timestamp: 2 },
  ];
  assert.equal(pinToolDeclarations(history), history);
});
