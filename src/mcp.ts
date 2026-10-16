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

type Common = { name: string; enabled?: boolean; /** Tools hidden until tool_search loads them. Default true. */ defer?: boolean };
export type McpServerConfig = Common & (
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: "http" | "sse"; url: string; headers?: Record<string, string> }
);

export interface McpConnection {
  readonly name: string;
  readonly extension: Extension;
  readonly toolNames: string[];
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
          const res: any = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: context.abortSignal, timeout: CALL_TIMEOUT_MS });
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
      close: () => client.close(),
    };
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

/** Connect enabled servers and install each as an extension in `registry`. A failing server is reported, not fatal. */
export async function installMcpServers(registry: Registry, configs: McpServerConfig[]) {
  const connections: McpConnection[] = [];
  const failures: { name: string; error: string }[] = [];
  for (const cfg of configs) {
    if (cfg.enabled === false) continue;
    try {
      const c = await connectMcpServer(cfg);
      registry.install(c.extension);
      connections.push(c);
    } catch (e) {
      failures.push({ name: cfg.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { connections, failures, close: async () => { await Promise.all(connections.map((c) => c.close().catch(() => {}))); } };
}
