// Keep Luna's deadline in Pi's persisted start data, not only in an in-memory timer.
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { createCodemodeExtension, createCodemodeTool, type CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";

export function createLunaCodemodeExtension(options: CodemodeToolOptions, timeoutMs: number) {
  const extension = createCodemodeExtension(options);
  const tool = createCodemodeTool(options);
  return {
    ...extension,
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
