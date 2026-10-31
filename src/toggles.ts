// Live tool switch: names in the disabledTools setting leave every model request and every call is refused.
import { GenerationTask, ToolTask, defineExtension, hook } from "@earendil-works/pi-durable";
import { filterHiddenTools } from "./tool-visibility.js";

export function createToggleExtension(disabled: () => readonly string[]) {
  return defineExtension({ name: "toggles", hooks: [
    hook(GenerationTask, {
      // Filter the request only, so the stored tool state stays and re-enabling needs no repair.
      async beforeRequest(request) {
        const off = new Set(disabled());
        if (!off.size) return undefined;
        return { messages: filterHiddenTools(request.messages, off) };
      },
    }),
    hook(ToolTask, {
      // Also covers nested calls and calls already planned before the switch.
      async beforeTool(call) {
        return disabled().includes(call.name) ? { block: `Tool "${call.name}" is disabled in settings.` } : {};
      },
    }),
  ] });
}
