import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Extension, type Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createSkillsExtension } from "./skills.js";
import { createMemoryExtension, MemoryStore } from "./memory.js";

export const context = BACKGROUND_CONTEXT;

export interface LunaOptions {
  /** SQLite file; defaults to ./luna.db */
  dbPath?: string;
  /** Model catalog with providers already set. */
  models: Models;
  cwd?: string;
  /** Durable memory SQLite file; defaults to ./memory.db. Pass a MemoryStore to share one; `false` disables memory. */
  memory?: MemoryStore | string | false;
  /** Directories scanned for SKILL.md skills; omit to disable the skills extension. */
  skillDirs?: string[];
  /** Extra extensions (e.g. tools a skill mounts on demand). */
  extensions?: Extension[];
  /** Install bash/read/write/edit. Default true. */
  coding?: boolean;
  /** Registry to install into (e.g. one that already holds MCP extensions). Default: a new one. */
  registry?: Registry;
}

/** Open the durable Luna harness: SQLite storage + CodingTools (bash/read/write/edit) + memory + optional skills. */
export async function openLuna(opts: LunaOptions) {
  const registry = opts.registry ?? createRegistry();
  if (opts.coding !== false) registry.install(CodingTools);
  for (const e of opts.extensions ?? []) registry.install(e);
  if (opts.skillDirs?.length) registry.install(createSkillsExtension({ dirs: opts.skillDirs }));
  if (opts.memory !== false) {
    const memory = opts.memory instanceof MemoryStore ? opts.memory : new MemoryStore(opts.memory ?? "memory.db");
    registry.install(createMemoryExtension(memory));
  }
  const storage = await openNodeSqliteStorage(opts.dbPath ?? "luna.db");
  const harness = await Harness.open(
    storage,
    {
      models: opts.models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? opts.cwd ?? process.cwd() }),
    },
    context,
  );
  return harness;
}

export { createModels, MemoryStore };
