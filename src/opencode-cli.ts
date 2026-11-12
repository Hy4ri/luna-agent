// OpenCode owns the model call (its free tier only works from inside opencode); Luna owns tools and the transcript.
// Each Luna tool is exposed to opencode through a loopback MCP server. A tool call is held open until Luna has run the tool.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  calculateCost, createProvider, createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt,
  type ProviderStreams, type AssistantMessage, type TextContent, type ToolCall, type Message, type Tool, type ImageContent,
} from "@earendil-works/pi-ai";
import { createStreamDeltas } from "./cli-stream.js";
import { costFor, type ModelCost } from "./model-pricing.js";

async function runCli(cmd: string, args: string[], options: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout) {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, options.timeout);
  }
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (exitCode !== 0) {
    const err = new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderrText}`);
    (err as any).code = exitCode;
    throw err;
  }
  return { stdout: stdoutText, stderr: stderrText };
}
const PROVIDER_ID = "opencode-cli";
const MCP_NAME = "luna";
/** opencode tools Luna never wants the model to use. `read` must stay: the free tier rejects requests without it. */
const DENIED = ["shell", "edit", "write", "glob", "grep", "question", "skill", "subagent", "webfetch", "websearch", "execute"];
const HELD_TIMEOUT_MS = 55 * 60_000;
const IDLE_SWEEP_MS = 30 * 60_000;
const BATCH_DEBOUNCE_MS = 300;
const API_TIMEOUT_MS = 30_000;
/** The opencode routes used here are marked experimental. Refuse to run when one is gone. */
const TESTED_VERSION = "2.1";
const REQUIRED_ROUTES = ["/api/session", "/api/session/{sessionID}/prompt", "/api/session/{sessionID}/interrupt",
  "/api/experimental/mcp/{server}", "/api/experimental/mcp/{server}/connect", "/api/event", "/api/model",
  "/api/experimental/session/{sessionID}/instructions/entries/{key}"];

export function opencodeExecutable() {
  return process.env.LUNA_OPENCODE_EXECUTABLE ?? "opencode";
}

// ------------------------------------------------------------------ opencode HTTP service

type Ev = { type: string; data?: any; [k: string]: unknown };
// Keyed by executable and password file: a changed setting must not reuse another opencode's service.
let service: { url: string; auth: string; key: string } | undefined;

async function ensureService() {
  const executable = opencodeExecutable();
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "service.json");
  const key = `${executable}\0${file}`;
  if (service?.key === key) {
    try { if ((await fetch(service.url + "/api/info", { headers: { authorization: service.auth } })).ok) return service; } catch { /* restart below */ }
  }
  service = undefined;
  const { stdout } = await runCli(executable, ["service", "start"], { timeout: 30_000 });
  const url = stdout.match(/https?:\/\/[^\s]+/)?.[0];
  if (!url) throw new Error(`opencode service start printed no URL: ${stdout.trim().slice(0, 200)}`);
  if (!existsSync(file)) throw new Error(`opencode service password file missing: ${file}`);
  const { password } = JSON.parse(readFileSync(file, "utf8")) as { password: string };
  const found = { url: url.replace(/\/$/, ""), auth: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), key };
  await checkRoutes(found);
  service = found;
  return service;
}

/** Fails with a clear message when the running opencode no longer offers the routes this provider needs. */
async function checkRoutes(s: { url: string; auth: string }) {
  const get = async (path: string) => {
    const res = await fetch(s.url + path, { headers: { authorization: s.auth }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`opencode ${path}: ${res.status}`);
    return res.json() as Promise<any>;
  };
  const [info, spec] = await Promise.all([get("/api/info"), get("/openapi.json")]);
  const missing = REQUIRED_ROUTES.filter(r => !spec.paths?.[r]);
  if (missing.length) {
    throw new Error(`opencode ${info.version ?? "?"} lacks routes this provider needs (${missing.join(", ")}). Tested with ${TESTED_VERSION}.x.`);
  }
}

async function api(method: string, path: string, opts: { body?: unknown; dir?: string; signal?: AbortSignal; okStatuses?: number[] } = {}) {
  const s = await ensureService();
  const query = opts.dir ? `?location[directory]=${encodeURIComponent(opts.dir)}` : "";
  const signal = AbortSignal.any([AbortSignal.timeout(API_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
  const res = await fetch(s.url + path + query, {
    method, signal,
    headers: { authorization: s.auth, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok && !opts.okStatuses?.includes(res.status)) throw new Error(`opencode ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  if (!text) return undefined;
  try { return JSON.parse(text) as any; } catch { return text; }
}

/** Turns an opencode failure event into a message that says what to do. */
export function failureMessage(error: any): string {
  const status: number | undefined = error?.status;
  const message: string = error?.message ?? "opencode execution failed";
  if (status === 429) return `opencode rate limit (429): ${message}. Free models are throttled; wait or pick another model.`;
  if (status === 403 && /free tier/i.test(message)) return `opencode refused the request (403): ${message} Free models only work from a real opencode session; check that opencode is logged in and updated.`;
  if (status === 401 || status === 403) return `opencode auth error (${status}): ${message}`;
  if (status && status >= 500) return `opencode upstream error (${status}): ${message}`;
  return status ? `opencode error (${status}): ${message}` : message;
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
  held: Map<string, Held>; counter: number; lastUsed: number; images: number;
  /** Signal of the request reading this conversation now. A second live request must not take the session over. */
  active?: AbortSignal;
  /** A side conversation for one request that overlapped a live one. Dropped when that request ends. */
  transient?: boolean;
  /** What the live opencode session already holds, so a follow-up can send only the new user message. */
  sent?: { model: string; systemHash: string; count: number; firstHash: string; reply: string };
}

const convs = new Map<string, Conv>();
let mcpHttp: Promise<{ server: ReturnType<typeof Bun.serve>; port: number }> | undefined;

function startMcp() {
  mcpHttp ??= Promise.resolve().then(() => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      // Tool calls are held open until Luna finishes running them (can take minutes with no bytes flowing).
      idleTimeout: 0,
      async fetch(req) {
        try {
          const url = new URL(req.url);
          const id = url.pathname.match(/^\/mcp\/([\w-]+)/)?.[1];
          const conv = id ? [...convs.values()].find(c => c.id === id) : undefined;
          if (!conv) return new Response(null, { status: 404 });
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
          const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const close = () => { void transport.close(); void mcp.close(); };
          req.signal.addEventListener("abort", close, { once: true });
          await mcp.connect(transport);
          const body = req.method === "POST" ? await req.text() : "";
          const response = await transport.handleRequest(req, body ? { parsedBody: JSON.parse(body) } : undefined);
          if (!response.body) { close(); return response; }
          const stream = response.body.pipeThrough(new TransformStream({ flush() { close(); } }));
          return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
        } catch (error) {
          return new Response(String(error), { status: 500 });
        }
      },
    });
    server.unref();
    return { server, port: server.port! };
  });
  return mcpHttp;
}

function hashTools(tools: Tool[]) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(tools.map(t => [t.name, t.description, t.parameters]))).digest("hex");
}

function textOf(content: string | { type: string; text?: string }[]) {
  if (typeof content === "string") return content;
  return content.map(c => c.type === "text" ? c.text ?? "" : `[${c.type} omitted]`).join("\n");
}

function conversationKey(messages: Message[], system: string, sessionId?: string) {
  if (sessionId) return `s:${sessionId}`;
  const first = messages.find(m => m.role === "user");
  return "h:" + new Bun.CryptoHasher("sha256").update(system + "\n" + (first ? textOf(first.content as any) : "")).digest("hex");
}

type Attached = { uri: string; name: string };

/** Writes images into the scratch dir and returns file:// attachments the opencode prompt route accepts. */
function attachImages(conv: Conv, images: ImageContent[]): Attached[] {
  return images.map((img) => {
    const ext = img.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
    const name = `image-${++conv.images}.${ext}`;
    const path = join(conv.dir, name);
    writeFileSync(path, Buffer.from(img.data, "base64"));
    return { uri: pathToFileURL(path).href, name };
  });
}

function userParts(content: string | (TextContent | ImageContent)[]) {
  if (typeof content === "string") return { text: content, images: [] as ImageContent[] };
  const images = content.filter((c): c is ImageContent => c.type === "image");
  return { text: content.filter((c): c is TextContent => c.type === "text").map(c => c.text).join("\n"), images };
}

/** Prompt for a fresh opencode session: the whole transcript as text, plus the user images when the model can see them. */
function renderPrompt(conv: Conv, messages: Message[], vision: boolean): { text: string; files: Attached[] } {
  const turns = messages.filter(m => m.role !== "system");
  const images: ImageContent[] = [];
  const note = (n: number) => vision ? `[image attached: see attachment ${n}]` : "[image omitted: this model cannot see images]";
  const userText = (m: Extract<Message, { role: "user" }>) => {
    const parts = userParts(m.content);
    const marks = parts.images.map(img => { if (vision) images.push(img); return note(images.length); });
    return [parts.text, ...marks].filter(Boolean).join("\n");
  };
  if (turns.length === 1 && turns[0]!.role === "user") {
    const text = userText(turns[0] as any);
    return { text, files: attachImages(conv, images) };
  }
  const lines: string[] = ["Conversation so far (the last user or tool message is what you must answer now):", ""];
  for (const m of turns) {
    if (m.role === "user") lines.push(`[user]\n${userText(m)}\n`);
    else if (m.role === "assistant") {
      for (const c of m.content) {
        if (c.type === "text" && c.text) lines.push(`[assistant]\n${c.text}\n`);
        if (c.type === "toolCall") lines.push(`[assistant called tool ${c.name}] ${JSON.stringify(c.arguments)}\n`);
      }
    } else if (m.role === "toolResult") {
      lines.push(`[tool result ${m.toolName}${m.isError ? " (error)" : ""}]\n${textOf(m.content)}\n`);
    }
  }
  // Only the newest images are attached; older ones keep their text marker.
  const keep = images.slice(-4);
  return { text: lines.join("\n"), files: attachImages(conv, keep) };
}

const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** The new user message after the part opencode already holds, when the history is an exact continuation. */
function followUp(conv: Conv, messages: Message[], model: string, system: string, vision: boolean): { text: string; files: Attached[] } | undefined {
  const sent = conv.sent;
  if (!sent || !conv.sessionId || conv.held.size) return undefined;
  const turns = messages.filter(m => m.role !== "system");
  if (sent.model !== model || sent.systemHash !== sha(system)) return undefined;
  if (turns.length <= sent.count + 1 || sha(textOf((turns[0] as any).content ?? "")) !== sent.firstHash) return undefined;
  const reply = turns[sent.count];
  if (!reply || reply.role !== "assistant") return undefined;
  const replyText = reply.content.filter((c): c is TextContent => c.type === "text").map(c => c.text).join("");
  if (replyText !== sent.reply) return undefined;
  const rest = turns.slice(sent.count + 1);
  if (!rest.every(m => m.role === "user")) return undefined;
  const images: ImageContent[] = [];
  const text = rest.map((m: any) => {
    const parts = userParts(m.content);
    const marks = parts.images.map(img => { if (vision) images.push(img); return vision ? `[image attached: see attachment ${images.length}]` : "[image omitted: this model cannot see images]"; });
    return [parts.text, ...marks].filter(Boolean).join("\n");
  }).join("\n\n");
  return { text, files: attachImages(conv, images) };
}

async function closeSession(conv: Conv, reason: string) {
  const sessionId = conv.sessionId;
  conv.sessionId = undefined;
  conv.sent = undefined;
  conv.sse?.abort();
  conv.sse = undefined;
  // A request still reading the old queue must fail now, not wait for events that can no longer arrive.
  conv.queue.push({ type: "session.execution.failed", data: { error: { message: `opencode session closed: ${reason}` } } });
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
function newConv(key: string, tools: Tool[], transient = false): Conv {
  const id = crypto.randomUUID();
  const dir = join(tmpdir(), "luna-opencode", id);
  mkdirSync(dir, { recursive: true });
  const conv: Conv = { key, id, dir, toolsHash: "", tools, queue: new Queue(), held: new Map(), counter: 0, lastUsed: Date.now(), images: 0, ...(transient ? { transient } : {}) };
  convs.set(key, conv);
  startSweeper();
  return conv;
}

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

async function startSession(conv: Conv, model: { providerID: string; id: string }, system: string, prompt: { text: string; files: Attached[] }, signal?: AbortSignal) {
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
  await sendPrompt(sessionId, prompt, signal);
}

async function sendPrompt(sessionId: string, prompt: { text: string; files: Attached[] }, signal?: AbortSignal) {
  await api("POST", `/api/session/${sessionId}/prompt`, { body: { text: prompt.text, ...(prompt.files.length ? { files: prompt.files } : {}) }, signal });
}

// ------------------------------------------------------------------ stream

function parseModel(id: string, variant?: string) {
  const i = id.indexOf("/");
  if (i <= 0) throw new Error(`opencode-cli model id must look like provider/model, got "${id}"`);
  return { providerID: id.slice(0, i), id: id.slice(i + 1), ...(variant ? { variant } : {}) };
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** opencode's name for "no variant": the model runs at its own default effort. */
const DEFAULT_VARIANT = "default";

/**
 * Luna thinking levels for an opencode model, from the variants opencode reports (the ACP "effort" option).
 * Each listed effort maps to itself; other levels clamp. Off sends "none" when offered, else no variant.
 */
export function variantLevels(variants: unknown): { reasoning: boolean; thinkingLevelMap?: Partial<Record<(typeof LEVELS)[number], string | null>> } {
  const ids = Array.isArray(variants) ? variants.map(v => v?.id).filter((v): v is string => typeof v === "string") : [];
  if (!ids.length) return { reasoning: false };
  const map: Partial<Record<(typeof LEVELS)[number], string | null>> = { off: ids.includes("none") ? "none" : DEFAULT_VARIANT };
  for (const level of LEVELS.slice(1)) map[level] = ids.includes(level) ? level : null;
  return { reasoning: true, thinkingLevelMap: map };
}

/** The variant to send for the requested level, or undefined for the model default. */
export function variantFor(model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null | undefined> }, level: string | undefined): string | undefined {
  if (!model.reasoning || !level) return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  return mapped && mapped !== DEFAULT_VARIANT ? mapped : undefined;
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
    let conv: Conv | undefined;
    let queue: Queue | undefined;
    try {
      events.push({ type: "start", partial: message });
      const messages = context.messages;
      const tools = getCurrentTools(messages);
      const system = getCurrentSystemPrompt(messages);
      const key = conversationKey(messages, system, options?.sessionId);
      conv = convs.get(key) ?? newConv(key, tools);
      // Another request with the same session ID is still running, such as a background compaction summary next to the
      // generation. Give this one its own opencode session so neither closes the other's.
      if (conv.active && !conv.active.aborted) conv = newConv(`${key}:side:${crypto.randomUUID()}`, tools, true);
      conv.active = options?.signal ?? new AbortController().signal;
      conv.lastUsed = Date.now();
      const variant = variantFor(model as any, options?.reasoning);
      const modelKey = variant ? `${model.id}#${variant}` : model.id;
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
        const vision = model.input.includes("image");
        const next = followUp(conv, messages, modelKey, system, vision);
        if (next) {
          // The live session already holds the earlier turns: send only the new user message.
          try {
            conv.queue = new Queue();
            conv.sse?.abort();
            await subscribe(conv, conv.sessionId!);
            await sendPrompt(conv.sessionId!, next, options?.signal);
          } catch (error) {
            if (options?.signal?.aborted) throw error;
            // The session is gone or unreachable: replay the transcript into a new one.
            await startSession(conv, parseModel(model.id, variant), system, renderPrompt(conv, messages, vision), options?.signal);
          }
        } else {
          await startSession(conv, parseModel(model.id, variant), system, renderPrompt(conv, messages, vision), options?.signal);
        }
      }

      // Read opencode events until the model finishes or asks for tools.
      const batch: Held[] = [];
      let flushTimer: NodeJS.Timeout | undefined;
      let result: "stop" | "toolUse" = "stop";
      // Read the queue this request set up. closeSession fails it when another request replaces the session.
      queue = conv.queue;
      loop: for (;;) {
        const ev = await queue.next(options?.signal);
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
            flushTimer = setTimeout(() => queue!.push({ type: "mcp.flush" }), BATCH_DEBOUNCE_MS);
            break;
          case "mcp.flush":
            if (batch.length) { result = "toolUse"; break loop; }
            break;
          case "session.execution.succeeded": break loop;
          case "session.execution.failed":
            throw new Error(ev.data?.error ? failureMessage(ev.data.error) : `opencode execution failed: ${JSON.stringify(ev.data).slice(0, 300)}`);
          case "session.execution.interrupted": throw new Error("opencode execution interrupted");
        }
      }
      clearTimeout(flushTimer);
      message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      // Rates come from the model entry: OpenCode's listed price, a catalog estimate by name, or zero.
      calculateCost(model, message.usage);

      const thinking = getThinking();
      const text = getText();
      if (thinking) events.push({ type: "thinking_end", contentIndex: getThinkingIndex(), content: thinking.thinking, partial: message });
      if (text) events.push({ type: "text_end", contentIndex: getTextIndex(), content: text.text, partial: message });
      for (const held of batch) {
        const call: ToolCall = { type: "toolCall", id: held.id, name: held.name, arguments: held.args as ToolCall["arguments"] };
        const contentIndex = message.content.push(call) - 1;
        events.push({ type: "toolcall_start", contentIndex, partial: message });
        events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
      }
      message.stopReason = result === "toolUse" ? "toolUse" : "stop";
      if (result === "stop") {
        // Keep the session: the next user message can continue it instead of replaying the transcript.
        const turns = messages.filter(m => m.role !== "system");
        conv.sent = { model: modelKey, systemHash: sha(system), count: turns.length, firstHash: sha(textOf((turns[0] as any)?.content ?? "")), reply: text?.text ?? "" };
      }
      events.push({ type: "done", reason: message.stopReason, message });
    } catch (error) {
      // Close the session only while it is still this request's; a replaced one belongs to the newer request.
      if (conv && (!queue || conv.queue === queue)) await closeSession(conv, "request failed").catch(() => {});
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      events.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      if (conv) {
        conv.active = undefined;
        if (conv.transient) void dropConv(conv);
      }
      events.end(message);
    }
  })();
  return events;
};

// ------------------------------------------------------------------ provider

/** OpenCode's own base price ($ per million tokens, first entry of `cost`), when it lists one. */
export function listedCost(cost: unknown): ModelCost | undefined {
  const base = Array.isArray(cost) ? cost[0] : undefined;
  const rate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = rate(base?.input), output = rate(base?.output);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: rate(base.cache?.read) ?? 0, cacheWrite: rate(base.cache?.write) ?? 0 };
}

async function listModels() {
  const res = await api("GET", "/api/model");
  return (res.data as any[]).filter(m => m.enabled !== false && m.capabilities?.tools !== false).map(m => ({
    id: `${m.providerID}/${m.modelID}`, name: `${m.name ?? m.modelID} (opencode)`,
    api: PROVIDER_ID as string, provider: PROVIDER_ID, baseUrl: "",
    input: (m.capabilities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    ...variantLevels(m.variants),
    contextWindow: m.limit?.context ?? 128_000, maxTokens: m.limit?.output ?? 32_000,
    cost: listedCost(m.cost) ?? costFor(`${m.providerID}/${m.modelID}`),
  }));
}

/** Free opencode models known at build time; replaced by the live list when discovery runs. */
const FALLBACK = ["big-pickle", "beam-free", "deepseek-v4.1-flash-free", "flint-40b-free", "glm-5.3-flash-free",
  "mimo-v2.6-flash-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free"];

/** Fallback models that accept images (the live list reports this itself). */
const FALLBACK_VISION = new Set(["deepseek-v4.1-flash-free", "glm-5.3-flash-free", "mimo-v2.6-flash-free", "nemotron-3.5-super-vl-free"]);

let versionCheck: { executable: string; expires: number; promise: Promise<boolean>; settled?: boolean } | undefined;
export function invalidateOpencodeStatus() { versionCheck = undefined; }
function checkOpencodeAvailable(): Promise<boolean> {
  const executable = opencodeExecutable();
  if (versionCheck?.executable === executable && versionCheck.expires > Date.now()) return versionCheck.promise;
  // Expired check for the same executable: answer with the last result and re-check in the background,
  // so a request never waits for the ~200 ms `opencode --version` spawn after the first one.
  const stale = versionCheck?.executable === executable && versionCheck.settled ? versionCheck.promise : undefined;
  const entry: NonNullable<typeof versionCheck> = { executable, expires: Date.now() + 60_000, promise: Promise.resolve(false) };
  const check = runCli(executable, ["--version"], { timeout: 10_000 }).then(() => true, () => {
    if (versionCheck === entry) versionCheck = undefined;
    return false;
  }).finally(() => { entry.settled = true; });
  entry.promise = check;
  if (stale) {
    // Keep serving the stale result until the new check settles.
    entry.promise = stale;
    void check.then(ok => { if (versionCheck === entry) entry.promise = Promise.resolve(ok); });
  }
  versionCheck = entry;
  return entry.promise;
}

export function opencodeCliProvider() {
  return createProvider({
    id: PROVIDER_ID, name: "OpenCode (CLI)",
    auth: { apiKey: { name: "OpenCode CLI",
      check: async () => await checkOpencodeAvailable() ? { type: "api_key" as const, source: "opencode CLI" } : undefined,
      resolve: async () =>
      (await runCli(opencodeExecutable(), ["--version"], { timeout: 10_000 }).then(() => true, () => false))
        ? { auth: {}, source: "opencode CLI" } : undefined } },
    models: FALLBACK.map(id => ({
      id: `opencode/${id}`, name: `${id} (opencode)`, api: PROVIDER_ID as string, provider: PROVIDER_ID, baseUrl: "",
      input: (FALLBACK_VISION.has(id) ? ["text", "image"] : ["text"]) as ("text" | "image")[], reasoning: false, contextWindow: 200_000, maxTokens: 32_000,
      cost: costFor(id),
    })),
    fetchModels: async ({ allowNetwork }) => (allowNetwork ? listModels() : []),
    api: { stream, streamSimple: stream },
  });
}
