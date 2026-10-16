// MCP client bridge: connect stdio / SSE MCP servers, expose their tools as pi-durable extensions.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defineExtension, defineTool, type Extension, type Registry } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export type McpServerConfig =
  | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { name: string; transport: "sse"; url: string; headers?: Record<string, string> };

export interface McpConnection {
  readonly name: string;
  readonly extension: Extension;
  readonly toolNames: string[];
  close(): Promise<void>;
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

function makeTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      cwd: cfg.cwd,
      env: cfg.env ? ({ ...process.env, ...cfg.env } as Record<string, string>) : undefined,
      stderr: "ignore",
    });
  }
  const headers = cfg.headers;
  return new SSEClientTransport(new URL(cfg.url), headers ? { requestInit: { headers }, eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers as any), ...headers } }) } } : undefined);
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
    const registered = tools.map((t) =>
      defineTool({
        name: `${prefix}__${sanitize(t.name)}`,
        description: t.description ?? `MCP tool ${t.name} from ${cfg.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema ?? { type: "object", properties: {} }),
        async execute(args, _api, context) {
          const res: any = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: context.abortSignal });
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

/** Connect all servers and install each as an extension in `registry`. A failing server is reported, not fatal. */
export async function installMcpServers(registry: Registry, configs: McpServerConfig[]) {
  const connections: McpConnection[] = [];
  const failures: { name: string; error: string }[] = [];
  for (const cfg of configs) {
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
