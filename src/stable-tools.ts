// Stable tool declarations: some providers (Gemini through CLIProxyAPI/Antigravity) cache the tool list as part of the
// prompt prefix, so one tool added by tool_search makes the next request a full cache miss. For a provider with
// `compat.stableTools`, the request keeps the leading tool list and describes later tools as text; the model calls
// them through `codemode`, which reaches every callable tool. Stored history and tool state do not change.
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import { AgentDoc, GenerationTask, defineExtension, hook } from "@earendil-works/pi-durable";
import { renderCodemodeTool } from "./codemode.js";

type ModelRef = { provider: string; modelId: string };
type Models = { getModel(provider: string, modelId: string): { compat?: unknown } | undefined };

const CODEMODE = "codemode";

function text(content: SystemMessage["content"]): string {
  return typeof content === "string" ? content : content.map(part => part.text).join("");
}

function describe(tools: readonly Tool[]): string {
  return [
    "These tools are loaded but not declared as direct tools. Call them only inside `codemode` as `await tools.<name>(args)`:",
    ...tools.map(renderCodemodeTool),
  ].join("\n\n");
}

/**
 * Request-only projection: later tool additions become text, so the declared tool list stays the leading message's.
 * A later addition that redefines a leading tool stays declared. Removals of undeclared tools are dropped. Returns
 * the same array when nothing changes, or when the leading message does not declare `codemode`.
 */
export function pinToolDeclarations(messages: readonly Message[]): readonly Message[] {
  const first = messages[0];
  if (first?.role !== "system") return messages;
  const pinned = new Set((first.toolsAdded ?? []).map(tool => tool.name));
  if (!pinned.has(CODEMODE)) return messages;
  let changed = false;
  const out = messages.map((message, index) => {
    if (index === 0 || message.role !== "system") return message;
    const moved = (message.toolsAdded ?? []).filter(tool => !pinned.has(tool.name));
    const dropped = (message.toolsRemoved ?? []).filter(tool => !pinned.has(tool.name));
    if (moved.length === 0 && dropped.length === 0) return message;
    changed = true;
    const { toolsAdded, toolsRemoved, ...rest } = message;
    const kept = toolsAdded?.filter(tool => pinned.has(tool.name)) ?? [];
    const keptRemoved = toolsRemoved?.filter(tool => pinned.has(tool.name)) ?? [];
    const base = text(message.content);
    return {
      ...rest,
      content: moved.length === 0 ? message.content : [base, describe(moved)].filter(Boolean).join("\n\n"),
      ...(kept.length ? { toolsAdded: kept } : {}),
      ...(keptRemoved.length ? { toolsRemoved: keptRemoved } : {}),
    } satisfies SystemMessage;
  });
  return changed ? out : messages;
}

export function createStableToolsExtension(options: { models: Models; defaultModel: () => ModelRef }) {
  return defineExtension({ name: "stable-tools", hooks: [hook(GenerationTask, {
    async beforeRequest(request, api, context) {
      const ref = (await api.snapshot(AgentDoc, api.conversationId, context))?.model ?? options.defaultModel();
      let compat: unknown;
      try { compat = options.models.getModel(ref.provider, ref.modelId)?.compat; } catch { return undefined; }
      if ((compat as { stableTools?: unknown } | undefined)?.stableTools !== true) return undefined;
      const messages = pinToolDeclarations(request.messages);
      return messages === request.messages ? undefined : { messages };
    },
  })] });
}
