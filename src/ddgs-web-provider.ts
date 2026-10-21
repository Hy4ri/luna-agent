// DDGS is one adapter, not an agent-facing API.
import type { LunaConfig } from "./config.js";
import type { McpManager } from "./mcp.js";
import { validateWebUrl, type WebProvider, type WebSearchResult } from "./web-tools.js";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function decode(response: unknown): unknown {
  if (!record(response)) throw new Error("DDGS returned a malformed MCP response.");
  if (response.isError === true) throw new Error("DDGS reported an error. Check its MCP configuration and availability.");
  if (response.structuredContent !== undefined) {
    const data = response.structuredContent;
    return record(data) && Array.isArray(data.result) ? data.result : data;
  }
  if (!Array.isArray(response.content) || !response.content.length) throw new Error("DDGS returned no content.");
  const blocks = response.content.map(block => {
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") throw new Error("DDGS returned non-text content.");
    try { return JSON.parse(block.text) as unknown; } catch { throw new Error("DDGS returned invalid JSON content."); }
  });
  return blocks.length === 1 ? blocks[0] : blocks;
}
export function createDdgsWebProvider(options: () => LunaConfig["web"]["providers"]["ddgs"], mcp: Pick<McpManager, "callTool">): WebProvider {
  const call = async (tool: string, args: Record<string, unknown>, signal: AbortSignal) => {
    signal.throwIfAborted();
    const result = await mcp.callTool(options().mcpServer, tool, args, signal);
    signal.throwIfAborted();
    return decode(result);
  };
  return {
    async search(request, signal) {
      let data = await call("search_text", { query: request.query, max_results: request.count ?? 5, backend: options().backend, region: options().region, safesearch: options().safesearch }, signal);
      if (record(data) && "href" in data) data = [data];
      if (!Array.isArray(data)) throw new Error("DDGS returned malformed search results.");
      return data.map((row): WebSearchResult => {
        if (!record(row) || typeof row.title !== "string" || typeof row.href !== "string" || typeof row.body !== "string") throw new Error("DDGS returned a malformed search result.");
        validateWebUrl(row.href);
        return { title: row.title, url: row.href, snippet: row.body };
      });
    },
    async extract(request, signal) {
      const format = request.format ?? "markdown";
      const data = await call("extract_content", { url: request.url, fmt: format === "text" ? "text_plain" : "text_markdown" }, signal);
      if (!record(data) || typeof data.url !== "string" || typeof data.content !== "string") throw new Error("DDGS returned malformed extracted content.");
      validateWebUrl(data.url);
      return { url: data.url, content: data.content, format };
    },
  };
}
