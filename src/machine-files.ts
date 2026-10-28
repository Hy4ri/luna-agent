// `machine_files`: read-only view of files on any registered machine ("main" or a worker), from any session.
import { homedir } from "node:os";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { expandHome } from "./file-mentions.js";
import type { WorkerHub } from "./workers.js";

const MAX_ENTRIES = 500;
const MAX_BYTES = 50 * 1024;
const MAX_FILE = 16 * 1024 * 1024;

const DESCRIPTION = "Read-only view of files on any Luna machine: \"main\" (the main host) or a worker name. " +
  "A directory lists entries (directories first, max 500). A file returns text with `read` truncation (2000 lines / 50KB); " +
  "continue with offset. Works from every session regardless of its own machine. `~` is the target machine's home.";

export function createMachineFilesExtension(o: { hub: () => WorkerHub | undefined; mainEnv?: () => ExecutionEnv }) {
  const fail = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
  const ok = (text: string) => ({ output: [{ type: "text" as const, text }] });
  const machineNames = () => ["main", ...(o.hub()?.store.list().map(w => w.name) ?? [])];
  return defineExtension({
    name: "machine-files",
    tools: [defineTool({
      name: "machine_files",
      description: DESCRIPTION,
      parameters: Type.Object({
        machine: Type.String({ minLength: 1, description: "\"main\" or a worker name (case-insensitive)." }),
        path: Type.String({ minLength: 1, description: "Absolute path or ~/... on that machine." }),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to show (1-based)." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines (default 2000)." })),
      }, { additionalProperties: false }),
      async execute(a, _api, context: Context) {
        const name = a.machine.trim().toLowerCase();
        let env: ExecutionEnv, home: string | undefined;
        if (name === "main") {
          const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
          env = o.mainEnv?.() ?? new NodeExecutionEnv({ cwd: homedir() });
          home = homedir();
        } else {
          const hub = o.hub();
          const worker = hub?.store.list().find(w => w.name.toLowerCase() === name);
          if (!hub || !worker) return fail(`Unknown machine "${a.machine}". Valid machines: ${machineNames().join(", ")}.`);
          if (!hub.view(worker.id)?.online) return fail(`worker ${worker.name} is offline.`);
          env = hub.env(worker.id, worker.capabilities?.home);
          home = worker.capabilities?.home;
        }
        const expanded = expandHome(a.path, home);
        if (expanded === undefined) return fail(`Home directory of machine "${a.machine}" is unknown.`);
        if (!expanded.startsWith("/")) return fail("path must be absolute or start with ~/.");
        const info = await env.fileInfo(expanded, context);
        if (!info.ok) return fail(`${a.machine}:${expanded}: ${info.error.message}`);
        if (info.value.kind === "directory") {
          const listed = await env.listDir(expanded, context);
          if (!listed.ok) return fail(`${a.machine}:${expanded}: ${listed.error.message}`);
          const entries = [...listed.value].sort((x, y) => Number(y.kind === "directory") - Number(x.kind === "directory") || x.name.localeCompare(y.name));
          const lines = entries.slice(0, MAX_ENTRIES).map(e => e.kind === "directory" ? `dir   ${e.name}/` : `file  ${e.name}  ${e.size} B`);
          if (entries.length > MAX_ENTRIES) lines.push(`[truncated: showing ${MAX_ENTRIES} of ${entries.length} entries]`);
          return ok(`${a.machine}:${expanded} (${entries.length} entries)\n${lines.join("\n") || "(empty)"}`);
        }
        if (info.value.kind !== "file") return fail(`${a.machine}:${expanded} is a ${info.value.kind}, not a file or directory.`);
        if (info.value.size > MAX_FILE) return fail(`${a.machine}:${expanded} is ${info.value.size} bytes; too large to read (limit ${MAX_FILE}).`);
        const bytes = await env.readBinaryFile(expanded, context);
        if (!bytes.ok) return fail(`${a.machine}:${expanded}: ${bytes.error.message}`);
        if (bytes.value.subarray(0, 8000).includes(0)) return fail(`${a.machine}:${expanded} is a binary file; not shown.`);
        const all = Buffer.from(bytes.value).toString("utf8").split("\n");
        if (all.length > 1 && all[all.length - 1] === "") all.pop();
        const start = (a.offset ?? 1) - 1;
        if (start >= all.length && all.length > 0) return fail(`offset ${a.offset} is past the end of the file (${all.length} lines).`);
        const maxLines = Math.min(a.limit ?? 2000, 2000);
        const out: string[] = [];
        let size = 0, i = start;
        for (; i < all.length && out.length < maxLines; i++) {
          size += Buffer.byteLength(all[i]!) + 1;
          if (size > MAX_BYTES && out.length > 0) break;
          out.push(all[i]!);
        }
        const note = i < all.length ? `\n\n[showing lines ${start + 1}-${i} of ${all.length}; continue with offset=${i + 1}]` : "";
        return ok(out.join("\n") + note);
      },
    })],
  });
}
