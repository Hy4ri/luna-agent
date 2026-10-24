// Per-worker MCP proxy: tools that exist only on a worker, namespaced by machine.
// Main MCP servers stay available. Worker tools are added when the worker connects and removed on disconnect.
// Every worker tool proxies via WorkerHub.mcpCall and never falls back to main. Offline → "Nothing ran".
import { defineExtension, defineTool, type Extension, type Registry } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { WorkerHub } from "./workers.js";

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export interface WorkerToolDef {
  name: string; // already sanitized tool name on worker, e.g. "my_tool"
  description?: string;
  inputSchema?: Record<string, unknown>;
  server: string; // worker server name, e.g. "my-server"
}

export class WorkerMcpProxy {
  private installed = new Map<number, Extension[]>();
  constructor(private hub: WorkerHub, private registry: Registry, private log: (m: string) => void = () => {}) {}

  attach() {
    this.hub.onConnect((id) => { void this.onConnect(id); });
    this.hub.onDisconnect((id) => this.onDisconnect(id));
    // If workers already online (e.g. hub created after attach), sync them.
    for (const w of this.hub.list().filter(w => w.online)) void this.onConnect(w.id);
  }

  private async onConnect(workerId: number) {
    // Remove stale first
    this.onDisconnect(workerId);
    let res;
    try { res = await this.hub.mcpList(workerId, BACKGROUND_CONTEXT); } catch (e) { this.log(`worker ${workerId} mcpList failed: ${(e as Error).message}`); return; }
    if (!res.ok) {
      // Offline or error: nothing to install. Offline text already contains "Nothing ran" but we don't install.
      return;
    }
    const defs = res.value as WorkerToolDef[] | unknown;
    if (!Array.isArray(defs) || defs.length === 0) return;
    const byServer = new Map<string, WorkerToolDef[]>();
    for (const d of defs as WorkerToolDef[]) {
      if (!d || typeof d.name !== "string" || typeof d.server !== "string") continue;
      const arr = byServer.get(d.server) ?? [];
      arr.push(d);
      byServer.set(d.server, arr);
    }
    const hub = this.hub;
    const extensions: Extension[] = [];
    for (const [server, tools] of byServer) {
      const prefix = `w${workerId}_${sanitize(server)}`;
      const registered = tools.map((t) => {
        const toolName = `${prefix}__${sanitize(t.name)}`;
        const schema = (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>;
        const serverName = server;
        const toolOrigName = t.name;
        return defineTool({
          name: toolName,
          description: `[mcp:${server} on worker ${workerId}] ${t.description ?? t.name}`,
          parameters: Type.Unsafe<Record<string, unknown>>(schema),
          deferred: true as const,
          async execute(args: Record<string, unknown>, _api: unknown, context: { abortSignal?: AbortSignal }) {
            const signal = context.abortSignal ?? new AbortController().signal;
            const raw = await hub.mcpCall(workerId, serverName, toolOrigName, args as Record<string, unknown>, { abortSignal: signal } as any);
            if (!raw.ok) throw (raw as { error: Error }).error;
            const res: any = raw.value;
            if (res && typeof res === "object" && Array.isArray((res as { content?: unknown[] }).content)) {
              const content: unknown[] = (res as { content: unknown[] }).content;
              const output = (content as any[]).map((c) =>
                c?.type === "text" ? { type: "text" as const, text: String(c.text) }
                : c?.type === "image" ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
                : { type: "text" as const, text: JSON.stringify(c) });
              return { output: output.length ? output : [{ type: "text" as const, text: "" }], isError: (res as { isError?: boolean }).isError === true };
            }
            return { output: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res) }] };
          },
        });
      });
      const ext = defineExtension({ name: `mcp-worker-${workerId}-${sanitize(server)}`, tools: registered });
      this.registry.install(ext);
      extensions.push(ext);
      this.log(`worker ${workerId} mcp: installed ${registered.length} tools from "${server}" as ${prefix}__*`);
    }
    if (extensions.length) this.installed.set(workerId, extensions);
  }

  private onDisconnect(workerId: number) {
    const exts = this.installed.get(workerId);
    if (!exts) return;
    for (const e of exts) try { this.registry.uninstall(e); } catch {}
    this.installed.delete(workerId);
    this.log(`worker ${workerId} mcp: removed ${exts.length} extensions`);
  }
}
