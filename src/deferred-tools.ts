// Names the deferred tools in the system prompt. tool_search ranks by query, but its description cannot say which
// tools exist, so without this the model does not know that (for example) a Cloudflare docs tool is one search away.
import { defineExtension, section } from "@earendil-works/pi-durable";

/** Longest list rendered; MCP servers can add hundreds of tools, and tool_search finds the rest by query. */
const MAX_NAMES = 60;

export function createDeferredToolsExtension() {
  return defineExtension({
    name: "deferred-tools",
    sections: [section("deferred-tools", ({ agent }) => {
      // Loaded deferred tools stay in the list, so loading one does not change the prompt (and its cache).
      const names = [...new Set([...agent.tools, ...agent.deferred].filter(tool => tool.deferred === true).map(tool => tool.name))].sort();
      if (!names.length) return undefined;
      const shown = names.slice(0, MAX_NAMES).join(", ");
      const more = names.length > MAX_NAMES ? `, and ${names.length - MAX_NAMES} more` : "";
      return `These tools exist but are not loaded. Load one with tool_search (query its name or purpose) before you call it: ${shown}${more}.`;
    })],
  });
}
