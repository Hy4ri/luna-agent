import { BusyExecutions } from "./busy-tools.js";
import { SessionCreated } from "./session-activity.js";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, ROOT_CONVERSATION_ID, type CompactionPolicy, type Extension, type Registry } from "@earendil-works/pi-durable";
import { openConversationStorage, registerConversationStorage } from "./conversation-storage.js";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createSkillsExtension } from "./skills.js";
import { createMemoryExtension, MemoryStore } from "./memory.js";
import { SessionStatusExtension } from "./session-status.js";

export const context = BACKGROUND_CONTEXT;
// New incarnations of a deleted root must not inherit old process handles or deliveries.
export const ProcessOwner = defineDoc({ kind: "luna.process-owner", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ token: "legacy" }) });

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
  /** Explicit background execution is opt-in; correction-detached bash keeps its existing behavior. */
  processes?: { enabled: boolean; retentionHours: number; maxOutputBytes: number };
  processDirectory?: string;
  processNotify?: (id: import("@earendil-works/pi-durable").ConversationId, message: string) => Promise<void>;
  log?: (message: string) => void;
}

/** Open the durable Luna harness: SQLite storage + CodingTools (bash/read/write/edit) + memory + optional skills. */
export async function openLuna(opts: LunaOptions) {
  const registry = opts.registry ?? createRegistry();
  let harnessRef: Harness | undefined;
  const busyTools = new BusyExecutions(async (id, message, requestId, owner) => {
    const conv = await harnessRef?.conversation(id, context);
    if (!conv) return; // Deleted owners have no destination; never create a replacement conversation.
    if (((await harnessRef!.snapshot(ProcessOwner, id, context))?.token ?? "legacy") !== owner) return;
    await conv.submit({ type: "input", content: message, requestId, whenBusy: "followUp" }, context);
    try { await opts.processNotify?.(id, message); }
    catch (error) { opts.log?.(`process notification: ${error instanceof Error ? error.message : String(error)}`); }
  }, {
    ...opts.processes,
    directory: opts.processDirectory ?? ((opts.dbPath ?? "luna.db") === ":memory:" ? undefined : join(dirname(opts.dbPath ?? "luna.db"), "processes")),
    log: opts.log,
  });
  if (opts.coding !== false) { registry.install(CodingTools); registry.install(busyTools.extension()); }
  registry.install(SessionStatusExtension);
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
        (await tx.doc(ProcessOwner, conversation.id)).token = randomUUID();
        (await tx.doc(SessionCreated, conversation.id)).at = Date.now();
        // The reserved root ID can be reused after deletion. Give each incarnation a unique context boundary,
        // so pi-durable cannot extend a retained model-context range from its deleted incarnation.
        if (conversation.id === ROOT_CONVERSATION_ID) await tx.appendEntry(conversation.id, { kind: "luna.context-start", head: "self" });
      },
      env: async ({ cwd, conversationId, read }, ctx) => busyTools.env(conversationId, cwd ?? opts.cwd ?? process.cwd(), (await read.snapshot(ProcessOwner, conversationId, ctx))?.token ?? "legacy"),
    },
    context,
  );
  harnessRef = harness;
  registerConversationStorage(harness, store);
  await busyTools.start();
  const close = harness.close.bind(harness);
  return Object.assign(harness, {
    busyTools,
    async close(ctx: Parameters<Harness["close"]>[0]) { try { await busyTools.close(); } finally { await close(ctx); } },
  });
}

export { createModels, MemoryStore };
