import {
  getCurrentSystemPrompt, getCurrentTools,
  type ImageContent, type TextContent, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { runClaude } from "./claude-native/transport.js";
import type { Block, NativeMessage, NativeRequest, NativeResponse, NativeToolCall } from "./claude-native/types.js";

export type { NativeToolCall, NativeRequest, NativeResponse } from "./claude-native/types.js";

const SIGNATURE_PREFIX = "luna-claude-native-v1:";
const NATIVE_CARRIER_TYPE = "claude-subscription-directsdk-experimental.native_assistant";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativeResponseCarrier(response: NativeResponse): string {
  return SIGNATURE_PREFIX + JSON.stringify({
    v: 1, model: response.model,
    reasoning_details: response.choices[0]?.message.reasoning_details ?? [],
  });
}

function carrierDetails(signature: string, model: string): unknown[] | undefined {
  if (!signature.startsWith(SIGNATURE_PREFIX)) return;
  let value: unknown;
  try { value = JSON.parse(signature.slice(SIGNATURE_PREFIX.length)); }
  catch { throw new Error("Invalid Claude native carrier JSON"); }
  if (!object(value) || value.v !== 1 || typeof value.model !== "string") {
    throw new Error("Invalid Claude native carrier version or model");
  }
  if (value.model !== model) return;
  const details = value.reasoning_details;
  if (!Array.isArray(details) || details.length > 1 || details.some(d =>
    !object(d) || d.type !== NATIVE_CARRIER_TYPE || d.version !== 1 ||
    !Array.isArray(d.messages) || !d.messages.length ||
    d.messages.some(m => !object(m) || m.role !== "assistant" || !Array.isArray(m.content)) ||
    !object(d.projection) || typeof d.projection.content !== "string" || !Array.isArray(d.projection.tool_calls)
  )) throw new Error("Invalid Claude native assistant carrier");
  return details;
}

function blocks(content: (TextContent | ImageContent)[]): Block[] {
  return content.map(block => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
}

/** Convert only model-visible content. Luna remains the sole transcript owner. */
export function prepareNativeRequest(context: TranscriptContext, model: { id: string }, maxTokens?: number): NativeRequest {
  const messages: NativeMessage[] = [];
  const system = getCurrentSystemPrompt(context.messages);
  if (system) messages.push({ role: "system", content: system });
  for (const message of context.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: typeof message.content === "string" ? message.content : blocks(message.content) });
    } else if (message.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId, is_error: message.isError, content: blocks(message.content) });
    } else {
      const text = message.content.filter(b => b.type === "text");
      const calls: NativeToolCall[] = message.content.filter(b => b.type === "toolCall").map(b => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.arguments) },
      }));
      const native: NativeMessage = { role: "assistant", content: text.map(b => b.text).join("") || null };
      if (calls.length) native.tool_calls = calls;
      if (message.provider === "claude-cli" && message.api === "anthropic-messages" && message.model === model.id) {
        for (const block of text) {
          if (!block.textSignature) continue;
          const details = carrierDetails(block.textSignature, model.id);
          if (details) {
            if (native.reasoning_details) throw new Error("Duplicate Claude native assistant carriers");
            // DirectSDK compares the visible projection before restoring any signed native blocks.
            native.reasoning_details = details;
          }
        }
      }
      // Foreign thinking and provider signatures must not be sent as native Claude reasoning.
      messages.push(native);
    }
  }
  const request: NativeRequest = {
    model: model.id, messages, stream: true,
    tools: getCurrentTools(context.messages).map(tool => ({
      type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  };
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error("Claude max_tokens must be a positive safe integer");
    request.max_tokens = maxTokens;
  }
  return request;
}

/** Validate the completed envelope before any tools can become actionable. */
export function validateNativeResponse(value: unknown, model: string): asserts value is NativeResponse {
  if (!object(value) || value.model !== model || !Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new Error("Invalid Claude native response envelope");
  }
  const choice = value.choices[0];
  if (!object(choice) || !["stop", "tool_calls", "length", "content_filter"].includes(String(choice.finish_reason)) ||
    !object(choice.message) || (choice.message.content !== null && typeof choice.message.content !== "string") ||
    (choice.message.tool_calls != null && !Array.isArray(choice.message.tool_calls)) ||
    (choice.message.reasoning_content != null && typeof choice.message.reasoning_content !== "string") ||
    (choice.message.reasoning_details != null && !Array.isArray(choice.message.reasoning_details)) ||
    (choice.message.refusal != null && typeof choice.message.refusal !== "string")) {
    throw new Error("Invalid Claude native response choice");
  }
  const usage = object(value.usage) ? value.usage.native_usage : undefined;
  if (!object(usage) || !["input_tokens", "output_tokens"].every(k =>
    typeof usage[k] === "number" && Number.isSafeInteger(usage[k]) && usage[k] >= 0) ||
    !["cache_read_input_tokens", "cache_creation_input_tokens"].every(k => usage[k] === undefined ||
      (typeof usage[k] === "number" && Number.isSafeInteger(usage[k]) && usage[k] >= 0))) {
    throw new Error("Claude native response missing complete token usage");
  }
}

/** One CLI process group and one admitted upstream request per generation. Never return partial tool batches. */
export async function runNativeRequest(request: NativeRequest, options: {
  executable: string; signal?: AbortSignal;
  onText: (text: string) => void; onThinking: (text: string) => void;
}): Promise<NativeResponse> {
  const response = await runClaude(request, options);
  validateNativeResponse(response, request.model);
  return response;
}
