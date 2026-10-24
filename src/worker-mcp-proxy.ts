// Per-worker MCP proxy: MCP servers configured on a worker appear as `w<id>_<server>__<tool>` tools.
// They are deferred, proxied through WorkerHub.mcpCall, and usable only in sessions bound to that worker.
// The tools stay registered while the worker is offline, so a call fails with "Nothing ran" and never reaches main.
import { defineExtension, defineTool, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { WORKER_ENV_PREFIX } from "./worker-protocol.js";
import type { WorkerHub } from "./workers.js";
import type { WorkerToolDef } from "./worker-services.js";

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const EXTENSION = "worker-mcp";
const workerOf = (env: { id: string } | undefined) => {
  if (!env?.id.startsWith(WORKER_ENV_PREFIX)) return undefined;
  const id = Number(env.id.slice(WORKER_ENV_PREFIX.length));
  return Number.isSafeInteger(id) ? id : undefined;
};

export class WorkerMcpProxy {
  /** Last known tools per worker. Kept across disconnects. */
  private defs = new Map<number, WorkerToolDef[]>();
  private owner = new Map<string, number>();
  constructor(private hub: WorkerHub, private registry: Registry, private log: (m: string) => void = () => {}) {}

  attach() {
    this.hub.onConnect(id => { void this.refresh(id); });
    for (const w of this.hub.list().filter(w => w.online)) void this.refresh(w.id);
  }

  private async refresh(workerId: number) {
    let res;
    try { res = await this.hub.mcpList(workerId, BACKGROUND_CONTEXT); } catch (e) { this.log(`worker ${workerId} mcp list failed: ${(e as Error).message}`); return; }
    if (!res.ok) { this.log(`worker ${workerId} mcp list failed: ${res.error.message}`); return; }
    const valid = (Array.isArray(res.value) ? res.value : []).filter((d): d is WorkerToolDef => !!d && typeof d.name === "string" && typeof d.server === "string");
    this.defs.set(workerId, valid);
    this.install();
    this.log(`worker ${workerId} mcp: ${valid.length} tools`);
  }

  private tool(workerId: number, d: WorkerToolDef) {
    const hub = this.hub;
    return defineTool({
      name: `w${workerId}_${sanitize(d.server)}__${sanitize(d.name)}`,
      description: `[mcp:${d.server} on worker ${workerId}] ${d.description ?? d.name}`,
      parameters: Type.Unsafe<Record<string, unknown>>(d.inputSchema ?? { type: "object", properties: {} }),
      deferred: true as const,
      async execute(args, api, context) {
        if (workerOf(api.env) !== workerId) throw new Error(`This tool runs on execution machine ${workerId}. Nothing ran. Move this session to that machine to use it.`);
        const raw = await hub.mcpCall(workerId, d.server, d.name, args, context);
        if (!raw.ok) throw raw.error;
        const res = raw.value as { content?: unknown; isError?: boolean; structuredContent?: unknown } | null;
        const content: any[] = Array.isArray(res?.content) ? res!.content as any[] : [{ type: "text", text: JSON.stringify(res?.structuredContent ?? res) }];
        const output = content.map(c =>
          c?.type === "text" ? { type: "text" as const, text: String(c.text) }
          : c?.type === "image" ? { type: "image" as const, data: c.data, mimeType: c.mimeType }
          : { type: "text" as const, text: JSON.stringify(c) });
        return { output: output.length ? output : [{ type: "text" as const, text: "" }], isError: res?.isError === true };
      },
    });
  }

  private install() {
    const tools: ToolRegistration[] = [];
    this.owner.clear();
    for (const [workerId, defs] of this.defs) for (const d of defs) { const t = this.tool(workerId, d); tools.push(t); this.owner.set(t.name, workerId); }
    const owner = this.owner;
    // tool_search lists deferred tools of the whole registry. Each session sees only its own worker's tools.
    const extension: Extension = defineExtension({
      name: EXTENSION, tools,
      wraps: [{ tool: "tool_search", wrap: (tool: ToolRegistration): ToolRegistration => ({
        ...tool,
        execute: (args: any, api: any, context: any) => tool.execute(args, Object.create(api, {
          agent: { value: async (c: unknown) => {
            const agent = await api.agent(c), bound = workerOf(api.env);
            return { ...agent, deferred: agent.deferred.filter((t: { name: string }) => !owner.has(t.name) || owner.get(t.name) === bound) };
          } },
        }), context),
      }) }],
    });
    this.registry.install(extension);
  }
}
