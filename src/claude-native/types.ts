// Shared contract for the in-process Claude native transport.
import type { ProviderLimit } from "../provider-limits.js";

/** One Anthropic content block. Unknown fields are carried through unchanged. */
export interface Block {
  type: string;
  [key: string]: unknown;
}

export interface NativeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Luna's model-visible transcript, converted by prepareNativeRequest. */
export interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Block[] | null;
  tool_calls?: NativeToolCall[];
  tool_call_id?: string;
  is_error?: boolean;
  reasoning_details?: unknown[];
}

export interface NativeTool {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface NativeRequest {
  model: string;
  messages: NativeMessage[];
  tools: NativeTool[];
  stream: true;
  max_tokens?: number;
}

export interface NativeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
  [key: string]: unknown;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface Projection {
  content: string;
  tool_calls: { id: string; name: string; input: unknown }[];
}

export interface NativeResponse {
  id?: string;
  model: string;
  choices: {
    finish_reason: FinishReason | string;
    message: {
      content: string | null;
      tool_calls?: NativeToolCall[] | null;
      reasoning_content?: string | null;
      reasoning_details?: unknown[] | null;
      refusal?: string | null;
    };
  }[];
  usage: {
    /** Claude Code's USD estimate for this fresh, single-generation CLI process. Not a subscription bill. */
    native_cost_usd: number;
    native_usage: NativeUsage;
    native_admission?: { upstream_requests: number; blocked_requests: number; request_id?: string | null; unrestored?: string };
  };
}

/** One stream-json frame written to the Claude CLI stdin. */
export interface Frame {
  type: "user" | "assistant";
  message: { role: "user" | "assistant"; content: Block[]; [key: string]: unknown };
  shouldQuery?: false;
}

/** Error with an HTTP-equivalent status: 503 CLI missing, 401 logged out, 429/402/529 native limits. */
export class ClaudeTransportError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly limit?: ProviderLimit) {
    super(message);
    this.name = "ClaudeTransportError";
  }
}
