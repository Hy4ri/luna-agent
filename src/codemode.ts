// Keep Luna's deadline in Pi's persisted start data, not only in an in-memory timer.
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { section, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension, createCodemodeTool, type CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";

const ROUTING = [
  "When to use `codemode`:",
  "- Use it when you can write the complete plan before you see a result: a chain where each call feeds the next, the same call for many inputs, or large output of which you need a small part. One script replaces many turns and keeps intermediate results out of the conversation. Return only the result that you need.",
  "- Use direct tool calls when you must read a result to decide the next step, for a single call, and for an edit.",
  "- If you do not know the shape of a tool's output, make one direct call first. Then write the script.",
].join("\n");

/** One chain with a fan-out and a reduced result. Shown only when the session can call both tools it names. */
const EXAMPLE = [
  "Example:",
  "```js",
  'const { output } = await tools.bash({ command: "git diff --name-only main" });',
  'const files = output.trim().split("\\n").filter(Boolean);',
  "const texts = await Promise.all(files.map(path => tools.read({ path })));",
  'return files.map((path, i) => ({ path, lines: String(texts[i]).split("\\n").length }));',
  "```",
].join("\n");

/**
 * The tool description. Pi's text names namespaces and `models`, which Luna does not use, and omits Luna's deadline.
 * Each statement here is a contract that the sandbox or `createLunaCodemodeExtension` enforces.
 */
export function codemodeToolDescription(timeoutMs: number) {
  return [
    "Run one JavaScript script that calls other tools. Intermediate results stay in the script; only its output comes back. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. There is no Node, `require`, `fetch`, file system, or timer (`setTimeout` does not exist). Do all I/O through tools.",
    [
      "Tool calls:",
      "- `await tools.<name>({ ...args })` takes the arguments of the direct tool. Every tool of this conversation works, also deferred tools and tools the `codemode` section does not list. `codemode` itself is not callable.",
      "- A tool declared as `Promise<string>` resolves to its text and rejects with an Error on failure. Use try/catch where a failure is possible.",
      "- A tool declared with an object result resolves to that object on failure too: `bash` resolves with a nonzero `exitCode`. Check the fields.",
      "- Run independent calls with `await Promise.all([...])`. Await every call you need: calls still running when the script ends are cancelled.",
      "- Tool calls have real effects. They are not undone when the script fails later.",
    ].join("\n"),
    [
      "Output:",
      "- The `return` value and each `text(value)` are the output; objects become compact JSON. With several text items, each starts with a `==> text N/M <==` line. `console.log(...)` lines come last, in one `<console_output>` block.",
      "- `image(value)` shows a PNG, JPEG, GIF, or WebP image from a base64 data URL or an image block `{ type: \"image\", data, mimeType }`, not from an http URL. It also saves the image to a temp file and the result names the path.",
      "- `exit()` ends the script at once without an error; output before it is kept.",
      "- Output above `max_output_tokens` (default 10000) keeps only its start and end; the result names a file with the complete text. Filter in the script and return only what you need.",
    ].join("\n"),
    [
      "State and discovery:",
      "- Variables end with the script. `store(key, value)` keeps a small JSON value for later codemode calls in this conversation, `load(key)` reads it (`undefined` when absent), and `store(key, undefined)` deletes it. Writes are saved only when the script succeeds. Limits: 262144 JSON characters for one value, 1048576 in total.",
      "- `ALL_TOOLS` is an array of `{ name, description }` for every tool. `await searchTools(query, { limit? })` returns the best matches in that shape (default 8). `await describeTool(name)` returns the description and TypeScript declaration of one tool, or `undefined`.",
    ].join("\n"),
    [
      "Limits:",
      `- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`. The time limit is ${timeoutMs} ms; \`timeout_ms\` can only lower it. At the limit the script fails and its running calls are cancelled, so start longer work as a background process and return.`,
      "- The script survives a daemon restart: it resumes without running finished calls again, unless its time limit passed during the restart.",
    ].join("\n"),
    "The `codemode` section of the system prompt has the declarations of the main tools.",
  ].join("\n\n");
}

type CatalogTool = Pick<ToolRegistration, "name" | "description" | "parameters" | "structuredOutputSchema" | "deferred">;

export function renderCodemodeTool(tool: CatalogTool) {
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
  const entries = visible.map(tool => { const text = renderCodemodeTool(tool); return { name: tool.name, text, cost: Math.ceil(text.length / 4) }; });
  const first = entries.filter(e => order.has(e.name)).sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  const rest = entries.filter(e => !order.has(e.name)).sort((a, b) => a.cost - b.cost);
  let remaining = budget - first.reduce((sum, e) => sum + e.cost, 0);
  const shown = [...first];
  for (const entry of rest) {
    if (entry.cost > remaining) break;
    remaining -= entry.cost;
    shown.push(entry);
  }
  const names = new Set(visible.map(t => t.name));
  return [
    ROUTING,
    ...(names.has("bash") && names.has("read") ? [EXAMPLE] : []),
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
      description: codemodeToolDescription(timeoutMs),
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
