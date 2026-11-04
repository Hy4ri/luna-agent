// Keep Luna's deadline in Pi's persisted start data, not only in an in-memory timer.
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { section, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension, createCodemodeTool, type CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";

const ROUTING = [
  "When to use `codemode`:",
  "- Use it for 3 or more tool calls, loops, parallel independent reads, or large output that you must filter. Return only the result that you need.",
  "- Use a direct tool call for one call, or for an edit that you must see before the next step.",
].join("\n");

type CatalogTool = Pick<ToolRegistration, "name" | "description" | "parameters" | "structuredOutputSchema" | "deferred">;

function renderTool(tool: CatalogTool) {
  const id = toCodemodeIdentifier(tool.name);
  const heading = id === tool.name ? `### \`${id}\`` : `### \`${id}\` (\`${tool.name}\`)`;
  const sample = renderToolSample({
    name: tool.name, description: tool.description, inputSchema: tool.parameters as never,
    outputSchema: (tool.structuredOutputSchema ?? { type: "string" }) as never,
  });
  return `${heading}\n${sample.trim()}`;
}

/**
 * The `codemode` section. Pi lists the cheapest declarations first, which leaves out the core tools
 * (bash, read, edit) because their descriptions are long. Luna lists the pinned tools first, then fills the
 * rest of the budget by cost, as Pi does.
 */
export function codemodeCatalog(tools: readonly CatalogTool[], pinned: readonly string[], budget: number) {
  const visible = tools.filter(t => !t.name.startsWith("pi.codemode.") && t.deferred !== true);
  if (visible.length === 0) return undefined;
  const order = new Map(pinned.map((name, i) => [name, i]));
  const entries = visible.map(tool => { const text = renderTool(tool); return { name: tool.name, text, cost: Math.ceil(text.length / 4) }; });
  const first = entries.filter(e => order.has(e.name)).sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  const rest = entries.filter(e => !order.has(e.name)).sort((a, b) => a.cost - b.cost);
  let remaining = budget - first.reduce((sum, e) => sum + e.cost, 0);
  const shown = [...first];
  for (const entry of rest) {
    if (entry.cost > remaining) break;
    remaining -= entry.cost;
    shown.push(entry);
  }
  return [
    ROUTING,
    "Tools scripts can call (`await tools.<name>(args)`):",
    ...(shown.length < entries.length ? ["Some tools are not listed: find them with `searchTools()`."] : []),
    ...shown.map(e => e.text),
  ].join("\n\n");
}

export function createLunaCodemodeExtension(options: CodemodeToolOptions, timeoutMs: number, pinned: readonly string[]) {
  const extension = createCodemodeExtension(options);
  const tool = createCodemodeTool(options);
  const budget = options.inlineBudget ?? 3000;
  return {
    ...extension,
    sections: [
      section("codemode", input => codemodeCatalog(input.agent.callable, pinned, budget)),
      ...(extension.sections ?? []).filter(s => s.key !== "codemode"),
    ],
    tools: [{
      ...tool,
      execute: ((args, api, context) => {
        const parsed = parseCodemodeSource(args.code);
        const directive = {
          timeout_ms: Math.min(parsed.options.timeoutMs ?? timeoutMs, timeoutMs),
          ...(parsed.options.maxOutputTokens === undefined ? {} : { max_output_tokens: parsed.options.maxOutputTokens }),
        };
        return tool.execute!({ ...args, code: `// @options: ${JSON.stringify(directive)}\n${parsed.code}` }, api, context);
      }) satisfies NonNullable<typeof tool.execute>,
    }, ...(extension.tools ?? []).filter(t => t.name !== tool.name)],
  };
}
