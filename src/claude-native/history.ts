// Native history, request body, and model routes. Port of directsdk.py / model_catalog.py (pinned MIT Hermes DirectSDK).
import { createHash } from "node:crypto";
import type { Block, Frame, NativeMessage, NativeRequest, Projection } from "./types.js";

/** Private to this transport: DirectSDK maps it back to Luna's names. It is part of signed replay content. */
export const TOOL_PREFIX = "mcp__hermes__";
export const CARRIER_TYPE = "claude-subscription-directsdk-experimental.native_assistant";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** Structural equality with Python dict semantics: key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** Python json.dumps(value, sort_keys=True, ensure_ascii=False) with default separators. */
function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(pythonJson).join(", ") + "]";
  if (isObject(value)) {
    // Python sorts by code point; JS default sort compares UTF-16 units, identical below U+10000 keys.
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ": " + pythonJson(value[k])).join(", ") + "}";
  }
  return JSON.stringify(value);
}

export function projection(message: { content: NativeMessage["content"]; tool_calls?: NativeMessage["tool_calls"] | null }): Projection {
  const calls = (message.tool_calls ?? []).map(call => ({
    id: call.id, name: call.function.name,
    input: typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments,
  }));
  return { content: (typeof message.content === "string" ? message.content : "").trim(), tool_calls: calls };
}

export function contentBlocks(content: NativeMessage["content"]): Block[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.map(block => {
    if (block.type === "image_url") {
      const url = (block.image_url as { url: string }).url;
      if (/^https?:\/\//i.test(url)) {
        // The transport never fetches. A hint keeps the turn alive where an error would fail every retry.
        return { type: "text", text: `[Image not attached: remote URL ${url}. Call vision_analyze with this URL to see it.]` };
      }
      if (!url.startsWith("data:") || !url.includes(";base64,")) throw new Error("Only base64 data image_url inputs are supported");
      const split = url.indexOf(";base64,");
      return { type: "image", source: { type: "base64", media_type: url.slice(5, split), data: url.slice(split + 8) } };
    }
    if (["text", "image", "document", "tool_result"].includes(block.type)) return structuredClone(block);
    throw new Error(`Unsupported content block: ${block.type}`);
  });
}

/**
 * A native session id that stays the same for every request of one conversation.
 * Derived from the system prompt and the first frame, which every request replays unchanged.
 * Byte-compatible with the Python transport, so existing conversations keep their cache prefix.
 */
export function conversationSessionId(system: string, frames: Frame[]): string {
  const digest = createHash("sha256").update(pythonJson([system, frames[0]?.message ?? null]), "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prepareHistory(messages: NativeMessage[], names?: Map<string, string>): { system: string; frames: Frame[] } {
  const system: string[] = [];
  const frames: Frame[] = [];
  for (const message of messages) {
    const role = message.role as string;
    if (role === "system" || role === "developer") {
      if (frames.length) throw new Error("System/developer messages must precede conversation history");
      if (typeof message.content !== "string") throw new Error("System content must be text");
      system.push(message.content);
      continue;
    }
    let blocks: Block[];
    let frameRole: "user" | "assistant";
    if (role === "assistant") {
      const carriers = (message.reasoning_details ?? []).filter((d): d is Json => isObject(d) && d.type === CARRIER_TYPE);
      if (carriers.length) {
        const carrier = carriers[0]!;
        if (carriers.length !== 1 || carrier.version !== 1) throw new Error("Unsupported native assistant carrier version");
        const signed = carrier.projection as Projection;
        if (deepEqual(projection(message), { ...signed, content: signed.content.trim() })) {
          for (const native of carrier.messages as Json[]) {
            const restored = structuredClone(native);
            // Native sizes its local "Prompt is too long" gate from the newest assistant usage; a replayed
            // frame would report the pre-compaction size. Usage is local metadata, never on the wire.
            delete restored.usage;
            frames.push({ type: "assistant", message: restored as Frame["message"] });
          }
          continue;
        }
        // Host compaction or hooks rewrote visible history: never attach old signatures to new content.
      }
      blocks = contentBlocks(message.content);
      for (const call of projection(message).tool_calls) {
        // A call outside the inventory replays as the model named it.
        const name = names === undefined || names.has(call.name) ? TOOL_PREFIX + (names?.get(call.name) ?? call.name) : call.name;
        blocks.push({ type: "tool_use", id: call.id, name, input: call.input });
      }
      frameRole = "assistant";
    } else if (role === "tool") {
      const result: Block = { type: "tool_result", tool_use_id: message.tool_call_id,
        content: typeof message.content === "string" ? message.content : contentBlocks(message.content) };
      if (message.is_error !== undefined && message.is_error !== null) result.is_error = Boolean(message.is_error);
      blocks = [result];
      frameRole = "user";
    } else if (role === "user") {
      blocks = contentBlocks(message.content);
      frameRole = "user";
    } else throw new Error(`Unsupported message role: ${role}`);
    const last = frames.at(-1);
    if (last && last.type === "user" && frameRole === "user") last.message.content.push(...blocks);
    else frames.push({ type: frameRole, message: { role: frameRole, content: blocks } });
  }
  const last = frames.at(-1);
  if (!last || last.type !== "user" || !last.message.content.length) {
    throw new Error("History must end in a nonempty user/tool-result message; assistant prefill is unsupported");
  }
  return { system: system.join("\n\n"), frames };
}

// Pinned native routes; a loopback gateway needs explicit long-context selection.
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-5-5": 1_000_000, "claude-sonnet-5": 1_000_000, "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000, "claude-opus-5-5": 1_000_000, "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000, "claude-fable-5-1": 1_000_000,
};
const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5", fable: "claude-fable-5-1",
};

/** The catalogued id a short name points at, or the name unchanged; an unknown route fails at the CLI, not here. */
function routeBase(base: string): string {
  if (Object.hasOwn(ALIASES, base) || Object.hasOwn(CONTEXT_WINDOWS, base)) return base;
  const dotted = base.replaceAll(".", "-");
  if (dotted !== base) return routeBase(dotted);
  const vendored = "claude-" + (base.startsWith("claude-") ? base.slice(7) : base);
  return Object.hasOwn(CONTEXT_WINDOWS, vendored) || Object.hasOwn(ALIASES, vendored) ? vendored : base;
}

export function nativeModel(model: string): string {
  const base = routeBase(model.endsWith("[1m]") ? model.slice(0, -4) : model);
  const canonical = ALIASES[base] ?? base;
  const window = CONTEXT_WINDOWS[canonical];
  if (window === 1_000_000) return canonical + "[1m]";
  if (window === 200_000) {
    if (model.endsWith("[1m]")) throw new Error("Haiku 4.5 does not support a 1M context window");
    return canonical;
  }
  return model;
}

/** The window the CLI actually runs `model` at: 1M only when nativeModel routes it to a `[1m]` variant. */
export function nativeContextWindow(model: string): number {
  try { return nativeModel(model).endsWith("[1m]") ? 1_000_000 : 200_000; }
  catch { return 200_000; }
}

/** Bottom-up map over a schema tree, as Hermes' schema_sanitizer._rewrite. Never mutates its input. */
function rewrite(schema: unknown, fn: (node: Json) => unknown): unknown {
  if (Array.isArray(schema)) return schema.map(item => rewrite(item, fn));
  if (!isObject(schema)) return schema;
  return fn(Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, rewrite(v, fn)])));
}

/** Hermes strip_nullable_unions(keep_nullable_hint=False): collapse a nullable union to its single non-null branch. */
function stripNullableUnions(schema: unknown): unknown {
  const collapse = (node: Json): unknown => {
    for (const key of ["anyOf", "oneOf"]) {
      const variants = node[key];
      if (!Array.isArray(variants)) continue;
      const nonNull = variants.filter(item => !(isObject(item) && item.type === "null"));
      if (nonNull.length === 1 && nonNull.length !== variants.length) {
        const replacement: Json = isObject(nonNull[0]) ? { ...nonNull[0] } : {};
        for (const meta of ["title", "description", "default", "examples"]) {
          if (meta in node && !(meta in replacement) && !(meta === "default" && "$ref" in replacement)) replacement[meta] = node[meta];
        }
        return rewrite(replacement, collapse); // The survivor may itself be a union.
      }
    }
    return node;
  };
  return rewrite(schema, collapse);
}

/** Anthropic hard-400s on top-level oneOf/allOf/anyOf and on nullable-union null branches. */
export function normalizeInputSchema(schema: Json): Json {
  let normalized = stripNullableUnions(schema) as Json;
  if (["oneOf", "allOf", "anyOf"].some(key => key in normalized)) {
    normalized = Object.fromEntries(Object.entries(normalized).filter(([key]) => !["oneOf", "allOf", "anyOf"].includes(key)));
    normalized.type ??= "object";
  }
  if (normalized.type === "object" && !isObject(normalized.properties)) normalized = { ...normalized, properties: {} };
  return normalized;
}

export interface ToolManifestEntry { name: string; description: string; inputSchema: Json }

/** The native extra body, the inert MCP inventory, and Luna -> native tool names. Both must advertise one shape. */
export function buildBody(request: NativeRequest): { body: string; manifest: ToolManifestEntry[]; names: Map<string, string> } {
  const body: Json = {};
  if (request.max_tokens !== undefined) {
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1) throw new Error("max_tokens must be a positive integer");
    body.max_tokens = request.max_tokens;
  }
  const manifest: ToolManifestEntry[] = [];
  const tools: Json[] = [];
  const names = new Map<string, string>();
  const natives = new Map<string, string>();
  for (const tool of request.tools ?? []) {
    if (tool.type !== "function") throw new Error("Only function tools are supported");
    const { name } = tool.function;
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || names.has(name)) {
      throw new Error("Tool names must be unique ASCII identifiers of at most 64 characters");
    }
    const native = name.length <= 50 ? name : name.slice(0, 41) + "_" + createHash("sha256").update(name).digest("hex").slice(0, 8);
    if (natives.has(native)) throw new Error(`Tool name collision: '${name}' and '${natives.get(native)}' map to '${native}'`);
    names.set(name, native);
    natives.set(native, name);
    const parameters = tool.function.parameters ?? { type: "object" };
    const description = tool.function.description ?? "";
    if (!isObject(parameters) || typeof description !== "string") throw new Error("Tool schema must be an object and description a string");
    const schema = normalizeInputSchema(parameters);
    manifest.push({ name: native, description, inputSchema: schema });
    tools.push({ name: TOOL_PREFIX + native, description, input_schema: schema });
  }
  body.tools = tools;
  return { body: JSON.stringify(body), manifest, names };
}
