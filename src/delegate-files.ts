// Native read-only directory discovery for child profiles that cannot use a shell.
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";

export const delegateFilesTool = defineTool({
  name: "delegate_files", deferred: true,
  description: "List one directory without executing a command or changing files. Use read to inspect files and call again for a subdirectory.",
  parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Directory path, relative to the child working directory. Default: ." })) }),
  replay: "safe",
  execute: async (args, api, context) => {
    if (!api.env) return { output: [{ type: "text", text: "No execution environment is available." }], isError: true };
    const result = await api.env.listDir(args.path ?? ".", context);
    if (!result.ok) return { output: [{ type: "text", text: result.error.message }], isError: true };
    return { output: [{ type: "text", text: result.value.map(file => `${file.kind}\t${file.name}`).sort().join("\n") || "Empty directory." }] };
  },
});
