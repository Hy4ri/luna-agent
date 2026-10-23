// OpenCode owns the model call (its free tier only works from inside opencode); Luna owns tools and the transcript.
// Each Luna tool is exposed to opencode through a loopback MCP server. A tool call is held open until Luna has run the tool.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createProvider, createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt,
  type ProviderStreams, type AssistantMessage, type TextContent, type ThinkingContent, type ToolCall, type Message, type Tool,
} from "@earendil-works/pi-ai";

const run = promisify(execFile);
const PROVIDER_ID = "opencode-cli";
const MCP_NAME = "luna";
/** opencode tools Luna never wants the model to use. `read` must stay: the free tier rejects requests without it. */
const DENIED = ["shell", "edit", "write", "glob", "grep", "question", "skill", "subagent", "webfetch", "websearch", "execute"];
const HELD_TIMEOUT_MS = 55 * 60_000;
const IDLE_SWEEP_MS = 30 * 60_000;
const BATCH_DEBOUNCE_MS = 300;

export function opencodeExecutable() {
  return process.env.LUNA_OPENCODE_EXECUTABLE ?? "opencode";
}

// ------------------------------------------------------------------ opencode HTTP service

type Ev = { type: string; data?: any; [k: string]: unknown };
let service: { url: string; auth: string } | undefined;

async function ensureService() {
  if (service) {
    try { if ((await fetch(service.url + "/api/info", { headers: { authorization: service.auth } })).ok) return service; } catch { /* restart below */ }
    service = undefined;
  }
  const { stdout } = await run(opencodeExecutable(), ["service", "start"], { timeout: 30_000 });
  const url = stdout.match(/https?:\/\/[^\s]+/)?.[0];
  if (!url) throw new Error(`opencode service start printed no URL: ${stdout.trim().slice(0, 200)}`);
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "service.json");
  if (!existsSync(file)) throw new Error(`opencode service password file missing: ${file}`);
  const { password } = JSON.parse(readFileSync(file, "utf8")) as { password: string };
  service = { url: url.replace(/\/$/, ""), auth: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") };
  return service;
}

async function api(method: string, path: string, opts: { body?: unknown; dir?: string; signal?: AbortSignal; okStatuses?: number[] } = {}) {
  const s = await ensureService();
  const query = opts.dir ? `?location[directory]=${encodeURIComponent(opts.dir)}` : "";
  const res = await fetch(s.url + path + query, {
    method, signal: opts.signal,
    headers: { authorization: s.auth, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && !opts.okStatuses?.includes(res.status)) throw new Error(`opencode ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  if (!text) return undefined;
  try { return JSON.parse(text) as any; } catch { return text; }
}

// ------------------------------------------------------------------ conversations

interface Held { id: string; name: string; args: Record<string, unknown>; resolve: (r: { text: string; isError: boolean }) => void; at: number }

class Queue {
  private items: Ev[] = [];
  private waiter?: () => void;
  push(e: Ev) { this.items.push(e); this.waiter?.(); }
  async next(signal?: AbortSignal): Promise<Ev> {
    for (;;) {
      if (signal?.aborted) throw new Error("opencode request aborted");
      const e = this.items.shift();
      if (e) return e;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.waiter = undefined;
    }
  }
}

interface Conv {
  key: string; id: string; dir: string; toolsHash: string; tools: Tool[];
  sessionId?: string; queue: Queue; sse?: AbortController;
  held: Map<string, Held>; counter: number; lastUsed: number;
}

const convs = new Map<string, Conv>();
let mcpHttp: Promise<{ server: HttpServer; port: number }> | undefined;

function startMcp() {
  mcpHttp ??= new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const id = req.url?.match(/^\/mcp\/([\w-]+)/)?.[1];
        const conv = id ? [...convs.values()].find(c => c.id === id) : undefined;
        if (!conv) { res.statusCode = 404; return res.end(); }
        const mcp = new McpServer({ name: "luna", version: "1" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: conv.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters as any })),
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const held: Held = {
            id: `oc_${conv.id.slice(0, 8)}_${++conv.counter}`, name: request.params.name,
            args: (request.params.arguments ?? {}) as Record<string, unknown>, at: Date.now(), resolve: () => {},
          };
          const result = new Promise<{ text: string; isError: boolean }>((ok) => { held.resolve = ok; });
          conv.held.set(held.id, held);
          conv.queue.push({ type: "mcp.call", held });
          extra.signal.addEventListener("abort", () => { if (conv.held.delete(held.id)) held.resolve({ text: "cancelled", isError: true }); }, { once: true });
          const r = await result;
          return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        let body = ""; for await (const chunk of req) body += chunk;
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      } catch (error) {
        if (!res.headersSent) { res.statusCode = 500; res.end(String(error)); }
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
  return mcpHttp;
}

function hashTools(tools: Tool[]) {
  return createHash("sha256").update(JSON.stringify(tools.map(t => [t.name, t.description, t.parameters]))).digest("hex");
}

function textOf(content: string | { type: string; text?: string }[]) {
  if (typeof content === "string") return content;
  return content.map(c => c.type === "text" ? c.text ?? "" : `[${c.type} omitted]`).join("\n");
}

function conversationKey(messages: Message[], system: string, sessionId?: string) {
  if (sessionId) return `s:${sessionId}`;
  const first = messages.find(m => m.role === "user");
  return "h:" + createHash("sha256").update(system + "\n" + (first ? textOf(first.content as any) : "")).digest("hex");
}

/** Plain-text rendering of the transcript for a fresh opencode session. */
function renderPrompt(messages: Message[]): string {
  const turns = messages.filter(m => m.role !== "system");
  if (turns.length === 1 && turns[0]!.role === "user") return textOf(turns[0]!.content as any);
  const lines: string[] = ["Conversation so far (the last user or tool message is what you must answer now):", ""];
  for (const m of turns) {
    if (m.role === "user") lines.push(`[user]\n${textOf(m.content as any)}\n`);
    else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "text" && c.text) lines.push(`[assistant]\n${c.text}\n`);
        if (c.type === "toolCall") lines.push(`[assistant called tool ${c.name}] ${JSON.stringify(c.arguments)}\n`);
      }
    } else if (m.role === "toolResult") {
      lines.push(`[tool result ${m.toolName}${m.isError ? " (error)" : ""}]\n${textOf(m.content)}\n`);
    }
  }
  return lines.join("\n");
}

async function closeSession(conv: Conv, reason: string) {
  const sessionId = conv.sessionId;
  conv.sessionId = undefined;
  conv.sse?.abort();
  conv.sse = undefined;
  for (const held of conv.held.values()) held.resolve({ text: reason, isError: true });
  conv.held.clear();
  conv.queue = new Queue();
  if (sessionId) {
    await api("POST", `/api/session/${sessionId}/interrupt`, { okStatuses: [400, 404, 409] }).catch(() => {});
    await api("DELETE", `/api/session/${sessionId}`, { okStatuses: [400, 404] }).catch(() => {});
  }
}

async function dropConv(conv: Conv) {
  await closeSession(conv, "conversation closed");
  convs.delete(conv.key);
  await api("DELETE", `/api/experimental/mcp/${MCP_NAME}`, { dir: conv.dir, okStatuses: [400, 404] }).catch(() => {});
  rmSync(conv.dir, { recursive: true, force: true });
}

let sweeper: NodeJS.Timeout | undefined;
function startSweeper() {
  sweeper ??= setInterval(() => {
    const now = Date.now();
    for (const conv of convs.values()) {
      for (const held of conv.held.values()) {
        if (now - held.at > HELD_TIMEOUT_MS) { conv.held.delete(held.id); held.resolve({ text: "Luna did not return a result in time", isError: true }); }
      }
      if (!conv.held.size && now - conv.lastUsed > IDLE_SWEEP_MS) void dropConv(conv);
    }
  }, 60_000);
  sweeper.unref();
}

async function subscribe(conv: Conv, sessionId: string) {
  const s = await ensureService();
  const abort = new AbortController();
  conv.sse = abort;
  const queue = conv.queue;
  const res = await fetch(s.url + "/api/event", { headers: { authorization: s.auth }, signal: abort.signal });
  if (!res.ok || !res.body) throw new Error(`opencode event stream: ${res.status}`);
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const data = frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("");
          if (!data) continue;
          try {
            const ev = JSON.parse(data) as Ev;
            if (ev.data?.sessionID === sessionId) queue.push(ev);
          } catch { /* ignore malformed frame */ }
        }
      }
    } catch { /* aborted or closed */ }
    if (!abort.signal.aborted) queue.push({ type: "session.execution.failed", data: { sessionID: sessionId, error: { message: "opencode event stream closed" } } });
  })();
}

async function startSession(conv: Conv, model: { providerID: string; id: string }, system: string, prompt: string, signal?: AbortSignal) {
  await closeSession(conv, "superseded by a new request");
  const { port } = await startMcp();
  await api("PUT", `/api/experimental/mcp/${MCP_NAME}`, {
    dir: conv.dir, signal,
    body: { config: { type: "remote", url: `http://127.0.0.1:${port}/mcp/${conv.id}`, oauth: false, codemode: false,
      timeout: { execution: HELD_TIMEOUT_MS, catalog: 30_000, startup: 30_000 } } },
  });
  await api("POST", `/api/experimental/mcp/${MCP_NAME}/connect`, { dir: conv.dir, signal });
  const created = await api("POST", "/api/session", {
    signal,
    body: { model, location: { directory: conv.dir }, permissions: DENIED.map(action => ({ action, resource: "*", effect: "deny" })) },
  });
  const sessionId: string = created.data.id;
  conv.sessionId = sessionId;
  await subscribe(conv, sessionId);
  if (system) await api("PUT", `/api/experimental/session/${sessionId}/instructions/entries/luna-system`, { body: { value: system }, signal });
  await api("POST", `/api/session/${sessionId}/prompt`, { body: { text: prompt }, signal });
}

// ------------------------------------------------------------------ stream

function parseModel(id: string) {
  const i = id.indexOf("/");
  if (i <= 0) throw new Error(`opencode-cli model id must look like provider/model, got "${id}"`);
  return { providerID: id.slice(0, i), id: id.slice(i + 1) };
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
    let conv: Conv | undefined;
    try {
      events.push({ type: "start", partial: message });
      const messages = context.messages;
      const tools = getCurrentTools(messages);
      const system = getCurrentSystemPrompt(messages);
      const key = conversationKey(messages, system, options?.sessionId);
      conv = convs.get(key);
      if (!conv) {
        const id = randomUUID();
        const dir = join(tmpdir(), "luna-opencode", id);
        mkdirSync(dir, { recursive: true });
        conv = { key, id, dir, toolsHash: "", tools, queue: new Queue(), held: new Map(), counter: 0, lastUsed: Date.now() };
        convs.set(key, conv);
        startSweeper();
      }
      conv.lastUsed = Date.now();
      const toolsHash = hashTools(tools);
      const toolsChanged = toolsHash !== conv.toolsHash;
      conv.tools = tools; conv.toolsHash = toolsHash;

      // Continuation: the newest messages are Luna's results for the calls this conversation is holding.
      const tail: Extract<Message, { role: "toolResult" }>[] = [];
      for (let i = messages.length - 1; i >= 0 && messages[i]!.role === "toolResult"; i--) tail.push(messages[i] as any);
      const resumes = conv.sessionId && conv.held.size > 0 && !toolsChanged && [...conv.held.keys()].every(id => tail.some(r => r.toolCallId === id));
      if (resumes) {
        for (const result of tail) {
          const held = conv.held.get(result.toolCallId);
          if (!held) continue;
          conv.held.delete(held.id);
          held.resolve({ text: textOf(result.content), isError: result.isError });
        }
      } else {
        await startSession(conv, parseModel(model.id), system, renderPrompt(messages), options?.signal);
      }

      // Read opencode events until the model finishes or asks for tools.
      const batch: Held[] = [];
      let flushTimer: NodeJS.Timeout | undefined;
      let result: "stop" | "toolUse" = "stop";
      loop: for (;;) {
        const ev = await conv.queue.next(options?.signal);
        switch (ev.type) {
          case "session.text.delta": textDelta(String(ev.data.delta ?? "")); break;
          case "session.reasoning.delta": thinkingDelta(String(ev.data.delta ?? "")); break;
          case "session.step.ended": {
            const t = ev.data.tokens ?? {};
            message.usage.input += t.input ?? 0;
            message.usage.output += (t.output ?? 0) + (t.reasoning ?? 0);
            message.usage.cacheRead += t.cache?.read ?? 0;
            message.usage.cacheWrite += t.cache?.write ?? 0;
            break;
          }
          case "mcp.call":
            batch.push(ev.held as Held);
            clearTimeout(flushTimer);
            flushTimer = setTimeout(() => conv!.queue.push({ type: "mcp.flush" }), BATCH_DEBOUNCE_MS);
            break;
          case "mcp.flush":
            if (batch.length) { result = "toolUse"; break loop; }
            break;
          case "session.execution.succeeded": break loop;
          case "session.execution.failed":
            throw new Error(ev.data?.error?.message ?? `opencode execution failed: ${JSON.stringify(ev.data).slice(0, 300)}`);
          case "session.execution.interrupted": throw new Error("opencode execution interrupted");
        }
      }
      clearTimeout(flushTimer);
      message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;

      if (thinking) events.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking.thinking, partial: message });
      if (text) events.push({ type: "text_end", contentIndex: textIndex, content: text.text, partial: message });
      for (const held of batch) {
        const call: ToolCall = { type: "toolCall", id: held.id, name: held.name, arguments: held.args as ToolCall["arguments"] };
        const contentIndex = message.content.push(call) - 1;
        events.push({ type: "toolcall_start", contentIndex, partial: message });
        events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
      }
      message.stopReason = result === "toolUse" ? "toolUse" : "stop";
      if (result === "stop") await closeSession(conv, "finished");
      events.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      if (conv) await closeSession(conv, "request failed").catch(() => {});
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      events.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      events.end(message);
    }
  })();
  return events;
};

// ------------------------------------------------------------------ provider

async function listModels() {
  const res = await api("GET", "/api/model");
  return (res.data as any[]).filter(m => m.enabled !== false && m.capabilities?.tools !== false).map(m => ({
    id: `${m.providerID}/${m.modelID}`, name: `${m.name ?? m.modelID} (opencode)`,
    api: PROVIDER_ID as string, provider: PROVIDER_ID, baseUrl: "",
    input: (m.capabilities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    reasoning: false,
    contextWindow: m.limit?.context ?? 128_000, maxTokens: m.limit?.output ?? 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

/** Free opencode models known at build time; replaced by the live list when discovery runs. */
const FALLBACK = ["big-pickle", "beam-free", "deepseek-v4.1-flash-free", "flint-40b-free", "glm-5.3-flash-free",
  "mimo-v2.6-flash-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free"];

export function opencodeCliProvider() {
  return createProvider({
    id: PROVIDER_ID, name: "OpenCode (CLI)",
    auth: { apiKey: { name: "OpenCode CLI", resolve: async () =>
      (await run(opencodeExecutable(), ["--version"], { timeout: 10_000 }).then(() => true, () => false))
        ? { auth: {}, source: "opencode CLI" } : undefined } },
    models: FALLBACK.map(id => ({
      id: `opencode/${id}`, name: `${id} (opencode)`, api: PROVIDER_ID as string, provider: PROVIDER_ID, baseUrl: "",
      input: ["text" as const], reasoning: false, contextWindow: 200_000, maxTokens: 32_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    fetchModels: async ({ allowNetwork }) => (allowNetwork ? listModels() : []),
    api: { stream, streamSimple: stream },
  });
}
