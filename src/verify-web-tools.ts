// Deterministic real-runtime gate. --live uses the installed DDGS server and real web requests, but no model inference.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { openLuna, context } from "./luna.js";
import { parseConfig, loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { SettingsStore } from "./settings.js";
import { createWebToolsExtension, type WebProvider } from "./web-tools.js";

const dir = mkdtempSync(join(tmpdir(), "luna-web-tools-"));
const live = process.argv.includes("--live");
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(); const model = { provider: fm.provider, modelId: fm.id };
async function invoke(harness: Awaited<ReturnType<typeof openLuna>>, tool: string, args: unknown) {
  let result: any;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool, args as any)], { stopReason: "toolUse" }),
    (c: any) => { result = c.messages.filter((m: any) => m.role === "toolResult").at(-1); return fauxAssistantMessage([fauxText("done")]); },
  ]);
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const agent = await conv.agent(context);
  assert.ok(agent.tools.some(t => t.name === tool), `${tool} must be natively offered`);
  await (await conv.submit({ type: "input", content: "Run verification" }, context)).wait(context);
  assert.ok(result, `Missing result for ${tool}`);
  const text = typeof result.content === "string" ? result.content : result.content.map((c: any) => c.text ?? "").join("");
  return { error: result.isError === true, text, data: () => JSON.parse(text) };
}
const seen: { tool: string; args: any }[] = [];
const http = createServer(async (req, res) => {
  const server = new McpServer({ name: "ddgs-fixture", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  server.tool("search_text", "search", { query: z.string(), max_results: z.number(), backend: z.string(), region: z.string(), safesearch: z.string() }, async args => {
    seen.push({ tool: "search_text", args });
    if (args.query === "error") return { content: [{ type: "text", text: "secret-token must not leak" }], isError: true };
    if (args.query === "malformed") return { content: [{ type: "text", text: "not JSON" }] };
    const rows = [1, 2].map(n => ({ title: `Result ${n}`, href: `https://example.com/${n}`, body: `Snippet ${n}` }));
    if (args.query === "structured") return { content: [], structuredContent: { result: rows } };
    if (args.query === "empty") return { content: [{ type: "text", text: "[]" }] };
    if (args.query === "blocks") return { content: rows.map(row => ({ type: "text" as const, text: JSON.stringify(row) })) };
    return { content: [{ type: "text", text: JSON.stringify(rows) }] };
  });
  server.tool("extract_content", "extract", { url: z.string(), fmt: z.string() }, async args => {
    seen.push({ tool: "extract_content", args });
    return { content: [{ type: "text", text: JSON.stringify({ url: args.url, content: "Example Domain" }) }] };
  });
  await server.connect(transport); await transport.handleRequest(req, res);
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
try {
  assert.throws(() => parseConfig({ web: { searchProvider: "unknown" } }, dir, {}), /web.searchProvider/);
  assert.throws(() => parseConfig({ web: { providers: { ddgs: { key: "secret" } } } }, dir, {}), /Unrecognized/);
  const cfg = parseConfig({ dataDir: dir, extensions: [], web: { searchProvider: "ddgs", extractProvider: "ddgs", providers: { ddgs: { mcpServer: "chosen", backend: "bing", region: "fr-fr", safesearch: "off" } } }, mcpServers: [{ name: "chosen", transport: "http", url }] }, dir, {});
  const rt = await startRuntime(cfg, { models, model, log: () => {} });
  try {
    let result = await invoke(rt.harness, "web_search", { query: " fixture ", count: 1 });
    assert.equal(result.error, false, result.text);
    assert.deepEqual(result.data(), { results: [{ title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" }] });
    assert.deepEqual(seen[0], { tool: "search_text", args: { query: "fixture", max_results: 1, backend: "bing", region: "fr-fr", safesearch: "off" } });
    for (const query of ["structured", "blocks"]) {
      result = await invoke(rt.harness, "web_search", { query });
      assert.equal(result.error, false, result.text); assert.equal(result.data().results.length, 2);
    }
    result = await invoke(rt.harness, "web_search", { query: "empty" });
    assert.deepEqual(result.data(), { results: [] });
    for (const format of ["markdown", "text"]) {
      result = await invoke(rt.harness, "web_extract", { url: "https://example.com", format });
      assert.equal(result.error, false, result.text);
      assert.deepEqual(result.data(), { url: "https://example.com", content: "Example Domain", format });
      assert.equal(seen.at(-1)!.args.fmt, format === "text" ? "text_plain" : "text_markdown");
    }
    for (const query of ["error", "malformed"]) {
      result = await invoke(rt.harness, "web_search", { query }); assert.equal(result.error, true, query); assert.ok(!result.text.includes("secret-token"));
    }
    const calls = seen.length;
    for (const args of [{ query: " " }, { query: "x", count: 0 }, { query: "x", backend: "not-allowed" }]) assert.equal((await invoke(rt.harness, "web_search", args)).error, true);
    for (const args of [{ url: "file:///etc/passwd" }, { url: "https://user:password@example.com" }, { url: "https://example.com", format: "html" }]) assert.equal((await invoke(rt.harness, "web_extract", args)).error, true);
    assert.equal(seen.length, calls, "Rejected input must not reach provider");
    console.log("OK real runtime native tools, DDGS normalization/options/JSON variants, schema validation, provider errors");
  } finally { await rt.close(); }

  // Select independently between two providers with the same unchanged native tool schema.
  const routes: string[] = [];
  const provider = (id: string): WebProvider => ({
    async search(req, signal) { assert.ok(signal instanceof AbortSignal); routes.push(`${id}:search`); return [{ title: req.query, url: "https://example.com", snippet: id }]; },
    async extract(req, signal) { assert.ok(signal instanceof AbortSignal); routes.push(`${id}:extract`); return { url: req.url, content: id, format: req.format ?? "markdown" }; },
  });
  for (const [searchProvider, extractProvider] of [["a", "b"], ["b", "a"], ["disabled", "disabled"], ["missing", "missing"]]) {
    const harness = await openLuna({ dbPath: join(dir, `${searchProvider}.db`), models, coding: false, memory: false, extensions: [createWebToolsExtension({ searchProvider: searchProvider!, extractProvider: extractProvider! }, new Map([["a", provider("a")], ["b", provider("b")]]))] });
    try {
      const before = routes.length;
      const search = await invoke(harness, "web_search", { query: "route" });
      const extract = await invoke(harness, "web_extract", { url: "https://example.com" });
      if (["disabled", "missing"].includes(searchProvider!)) { assert.ok(search.error && extract.error); assert.equal(routes.length, before); }
      else { assert.equal(search.data().results[0].snippet, searchProvider); assert.equal(extract.data().content, extractProvider); }
    } finally { await harness.close(context); }
  }
  // Aborting a durable tool forwards cancellation to its provider and stops owned work.
  let started!: () => void, cancelled!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const waiting: WebProvider = {
    async search(_request, signal) {
      started();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { cancelled(); reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
      return [];
    },
    async extract() { throw new Error("unused"); },
  };
  const abortHarness = await openLuna({ dbPath: join(dir, "abort.db"), models, coding: false, memory: false,
    extensions: [createWebToolsExtension({ searchProvider: "wait", extractProvider: "wait" }, new Map([["wait", waiting]]))] });
  try {
    faux.setResponses([fauxAssistantMessage([fauxToolCall("web_search", { query: "wait" })], { stopReason: "toolUse" })]);
    const conv = await abortHarness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const submission = await conv.submit({ type: "input", content: "cancel test" }, context);
    await start; await conv.abort(context); await cancellation;
    assert.equal((await submission.wait(context)).status, "unanswered");
  } finally { await abortHarness.close(context); }
  console.log("OK durable cancellation reaches provider");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ dataDir: join(dir, "settings"), providers: [] }));
  const settings = new SettingsStore(path, join(dir, "settings"));
  const view = settings.view(); view.config.web.searchProvider = "ddgs"; settings.replace(view.config, view.revision);
  assert.equal(settings.restartRequired, true); assert.equal(JSON.parse(readFileSync(path, "utf8")).web.searchProvider, "ddgs");
  const restarted = await startRuntime(loadConfig(path), { models, model, log: () => {} });
  try { const result = await invoke(restarted.harness, "web_search", { query: "x" }); assert.equal(result.error, true); assert.match(result.text, /not connected/); }
  finally { await restarted.close(); }
  console.log("OK independent provider routing, disabled/unavailable providers, settings persistence and restart routing");

  if (live) {
    const runtime = await startRuntime(parseConfig({ dataDir: join(dir, "live"), extensions: [], web: { searchProvider: "ddgs", extractProvider: "ddgs" }, mcpServers: [{ name: "ddgs", transport: "stdio", command: "/.local/bin/ddgs", args: ["mcp"], timeoutMs: 60000 }] }, dir, {}), { models, model, log: console.log });
    try {
      const search = await invoke(runtime.harness, "web_search", { query: "TypeScript official documentation", count: 2 });
      assert.equal(search.error, false, search.text); assert.ok(search.data().results.length > 0); console.log("LIVE_SEARCH", search.text);
      const extract = await invoke(runtime.harness, "web_extract", { url: "https://example.com", format: "markdown" });
      assert.equal(extract.error, false, extract.text); assert.match(extract.data().content, /documentation examples/i); console.log("LIVE_EXTRACT", extract.text);
    } finally { await runtime.close(); }
  }
  console.log("WEB_TOOLS_OK");
} finally {
  await new Promise<void>(resolve => http.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
