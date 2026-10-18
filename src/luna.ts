import { BusyExecutions } from "./busy-tools.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type CompactionPolicy, type Extension, type Registry } from "@earendil-works/pi-durable";
import { openConversationStorage, registerConversationStorage } from "./conversation-storage.js";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createSkillsExtension } from "./skills.js";
import { createMemoryExtension, MemoryStore } from "./memory.js";

export const context = BACKGROUND_CONTEXT;

export interface LunaOptions {
  /** Live harness compaction policy; read again at each execution boundary. */
  compaction?: () => Partial<CompactionPolicy>;
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
  let harnessRef: Harness | undefined;
  const busyTools = new BusyExecutions(async (id, message, requestId) => {
    const conv = await harnessRef?.conversation(id, context);
    await conv?.submit({ type: "input", content: message, requestId, whenBusy: "followUp" }, context);
  });
  if (opts.coding !== false) { registry.install(CodingTools); registry.install(busyTools.extension()); }
  for (const e of opts.extensions ?? []) registry.install(e);
  if (opts.skillDirs?.length) registry.install(createSkillsExtension({ dirs: opts.skillDirs }));
  if (opts.memory !== false) {
    const memory = opts.memory instanceof MemoryStore ? opts.memory : new MemoryStore(opts.memory ?? "memory.db");
    registry.install(createMemoryExtension(memory));
  }
  const { storage, store } = await openConversationStorage(opts.dbPath ?? "luna.db");
  const harness = await Harness.open(
    storage,
    {
      models: opts.models,
      registry,
      // The board belongs to project sessions only: they add it at creation. Everything else (cron, subagents, plain sessions) skips it.
      settings: {
        get extensions() { return registry.snapshot().installed().filter(e => e.name !== "board"); },
        get compaction() { return opts.compaction?.(); },
        steeringMode: "all",
        followUpMode: "one-at-a-time",
      },
      conversationCreated: async (tx, conversation) => {
        // The reserved root ID can be reused after deletion. Give each incarnation a unique context boundary,
        // so pi-durable cannot extend a retained model-context range from its deleted incarnation.
        if (conversation.id === ROOT_CONVERSATION_ID) await tx.appendEntry(conversation.id, { kind: "luna.context-start", head: "self" });
      },
      env: ({ cwd, conversationId }) => busyTools.env(conversationId, cwd ?? opts.cwd ?? process.cwd()),
    },
    context,
  );
  harnessRef = harness;
  registerConversationStorage(harness, store);
  const close = harness.close.bind(harness);
  return Object.assign(harness, {
    busyTools,
    async close(ctx: Parameters<Harness["close"]>[0]) { try { await close(ctx); } finally { await busyTools.close(); } },
  });
}

export { createModels, MemoryStore };
