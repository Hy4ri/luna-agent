// Claude Code owns authentication; Luna owns tools and the authoritative transcript.
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { LIMIT_DIAGNOSTIC } from "./provider-limits.js";
import { ClaudeTransportError } from "./claude-native/types.js";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createProvider, createAssistantMessageEventStream, clampThinkingLevel,
  type ProviderStreams, type AssistantMessage, type Model, type ToolCall,
} from "@earendil-works/pi-ai";
import { createStreamDeltas } from "./cli-stream.js";
import { prepareNativeRequest, runNativeRequest, nativeResponseCarrier, validateNativeResponse } from "./claude-native.js";
import { NATIVE_ROUTE_IDS, nativeContextWindow } from "./claude-native/history.js";
import { FATAL_BILLING_LIMIT } from "./claude-native/billing.js";
import { readClaudeLoginStatusCached } from "./claude-native/status.js";
import { claudeControlOptions } from "./claude-native/transport.js";

export function claudeExecutable() {
  return claudeControlOptions().executable;
}

const stream: ProviderStreams["streamSimple"] = (model, context, options) => {
  const events = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    const { textDelta, thinkingDelta, getText, getThinking, getTextIndex, getThinkingIndex } =
      createStreamDeltas(message, events);
    try {
      events.push({ type: "start", partial: message });
      if (model.api !== "anthropic-messages") throw new Error("Claude CLI requires the anthropic-messages API");
      const level = clampThinkingLevel(model, options?.reasoning ?? "off");
      const request = prepareNativeRequest(context, model as Model<"anthropic-messages">,
        options?.maxTokens, level === "off" ? undefined : level, options?.thinkingBudgets);
      message.providerThinkingLevel = request.providerThinkingLevel;
      const response = await runNativeRequest(request, { executable: claudeExecutable(), signal: options?.signal,
        onText: textDelta, onThinking: thinkingDelta });
      validateNativeResponse(response, model.id);
      if (options?.signal?.aborted) throw new Error("Claude request aborted");
      const choice = response.choices[0]!;
      const final = choice.message;
      // A completed generation consumed these tokens even if its tool batch is rejected.
      const usage = response.usage.native_usage;
      message.usage.input = usage.input_tokens;
      message.usage.output = usage.output_tokens;
      message.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
      message.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
      if (usage.cache_creation?.ephemeral_1h_input_tokens !== undefined) {
        message.usage.cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;
      }
      message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      // Use native pricing, not the zero-priced subscription catalog. Native exposes a total,
      // not per-token-category dollar amounts; do not invent a component breakdown.
      message.usage.cost.total = response.usage.native_cost_usd;
      if (response.usage.native_billing_error) {
        throw new ClaudeTransportError(response.usage.native_billing_error, 402, FATAL_BILLING_LIMIT);
      }
      message.responseId = response.id;
      message.rawStopReason = choice.finish_reason;
      const streamedText = getText()?.text ?? "";
      const streamedThinking = getThinking()?.thinking ?? "";
      const fullText = final.content ?? "";
      if (!fullText.startsWith(streamedText)) throw new Error("Claude final text differs from its stream");
      textDelta(fullText.slice(streamedText.length));
      const fullThinking = final.reasoning_content ?? "";
      if (!fullThinking.startsWith(streamedThinking)) throw new Error("Claude final thinking differs from its stream");
      if (fullThinking) thinkingDelta(fullThinking.slice(streamedThinking.length));

      // Validate the complete batch before any actionable tool event is emitted.
      const calls: ToolCall[] = [];
      if (choice.finish_reason !== "content_filter" && choice.finish_reason !== "length") {
        // A call to a tool Luna did not offer is a model error, not a transport error: the harness answers it
        // with a tool_unavailable result and the model can recover.
        const seen = new Set<string>();
        for (const call of final.tool_calls ?? []) {
          if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id || seen.has(call.id) ||
            !call.function || typeof call.function.name !== "string" || !call.function.name) {
            throw new Error("Invalid or duplicate Luna tool call in Claude response");
          }
          seen.add(call.id);
          if (typeof call.function.arguments !== "string") throw new Error("Invalid Claude tool arguments");
          const args: unknown = JSON.parse(call.function.arguments);
          if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Claude tool arguments must be an object");
          calls.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: args as ToolCall["arguments"] });
        }
        if ((choice.finish_reason === "tool_calls") !== (calls.length > 0)) {
          throw new Error("Claude tool batch does not match its completion reason");
        }
      }
      // Reconciliation can create blocks that were absent from the stream, even for empty text.
      const text = getText()!;
      const thinking = getThinking();
      text.textSignature = nativeResponseCarrier(response);
      if (thinking) events.push({ type: "thinking_end", contentIndex: getThinkingIndex(), content: thinking.thinking, partial: message });
      events.push({ type: "text_end", contentIndex: getTextIndex(), content: text.text, partial: message });
      if (choice.finish_reason === "content_filter") throw new Error(final.refusal || fullText || "Claude refused this request");
      for (const call of calls) {
        const contentIndex = message.content.push(call) - 1;
        events.push({ type: "toolcall_start", contentIndex, partial: message });
        events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
      }
      message.stopReason = calls.length ? "toolUse" : choice.finish_reason === "length" ? "length" : "stop";
      events.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof ClaudeTransportError && error.limit) {
        message.diagnostics = [...(message.diagnostics ?? []), {
          type: LIMIT_DIAGNOSTIC, timestamp: Date.now(), details: error.limit,
        }];
      }
      events.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      events.end(message);
    }
  })();
  return events;
};

/** "claude-fable-5-2" -> "Fable 5.2"; catalog names win when known. */
function routeName(id: string): string {
  const known = anthropicProvider().getModels().find(m => m.id === id);
  if (known) return known.name;
  const [family = id, ...version] = id.replace(/^claude-/u, "").split("-");
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();
}

export function claudeCliProvider() {
  const catalog = anthropicProvider().getModels();
  const modelDefinition = (id: string, name: string) => {
    const base = id.replace(/\[1m\]$/u, "");
    // A release newer than the catalog takes the thinking levels of its newest catalogued family member.
    const family = /^claude-[a-z]+-/u.exec(base)?.[0];
    const known = catalog.find(m => m.id === base) ?? (family ? catalog.filter(m => m.id.startsWith(family))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0] : undefined);
    return {
      id, name: `${name} (CLI)`, api: "anthropic-messages" as const,
      provider: "claude-cli", baseUrl: "", input: ["text" as const, "image" as const], reasoning: known?.reasoning ?? false,
      ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
      ...(known?.compat ? { compat: {
        forceAdaptiveThinking: known.compat.forceAdaptiveThinking,
        supportsMidConvoSystemMessages: known.compat.supportsMidConvoSystemMessages,
        supportsMidConvoToolChanges: known.compat.supportsMidConvoToolChanges,
        supportsMidConvoEffort: known.compat.supportsMidConvoEffort,
      } } : {}),
      // Same table the transport routes by, so the reported window is the one the CLI runs at.
      // Unknown/plain native routes stay 200K. Never copy a larger API-only window.
      contextWindow: nativeContextWindow(id), maxTokens: known?.maxTokens ?? 32000,
      // No local price table: each completed generation supplies Claude Code's USD estimate.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  };
  return createProvider({
    id: "claude-cli", name: "Claude Code (CLI login)",
    auth: { apiKey: {
      name: "Claude Code login",
      check: async ({ signal }) => {
        const status = await readClaudeLoginStatusCached(signal);
        return status.loggedIn ? { type: "oauth" as const,
          source: status.plan ? `Claude Code ${status.plan}` : "Claude Code CLI login" } : undefined;
      },
      resolve: async ({ signal }) => {
        signal.throwIfAborted();
        claudeControlOptions();
        return { auth: {}, source: "Claude Code CLI login" };
      },
    } },
    models: catalog.map(m => modelDefinition(m.id, m.name)),
    fetchModels: async ({ signal, allowNetwork }) => {
      if (!allowNetwork) return [];
      const { executable, env } = claudeControlOptions();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      let session: ReturnType<typeof query> | undefined;
      try {
        // An empty iterable sends no user frame. Only the initialize handshake is used.
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        session = query({ prompt: (async function* () {})(), options: {
          pathToClaudeCodeExecutable: executable, tools: [], settingSources: [], env,
          abortController: controller,
        } });
        const available = await session.supportedModels();
        const unique = new Map(available.map(m => {
          const id = m.resolvedModel ?? m.value;
          return [id, modelDefinition(id, m.displayName)];
        }));
        // Nonessential traffic is off, so the CLI omits remotely announced routes such as new Fable releases.
        for (const id of NATIVE_ROUTE_IDS) if (!unique.has(id)) unique.set(id, modelDefinition(id, routeName(id)));
        return [...unique.values()];
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        session?.close();
      }
    },
    api: { stream, streamSimple: stream },
  });
}
