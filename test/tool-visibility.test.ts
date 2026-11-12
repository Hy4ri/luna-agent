// Contract (#196): a tool hidden by settings has neither declarations nor removals in the outgoing request,
// and the stored history is not changed. A removal without a matching declaration breaks native replay.
import { test, expect } from "bun:test";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { filterHiddenTools } from "../src/tool-visibility.js";
import { pinToolDeclarations } from "../src/stable-tools.js";

const tool = (name: string): Tool => ({ name, description: name, parameters: { type: "object", properties: {} } as Tool["parameters"] });
const user: Message = { role: "user", content: "hi", timestamp: 2 };

test("hidden tools are removed from additions and removals; other messages are untouched", () => {
  const history: Message[] = [
    { role: "system", content: "base", toolsAdded: [tool("bash"), tool("media_analyze")], timestamp: 1 },
    user,
    { role: "system", content: "", toolsRemoved: [{ name: "media_analyze" }, { name: "bash" }], timestamp: 3 },
  ];
  const before = structuredClone(history);
  const out = filterHiddenTools(history, new Set(["media_analyze"]));
  expect(out.map(m => m.role === "system" ? [m.toolsAdded?.map(t => t.name), m.toolsRemoved?.map(t => t.name)] : m.role)).toEqual([[["bash"], undefined], "user", [undefined, ["bash"]]]);
  expect(history).toEqual(before) /* "stored history is not mutated" */;
  expect(out[1]).toBe(user) /* "unrelated messages keep their identity" */;
});

test("messages without hidden tools keep their identity", () => {
  const system: Message = { role: "system", content: "base", toolsAdded: [tool("bash")], timestamp: 1 };
  const out = filterHiddenTools([system], new Set(["media_analyze"]));
  expect(out[0]).toBe(system);
});

// Contract: with compat.stableTools, a tool loaded mid-conversation (tool_search) is not declared on the wire, so the
// provider's cached prefix (Gemini caches the tool list) holds. The model is told to reach it through codemode.
test("pinToolDeclarations keeps the leading tool list and moves later tools to text", () => {
  const history: Message[] = [
    { role: "system", content: "base", toolsAdded: [tool("codemode"), tool("bash")], timestamp: 1 },
    user,
    { role: "system", content: "", toolsAdded: [tool("image_generate"), tool("bash")], toolsRemoved: [{ name: "bash" }], timestamp: 3 },
    { role: "system", content: "", toolsRemoved: [{ name: "image_generate" }], timestamp: 4 },
  ];
  const before = structuredClone(history);
  const out = pinToolDeclarations(history);
  expect(out.map(m => m.role === "system" ? [m.toolsAdded?.map(t => t.name), m.toolsRemoved?.map(t => t.name)] : m.role)).toEqual([[["codemode", "bash"], undefined], "user", [["bash"], ["bash"]], [undefined, undefined]]);
  const moved = out[2] as Extract<Message, { role: "system" }>;
  expect(typeof moved.content === "string" ? moved.content : "").toMatch(/inside `codemode`[\s\S]*image_generate/);
  expect(history).toEqual(before) /* "stored history is not mutated" */;
});

test("pinToolDeclarations changes nothing without codemode in the leading tools", () => {
  const history: Message[] = [
    { role: "system", content: "base", toolsAdded: [tool("bash")], timestamp: 1 },
    { role: "system", content: "", toolsAdded: [tool("image_generate")], timestamp: 2 },
  ];
  expect(pinToolDeclarations(history)).toBe(history);
});
