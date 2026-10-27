// Claude Code owns authentication; Luna owns tools and the authoritative transcript.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { LIMIT_DIAGNOSTIC } from "./provider-limits.js";
import { ClaudeTransportError } from "./claude-native/types.js";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createProvider, createAssistantMessageEventStream, getCurrentTools,
  type ProviderStreams, type AssistantMessage, type TextContent, type ThinkingContent, type ToolCall,
} from "@earendil-works/pi-ai";
import { prepareNativeRequest, runNativeRequest, nativeResponseCarrier, validateNativeResponse } from "./claude-native.js";
import { nativeContextWindow } from "./claude-native/history.js";

export function claudeExecutable() {
  return process.env.LUNA_CLAUDE_EXECUTABLE ?? join(homedir(), ".local/bin/claude");
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
    let text: TextContent | undefined, thinking: ThinkingContent | undefined;
    let textIndex = -1, thinkingIndex = -1;
    const textDelta = (delta: string) => {
      if (!text) {
        text = { type: "text", text: "" };
        textIndex = message.content.push(text) - 1;
        events.push({ type: "text_start", contentIndex: textIndex, partial: message });
      }
      text.text += delta;
      if (delta) events.push({ type: "text_delta", contentIndex: textIndex, delta, partial: message });
    };
    const thinkingDelta = (delta: string) => {
      if (!thinking) {
        thinking = { type: "thinking", thinking: "" };
        thinkingIndex = message.content.push(thinking) - 1;
        events.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: message });
      }
      thinking.thinking += delta;
      if (delta) events.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: message });
    };
    try {
      events.push({ type: "start", partial: message });
      const request = prepareNativeRequest(context, model, options?.maxTokens);
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
      message.responseId = response.id;
      message.rawStopReason = choice.finish_reason;
      const fullText = final.content ?? "";
      if (!fullText.startsWith(text?.text ?? "")) throw new Error("Claude final text differs from its stream");
      textDelta(fullText.slice(text?.text.length ?? 0));
      const fullThinking = final.reasoning_content ?? "";
      if (!fullThinking.startsWith(thinking?.thinking ?? "")) throw new Error("Claude final thinking differs from its stream");
      if (fullThinking) thinkingDelta(fullThinking.slice(thinking?.thinking.length ?? 0));

      // Validate the complete batch before any actionable tool event is emitted.
      const calls: ToolCall[] = [];
      if (choice.finish_reason !== "content_filter" && choice.finish_reason !== "length") {
        const offered = new Set(getCurrentTools(context.messages).map(t => t.name));
        const seen = new Set<string>();
        for (const call of final.tool_calls ?? []) {
          if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id || seen.has(call.id) ||
            !call.function || typeof call.function.name !== "string" || !offered.has(call.function.name)) {
            throw new Error("Invalid, duplicate, or unknown Luna tool in Claude response");
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
      text!.textSignature = nativeResponseCarrier(response);
      if (thinking) events.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking.thinking, partial: message });
      events.push({ type: "text_end", contentIndex: textIndex, content: text!.text, partial: message });
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

function discoveryEnvironment() {
  const env = { ...process.env };
  const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"]
    .filter(key => env[key]);
  conflicts.push(...["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]
    .filter(key => !["", "0", "false", "no", "off"].includes((env[key] ?? "").toLowerCase())));
  if (conflicts.length) throw new Error(`Claude CLI subscription refuses conflicting auth/backend overrides: ${conflicts.join(", ")}`);
  delete env.CLAUDECODE;
  return { ...env, DISABLE_AUTOUPDATER: "1", DISABLE_FEEDBACK_COMMAND: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "0" };
}

export function claudeCliProvider() {
  const catalog = anthropicProvider().getModels();
  const modelDefinition = (id: string, name: string) => {
    const known = catalog.find(m => m.id === id);
    return {
      id, name: `${name} (CLI)`, api: "anthropic-messages" as const,
      provider: "claude-cli", baseUrl: "", input: ["text" as const, "image" as const], reasoning: false,
      // Same table the transport routes by, so the reported window is the one the CLI runs at.
      // Unknown/plain native routes stay 200K. Never copy a larger API-only window.
      contextWindow: nativeContextWindow(id), maxTokens: known?.maxTokens ?? 32000,
      // No local price table: each completed generation supplies Claude Code's USD estimate.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  };
  return createProvider({
    id: "claude-cli", name: "Claude Code (CLI login)",
    auth: { apiKey: { name: "Claude Code login", resolve: async () =>
      existsSync(claudeExecutable()) ? { auth: {}, source: "Claude Code CLI login" } : undefined } },
    models: catalog.map(m => modelDefinition(m.id, m.name)),
    fetchModels: async ({ signal, allowNetwork }) => {
      if (!allowNetwork) return [];
      const env = discoveryEnvironment();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      let session: ReturnType<typeof query> | undefined;
      try {
        // An empty iterable sends no user frame. Only the initialize handshake is used.
        session = query({ prompt: (async function* () {})(), options: {
          pathToClaudeCodeExecutable: claudeExecutable(), tools: [], settingSources: [], env,
          abortController: controller,
        } });
        const available = await session.supportedModels();
        const unique = new Map(available.map(m => {
          const id = m.resolvedModel ?? m.value;
          return [id, modelDefinition(id, m.displayName)];
        }));
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
