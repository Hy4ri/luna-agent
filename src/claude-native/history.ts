// Native history, request body, and model routes.
import type { Block, Frame, NativeMessage, NativeReplayMetadata, NativeRequest, NativeTool, Projection } from "./types.js";

/** Private wire namespace, mapped back to Luna's tool names. It is part of signed replay content. */
export const TOOL_PREFIX = "mcp__luna__";
/** Read the namespace from saved native messages; never rename signed tool-use blocks. */
export function conversationToolPrefix(messages: NativeMessage[]): string {
  let prefix: string | undefined;
  const accept = (value: unknown) => {
    if (typeof value !== "string" || !/^mcp__[A-Za-z0-9_-]+__$/.test(value)) {
      throw new Error("Unsupported native tool prefix");
    }
    if (prefix !== undefined && prefix !== value) throw new Error("Conflicting native tool namespaces");
    prefix = value;
  };
  for (const message of messages) {
    for (const detail of message.reasoning_details ?? []) {
      if (!isObject(detail) || detail.type !== CARRIER_TYPE) continue;
      if (detail.wirePrefix !== undefined) accept(detail.wirePrefix);
      // Older carriers have no namespace marker. Infer it from their original tool-use names.
      if (!Array.isArray(detail.messages)) continue;
      for (const native of detail.messages) {
        if (!isObject(native) || !Array.isArray(native.content)) continue;
        for (const block of native.content) {
          if (!isObject(block) || block.type !== "tool_use" || typeof block.name !== "string") continue;
          const match = /^mcp__[A-Za-z0-9_-]+?__/.exec(block.name);
          if (match) accept(match[0]);
        }
      }
    }
  }
  return prefix ?? TOOL_PREFIX;
}
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
        return { type: "text", text: `[Image not attached: remote URL ${url}. Call media_analyze with this URL to see it.]` };
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
  const digest = new Bun.CryptoHasher("sha256").update(pythonJson([system, frames[0]?.message ?? null])).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prepareHistory(messages: NativeMessage[], names?: Map<string, string>, toolPrefix = conversationToolPrefix(messages)): {
  system: string; frames: Frame[]; assistantBoundaries: number[];
} {
  const system: string[] = [];
  const frames: Frame[] = [];
  const assistantBoundaries: number[] = [];
  let assistantCount = 0;
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
      assistantBoundaries.push(assistantCount);
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
            assistantCount++;
          }
          continue;
        }
        // Host compaction or hooks rewrote visible history: never attach old signatures to new content.
      }
      blocks = contentBlocks(message.content);
      for (const call of projection(message).tool_calls) {
        // A call outside the inventory replays as the model named it.
        const name = names === undefined || names.has(call.name) ? toolPrefix + (names?.get(call.name) ?? call.name) : call.name;
        blocks.push({ type: "tool_use", id: call.id, name, input: call.input });
      }
      frameRole = "assistant";
      assistantCount++;
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
  return { system: system.join("\n\n"), frames, assistantBoundaries };
}

// Pinned native routes; a loopback gateway needs explicit long-context selection.
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-5-5": 1_000_000, "claude-sonnet-5": 1_000_000, "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000, "claude-opus-5-5": 1_000_000, "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000, "claude-fable-5-1": 1_000_000, "claude-fable-5-2": 1_000_000,
};
/** Pinned native route ids; the CLI hides newer ones when nonessential traffic is off. */
export const NATIVE_ROUTE_IDS: readonly string[] = Object.keys(CONTEXT_WINDOWS);

const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5", fable: "claude-fable-5-2",
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

/** Bottom-up map over a schema tree. Never mutates its input. */
function rewrite(schema: unknown, fn: (node: Json) => unknown): unknown {
  if (Array.isArray(schema)) return schema.map(item => rewrite(item, fn));
  if (!isObject(schema)) return schema;
  return fn(Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, rewrite(v, fn)])));
}

/** Collapse a nullable union to its single non-null branch. */
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

/** Keep the live MCP inventory separate from the fixed initial API declarations. */
export function buildBody(request: NativeRequest, toolPrefix = conversationToolPrefix(request.messages)): {
  body: string; manifest: ToolManifestEntry[]; names: Map<string, string>; replayMetadata?: NativeReplayMetadata;
} {
  const body: Json = {};
  if (request.max_tokens !== undefined) {
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1) throw new Error("max_tokens must be a positive integer");
    body.max_tokens = request.max_tokens;
  }
  if (request.thinking !== undefined) body.thinking = request.thinking;
  if (request.output_config !== undefined) body.output_config = request.output_config;
  if (request.context_management !== undefined) body.context_management = request.context_management;

  const names = new Map<string, string>();
  const natives = new Map<string, string>();
  const nativeName = (name: string): string => {
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error("Tool names must be ASCII identifiers of at most 64 characters");
    }
    const known = names.get(name);
    if (known) return known;
    const native = name.length <= 50 ? name : name.slice(0, 41) + "_" + new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
    if (natives.has(native)) throw new Error(`Tool name collision: '${name}' and '${natives.get(native)}' map to '${native}'`);
    names.set(name, native);
    natives.set(native, name);
    return native;
  };
  const definition = (name: string, description: unknown, parameters: unknown): Json => {
    if (!isObject(parameters) || typeof description !== "string") throw new Error("Tool schema must be an object and description a string");
    return { name: toolPrefix + nativeName(name), description, input_schema: normalizeInputSchema(parameters) };
  };
  const definitions = (tools: NativeTool[]): Json[] => {
    const seen = new Set<string>();
    return tools.map(tool => {
      if (tool.type !== "function" || seen.has(tool.function.name)) throw new Error("Tool inventories require unique function names");
      seen.add(tool.function.name);
      return definition(tool.function.name, tool.function.description ?? "", tool.function.parameters ?? { type: "object" });
    });
  };

  const current = definitions(request.tools);
  const manifest: ToolManifestEntry[] = current.map(tool => ({ name: String(tool.name).slice(toolPrefix.length),
    description: tool.description as string, inputSchema: tool.input_schema as Json }));
  let replayMetadata: NativeReplayMetadata | undefined;
  if (request.replayMetadata) {
    const { initialTools, systemInjections, betas } = request.replayMetadata;
    const initial = initialTools ? definitions(initialTools) : undefined;
    if (initial?.length) {
      initial.at(-1)!.cache_control = { type: "ephemeral", ttl: "1h" };
      body.tools = [...initial, { name: "__pi_deferred_placeholder__",
        description: "Reserved placeholder. Never available. Never call this.",
        input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true }];
    }
    replayMetadata = {
      betas,
      systemInjections: systemInjections?.map(injection => ({ ...injection, content: injection.content.map(block => {
        if (block.type === "tool_addition") {
          const tool = block.tool as { definition: { name: string; description: unknown; input_schema: unknown } };
          const d = tool.definition;
          return { type: "tool_addition", tool: { type: "tool_definition", definition: definition(d.name, d.description, d.input_schema) } };
        }
        if (block.type === "tool_removal") {
          const tool = block.tool as { name: string };
          return { type: "tool_removal", tool: { type: "tool_reference", name: toolPrefix + nativeName(tool.name) } };
        }
        return structuredClone(block);
      }) })),
    };
  }
  body.tools ??= current;
  return { body: JSON.stringify(body), manifest, names, replayMetadata };
}
