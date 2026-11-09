// MCP client bridge: connect stdio / Streamable HTTP / SSE MCP servers, expose their tools as pi-durable extensions.
// Only servers listed in config run. Stdio servers get a minimal environment (PATH, HOME, ...) plus their own `env`,
// never the daemon's full environment, so API keys and LUNA_TOKEN do not leak into third-party processes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineExtension, defineTool, type Extension, type Registry } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SettingsStore } from "./settings.js";
import { McpServerSchema, type LunaConfig } from "./config.js";

type Common = { name: string; enabled?: boolean; timeoutMs?: number; /** Tools hidden until tool_search loads them. Default true. */ defer?: boolean };
export type McpServerConfig = Common & (
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: "http" | "sse"; url: string; headers?: Record<string, string> }
);

export interface McpConnection {
  readonly name: string;
  readonly extension: Extension;
  readonly toolNames: string[];
  readonly toolDefs: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
  callTool(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const CALL_TIMEOUT_MS = 10 * 60_000;

function makeTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
      stderr: "ignore",
    });
  }
  const headers = cfg.headers;
  const requestInit = headers ? { headers } : undefined;
  if (cfg.transport === "http") return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit });
  return new SSEClientTransport(new URL(cfg.url), headers ? { requestInit, eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers as any), ...headers } }) } } : undefined);
}

/** Connect one MCP server, list its tools, and wrap them as an Extension `mcp-<name>` with tools `<name>__<tool>`. */
export async function connectMcpServer(cfg: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "luna-pi", version: "1.0.0" });
  await client.connect(makeTransport(cfg));
  try {
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    const prefix = sanitize(cfg.name);
    const defer = cfg.defer ?? true;
    const registered = tools.map((t) =>
      defineTool({
        name: `${prefix}__${sanitize(t.name)}`,
        description: `[mcp:${cfg.name}] ${t.description ?? t.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema ?? { type: "object", properties: {} }),
        ...(defer ? { deferred: true as const } : {}),
        async execute(args, _api, context) {
          const res: any = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: context.abortSignal, timeout: cfg.timeoutMs ?? CALL_TIMEOUT_MS });
          const content: any[] = Array.isArray(res.content) ? res.content : [{ type: "text", text: JSON.stringify(res.structuredContent ?? res) }];
          const output = content.map((c) =>
            c.type === "text" ? { type: "text" as const, text: String(c.text) }
            : c.type === "image" ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
            : { type: "text" as const, text: JSON.stringify(c) });
          return { output: output.length ? output : [{ type: "text" as const, text: "" }], isError: res.isError === true };
        },
      }),
    );
    const extension = defineExtension({ name: `mcp-${prefix}`, tools: registered });
    return {
      name: cfg.name,
      extension,
      toolNames: registered.map((t) => t.name),
      toolDefs: tools.map((t) => ({ name: String(t.name), description: t.description as string | undefined, inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown> })),
      callTool: (tool, args, signal) => client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: cfg.timeoutMs ?? CALL_TIMEOUT_MS }),
      close: () => client.close(),
    };
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

/**
 * MCP servers that back a selected native provider. DDGS sits behind web_search and web_extract;
 * its own tools duplicate them, so the model does not get them while a web setting selects DDGS.
 */
export function providerBackedServers(cfg: Pick<LunaConfig, "web">): Set<string> {
  const { web } = cfg;
  return new Set([web.searchProvider, ...web.searchFallbacks, web.extractProvider].includes("ddgs") ? [web.providers.ddgs.mcpServer] : []);
}

// ---------------------------------------------------------------- runtime management (web UI)

export interface McpServerInfo {
  name: string;
  source: "config" | "web";
  transport: McpServerConfig["transport"];
  /** Command line or URL without query string. Env values and headers are never returned, only their names. */
  target: string;
  secretKeys: string[];
  enabled: boolean;
  defer: boolean;
  status: "connected" | "failed" | "disabled";
  error?: string;
  tools: string[];
  /** True when the server only backs a native provider; its tools are not given to the model. */
  backend: boolean;
}

/**
 * Owns every MCP connection. The daemon saves all servers through SettingsStore.
 * Without a store, standalone callers retain fixed servers and the legacy web-server file.
 */
export class McpManager {
  private conns = new Map<string, McpConnection>();
  private errors = new Map<string, string>();
  private web: McpServerConfig[] = [];
  /** Servers whose tools are in the registry. A provider backend stays connected without model tools. */
  private installed = new Set<string>();

  /** `backends` names servers that only back a native provider, such as DDGS for web_search and web_extract. */
  constructor(private registry: Registry, private fixed: McpServerConfig[], private file?: string, private settings?: SettingsStore,
    private backends: () => ReadonlySet<string> = () => new Set()) {
    if (settings) { this.web = settings.resolved().mcpServers; this.fixed = []; return; }
    if (file && existsSync(file)) {
      try { this.web = (JSON.parse(readFileSync(file, "utf8")).servers ?? []).map((s: unknown) => McpServerSchema.parse(s)); }
      catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
    }
  }

  /** Native provider adapters reuse managed connections, credentials and timeouts. */
  async callTool(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const conn = this.conns.get(server);
    if (!conn) throw new Error(`MCP server "${server}" is not connected. Check its configuration and status.`);
    return conn.callTool(tool, args, signal);
  }

  /** Install model tools for connected servers that are not provider backends; remove them from backends. */
  syncExposure() {
    const backends = this.backends();
    for (const [name, c] of this.conns) {
      const want = !backends.has(name);
      if (want && !this.installed.has(name)) { this.registry.install(c.extension); this.installed.add(name); }
      else if (!want && this.installed.delete(name)) this.registry.uninstall(c.extension);
    }
  }

  get connections() { return [...this.conns.values()]; }
  get failures() { return [...this.errors].map(([name, error]) => ({ name, error })); }

  async start() {
    for (const cfg of [...this.fixed, ...this.web.filter((w) => !this.fixed.some((f) => f.name === w.name))]) await this.connect(cfg).catch(() => {});
  }

  private async connect(cfg: McpServerConfig) {
    this.errors.delete(cfg.name);
    if (cfg.enabled === false) return;
    try {
      const c = await connectMcpServer(cfg);
      this.conns.set(cfg.name, c);
      this.syncExposure();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errors.set(cfg.name, msg);
      throw new Error(msg);
    }
  }

  private async disconnect(name: string) {
    const c = this.conns.get(name);
    this.errors.delete(name);
    if (!c) return;
    this.conns.delete(name);
    if (this.installed.delete(name)) this.registry.uninstall(c.extension);
    await c.close().catch(() => {});
  }

  private save() {
    if (this.settings) { this.settings.update(s => { s.mcpServers = this.web; }); return; }
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ servers: this.web }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private all(): { cfg: McpServerConfig; source: "config" | "web" }[] {
    return [...this.fixed.map((cfg) => ({ cfg, source: "config" as const })), ...this.web.map((cfg) => ({ cfg, source: "web" as const }))];
  }

  list(): McpServerInfo[] {
    return this.all().map(({ cfg, source }) => {
      const conn = this.conns.get(cfg.name);
      const error = this.errors.get(cfg.name);
      let target: string, secretKeys: string[];
      if (cfg.transport === "stdio") { target = [cfg.command, ...(cfg.args ?? [])].join(" "); secretKeys = Object.keys(cfg.env ?? {}); }
      else { const u = new URL(cfg.url); target = u.origin + u.pathname; secretKeys = Object.keys(cfg.headers ?? {}); }
      return {
        name: cfg.name, source, transport: cfg.transport, target, secretKeys,
        enabled: cfg.enabled !== false, defer: cfg.defer ?? true,
        status: conn ? "connected" : error ? "failed" : "disabled",
        ...(error ? { error } : {}), tools: conn?.toolNames ?? [], backend: this.backends().has(cfg.name),
      };
    });
  }

  /** Validate, connect, then save. A server that cannot connect is not saved. */
  async add(input: unknown): Promise<McpServerInfo> {
    const r = McpServerSchema.safeParse(input);
    if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
    const cfg = r.data;
    if (this.all().some((s) => s.cfg.name === cfg.name)) throw new Error(`MCP server "${cfg.name}" already exists`);
    await this.connect(cfg);
    this.errors.delete(cfg.name);
    this.web.push(cfg);
    this.save();
    return this.list().find((s) => s.name === cfg.name)!;
  }

  private webServer(name: string) {
    const i = this.web.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(this.fixed.some((s) => s.name === name) ? `"${name}" comes from the config file; edit it there` : `no such MCP server "${name}"`);
    return i;
  }

  async setEnabled(name: string, enabled: boolean) {
    const i = this.webServer(name);
    const next = { ...this.web[i]!, enabled } as McpServerConfig;
    if (enabled) await this.connect(next); else await this.disconnect(name);
    this.web[i] = next;
    this.save();
    return this.list().find((s) => s.name === name)!;
  }

  async remove(name: string) {
    const i = this.webServer(name);
    await this.disconnect(name);
    this.web.splice(i, 1);
    this.save();
  }

  /** Apply saved settings: drop removed or changed servers, connect new or changed ones. Returns failures. */
  async reconcile(next: McpServerConfig[]): Promise<{ name: string; error: string }[]> {
    const key = (s: McpServerConfig) => JSON.stringify(s);
    const old = new Map(this.web.map((s) => [s.name, key(s)]));
    const keep = new Set(next.filter((s) => old.get(s.name) === key(s)).map((s) => s.name));
    for (const s of this.web) if (!keep.has(s.name)) await this.disconnect(s.name);
    this.web = structuredClone(next);
    const failed: { name: string; error: string }[] = [];
    for (const s of this.web) {
      if (keep.has(s.name)) continue;
      try { await this.connect(s); } catch (e) { failed.push({ name: s.name, error: (e as Error).message }); }
    }
    return failed;
  }

  async close() { await Promise.all([...this.conns.values()].map((c) => c.close().catch(() => {}))); }
}
