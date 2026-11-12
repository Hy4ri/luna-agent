// Contract: one `web` tool. search walks the provider and its fallbacks; read uses the extract provider.
import { test, expect } from "bun:test";
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

test("only the merged web tool is registered", () => expect(tools.map(t => t.name)).toEqual(["web"]));

test("search falls back and read extracts", async () => {
  expect(await run({ action: "search", query: "q" })).toEqual({ results: [{ title: "q", url: "https://a.test/", snippet: "s" }] });
  expect(await run({ action: "read", url: "https://a.test/x", format: "text" })).toEqual({ url: "https://a.test/x", content: "page", format: "text" });
});

test("each action refuses missing or unsafe arguments", async () => {
  await expect(run({ action: "search" })).rejects.toThrow(/search needs a non-empty query/);
  await expect(run({ action: "read" })).rejects.toThrow(/read needs url/);
  await expect(run({ action: "read", url: "file:///etc/passwd" })).rejects.toThrow(/HTTP\(S\) URL/);
});
