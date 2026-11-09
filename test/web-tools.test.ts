// Contract: one `web` tool. search walks the provider and its fallbacks; read uses the extract provider.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createWebToolsExtension, type WebProvider } from "../src/web-tools.js";

type Tool = { name: string; execute(args: Record<string, unknown>, api: unknown, ctx: { abortSignal?: AbortSignal }): Promise<{ output: { text: string }[] }> };
const providers = new Map<string, WebProvider>([
  ["broken", { search: async () => { throw new Error("down"); } }],
  ["good", { search: async ({ query }) => [{ title: query, url: "https://a.test/", snippet: "s" }],
    extract: async ({ url, format }) => ({ url, content: "page", format: format ?? "markdown" }) }],
]);
const ext = createWebToolsExtension(() => ({ searchProvider: "broken", searchFallbacks: ["good"], extractProvider: "good" }), providers);
const tools = (ext as unknown as { tools: Tool[] }).tools;
const web = tools[0]!;
const run = async (args: Record<string, unknown>) => JSON.parse((await web.execute(args, {}, {})).output[0]!.text);

test("only the merged web tool is registered", () => assert.deepEqual(tools.map(t => t.name), ["web"]));

test("search falls back and read extracts", async () => {
  assert.deepEqual(await run({ action: "search", query: "q" }), { results: [{ title: "q", url: "https://a.test/", snippet: "s" }] });
  assert.deepEqual(await run({ action: "read", url: "https://a.test/x", format: "text" }), { url: "https://a.test/x", content: "page", format: "text" });
});

test("each action refuses missing or unsafe arguments", async () => {
  await assert.rejects(run({ action: "search" }), /search needs a non-empty query/);
  await assert.rejects(run({ action: "read" }), /read needs url/);
  await assert.rejects(run({ action: "read", url: "file:///etc/passwd" }), /HTTP\(S\) URL/);
});
