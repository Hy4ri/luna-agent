import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getCurrentSystemPrompt, getCurrentTools,
  type ImageContent, type TextContent, type TranscriptContext,
} from "@earendil-works/pi-ai";

interface NativeBlock {
  type: string;
  [key: string]: unknown;
}
export interface NativeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface NativeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | NativeBlock[] | null;
  tool_calls?: NativeToolCall[];
  tool_call_id?: string;
  is_error?: boolean;
  reasoning_details?: unknown[];
}
export interface NativeRequest {
  model: string;
  messages: NativeMessage[];
  tools: { type: "function"; function: { name: string; description: string; parameters: object } }[];
  stream: true;
  max_tokens?: number;
}
export interface NativeResponse {
  id?: string;
  model: string;
  choices: {
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: NativeToolCall[] | null;
      reasoning_content?: string | null;
      reasoning_details?: unknown[] | null;
      refusal?: string | null;
    };
  }[];
  usage: {
    native_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: { ephemeral_1h_input_tokens?: number };
    };
    native_admission?: { upstream_requests: number; blocked_requests: number; unrestored?: string };
  };
}

const DEFAULT_MAX_PROMPT_BYTES = 128 * 1024;
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

function blocks(content: (TextContent | ImageContent)[]): NativeBlock[] {
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
  const configured = process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES;
  const limit = configured === undefined ? DEFAULT_MAX_PROMPT_BYTES : Number(configured);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("LUNA_CLAUDE_MAX_PROMPT_BYTES must be a positive safe integer");
  }
  const size = Buffer.byteLength(JSON.stringify(request), "utf8");
  if (size > limit) {
    throw new Error(`Claude CLI input is ${size} bytes; limit is ${limit} bytes. ` +
      "Compact this session with another provider, or start a new session, before retrying. Claude was not invoked.");
  }
  return request;
}

function aborted(): Error {
  return Object.assign(new Error("Claude request aborted"), { name: "AbortError" });
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

/** One bridge and one CLI process group per generation. Never return partial tool batches. */
export async function runNativeRequest(request: NativeRequest, options: {
  executable: string; signal?: AbortSignal;
  onText: (text: string) => void; onThinking: (text: string) => void;
}): Promise<NativeResponse> {
  if (options.signal?.aborted) throw aborted();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // Keep auth conflicts intact. The bridge refuses API-key/custom-backend fallback.
  const child = spawn(process.env.LUNA_CLAUDE_PYTHON ?? "python3", ["-B", "-u",
    fileURLToPath(new URL("./claude-native/bridge.py", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "", stderr = "";
    let response: NativeResponse | undefined;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref();
    };
    const abort = () => terminate(aborted());
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.on("error", error => { failure ??= error; });
    child.stdin.on("error", error => terminate(error));
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-32768); });
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      buffer += chunk;
      // A native signed final response is larger than a delta. Bound a single JSONL event.
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 * 1024) {
        terminate(new Error("Claude bridge event exceeds 16 MiB"));
        return;
      }
      let newline: number;
      while (!failure && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const event: unknown = JSON.parse(line);
          if (!object(event) || response) throw new Error("Unexpected or duplicate Claude bridge event");
          if (event.type === "delta" || event.type === "thinking") {
            if (typeof event.text !== "string") throw new Error("Invalid Claude bridge delta");
            if (event.type === "delta") options.onText(event.text);
            else options.onThinking(event.text);
          } else if (event.type === "response") {
            validateNativeResponse(event.response, request.model);
            response = event.response;
          } else if (event.type === "error") {
            throw Object.assign(new Error(typeof event.message === "string" ? event.message : "Claude bridge failed"),
              { statusCode: event.statusCode });
          } else throw new Error("Unknown Claude bridge event");
        } catch (error) {
          terminate(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Claude bridge exited with ${signal ?? code}: ${stderr.slice(-500)}`));
      else if (buffer.length) reject(new Error("Incomplete Claude bridge JSONL event"));
      else if (!response) reject(new Error("Claude bridge completed without a final response"));
      else resolve(response);
    });
    child.stdin.end(JSON.stringify({ command: options.executable, request }));
  });
}
