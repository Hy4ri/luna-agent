import { SideCommands } from "./side-commands.js";
import { ConversationStore } from "./conversations.js";
import { createBoardExtension } from "./board.js";
// One entrypoint that wires every subsystem from a validated LunaConfig: harness (coding tools, memory, skills),
// delegate, cron (scheduler + tools + delivery), MCP servers, tool_search, and the self-improvement loop.
// Only extensions named in config.extensions and MCP servers in config.mcpServers are loaded.
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { SettingsStore } from "./settings.js";
import type { LunaConfig } from "./config.js";
import { createAskExtension } from "./ask.js";
import { createCronExtension, deliverRun } from "./cron-tools.js";
import { createDelegateExtension } from "./delegate.js";
import { createGoalExtension } from "./goal.js";
import { createRecallExtension, RecallIndex } from "./recall.js";
import { Todo } from "./todo.js";
import { createImproveExtension, cronRunSource, SkillImprover } from "./improve.js";
import { context, MemoryStore, openLuna } from "./luna.js";
import { McpManager } from "./mcp.js";
import { FileCredentialStore, ProviderManager } from "./providers.js";
import { CronStore, Scheduler, type ModelRef } from "./scheduler.js";

/** Name of the built-in job that runs the self-improvement loop on `improve.schedule`. */
export const IMPROVE_JOB = "luna-self-improve";
export const IMPROVE_PROMPT =
  "Self-improvement pass. 1) Call extract_lessons. 2) If it reports no recurring failure, answer 'nothing to improve' and stop. " +
  "3) For each recurring failure, load related skills with skill_view, then draft or update ONE focused skill with skill_propose " +
  "(full SKILL.md with name and description frontmatter, concrete steps that avoid the failure) and a must_contain benchmark " +
  "listing the key steps. 4) Answer with what was applied or blocked and why.";

export interface RuntimeOptions {
  /** Override the model catalog (tests). Default: built-in providers + <dataDir>/auth.json credentials. */
  models?: MutableModels;
  model?: ModelRef;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
}

/** Models backed by <dataDir>/auth.json. The faux provider is registered only when config selects it. */
function buildModels(cfg: LunaConfig): { models: MutableModels; model: ModelRef } {
  const models = createModels({ credentials: new FileCredentialStore(join(cfg.dataDir, "auth.json")) });
  if (cfg.provider === "faux") {
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 1000 }, (_, i) => fauxAssistantMessage([fauxText(`faux reply #${i + 1}`)])));
    models.setProvider(faux.provider);
    const m = faux.getModel();
    return { models, model: { provider: m.provider, modelId: m.id } };
  }
  return { models, model: { provider: cfg.provider, modelId: cfg.model! } };
}

export type Runtime = Awaited<ReturnType<typeof startRuntime>>;

export async function startRuntime(cfg: LunaConfig, o: RuntimeOptions = {}) {
  const settings = cfg.configPath ? new SettingsStore(cfg.configPath, cfg.dataDir) : undefined;
  if (settings) cfg = { ...settings.resolved(), configPath: settings.path };
  const log = o.log ?? ((m: string) => console.error(m));
  const on = (e: LunaConfig["extensions"][number]) => cfg.extensions.includes(e);
  mkdirSync(join(cfg.dataDir, "skills"), { recursive: true });

  const built = o.models ? { models: o.models, model: o.model! } : buildModels(cfg);
  // Register built-in and configured providers. File-backed runtimes share one settings store.
  const providers = new ProviderManager({ dataDir: cfg.dataDir, models: built.models, fallbackModel: built.model, fetch: o.fetch, settings });
  if (!o.models) {
    const refreshed = await built.models.refresh({ providers: ["claude-cli"], allowNetwork: true });
    for (const [id, error] of refreshed.errors) log(`models ${id}: ${error.message}`);
  }
  const registry = createRegistry();

  // MCP first, so their (deferred) tools are in the registry before the harness resumes old runs.
  const mcp = new McpManager(registry, cfg.mcpServers, join(cfg.dataDir, "mcp.json"), settings);
  await mcp.start();
  for (const f of mcp.failures) log(`mcp ${f.name}: failed to start: ${f.error}`);
  for (const c of mcp.connections) log(`mcp ${c.name}: ${c.toolNames.length} tools`);

  const cronDb = join(cfg.dataDir, "cron.db");
  const store = on("cron") || on("improve") ? new CronStore(cronDb) : undefined;
  let scheduler: Scheduler | undefined;

  const extensions: Extension[] = [];
  // Identity and always-on memory belong to the runtime, including cron and child conversations.
  extensions.push(defineExtension({ name: "identity", sections: [section("identity", () => {
    const files = ["SOUL.md", "USER.md", "MEMORY.md"];
    // Sent with every prompt, so each file is capped; the model can read the full file with its tools.
    const CAP = 4000;
    const text = files.filter(f => existsSync(join(cfg.dataDir, f)))
      .map((f) => {
        const body = readFileSync(join(cfg.dataDir, f), "utf8");
        const cut = body.length > CAP ? `${body.slice(0, CAP)}\n[truncated: ${body.length - CAP} more chars in ${join(cfg.dataDir, f)}]` : body;
        return `## ${f}\n${cut}`;
      }).join("\n\n");
    return text || undefined;
  })] }));
  if (on("delegate")) extensions.push(createDelegateExtension(() => settings?.resolved().subagents ?? cfg.subagents));
  if (on("cron")) extensions.push(createCronExtension(store!, () => scheduler?.rearm()));
  if (on("improve")) {
    const imp = new SkillImprover({ skillsDir: join(cfg.dataDir, "skills"), sources: [cronRunSource(cronDb)] });
    extensions.push(createImproveExtension(imp, { allowCommandBenchmarks: cfg.improve.allowCommandBenchmarks }));
  }
  if (on("tool-search")) extensions.push(createToolSearchExtension());
  if (on("todo")) extensions.push(Todo);
  // Installed always, selected only by project sessions (see openLuna). The store exists once the harness is open.
  let conversationsRef: ConversationStore | undefined;
  const board = createBoardExtension(() => conversationsRef);
  extensions.push(board);
  // ask_user_question waits for a human, so cron runs never get it. A push goes to cron.notifyUrl when one is set.
  const notifyUrl = cfg.cron.notifyUrl;
  const ask = on("ask-user") ? createAskExtension({
    onAsk: notifyUrl ? async (conv, p) => {
      const body = p.questions.map((q) => `• ${q.question}`).join("\n");
      await (o.fetch ?? fetch)(notifyUrl, { method: "POST", headers: { Title: `Luna is asking (session ${conv})`, "Content-Type": "text/plain; charset=utf-8" }, body: body.slice(0, 4000) });
    } : undefined,
  }) : undefined;
  if (ask) extensions.push(ask);
  const recall = on("recall") ? new RecallIndex(join(cfg.dataDir, "recall.db")) : undefined;
  if (recall) extensions.push(createRecallExtension(recall));
  let harnessRef: Awaited<ReturnType<typeof openLuna>> | undefined;
  if (on("goal")) extensions.push(createGoalExtension({ harness: () => harnessRef }));

  const memory = on("memory") ? new MemoryStore(join(cfg.dataDir, "memory.db")) : false;
  const compaction = () => settings?.resolved().compaction ?? cfg.compaction;
  const busyInput = () => settings?.resolved().busyInput ?? cfg.busyInput;
  const harness = await openLuna({
    registry,
    compaction: () => {
      const policy = compaction();
      return { enabled: true, autoEnabled: policy.enabled, triggerPercent: policy.triggerPercent, backgroundTokens: 0 };
    },
    dbPath: join(cfg.dataDir, "luna.db"),
    models: built.models,
    cwd: cfg.cwd,
    coding: on("coding"),
    memory,
    ...(on("skills") ? { skillDirs: cfg.allSkillDirs } : {}),
    extensions,
  });
  const conversations = new ConversationStore(harness, recall);
  conversationsRef = conversations;
  harnessRef = harness;
  harness.resume(); // continue any run a previous process left unfinished

  if (on("cron")) {
    scheduler = new Scheduler({
      harness, store: store!, defaultModel: () => providers.defaultModel(), log,
      ...(cfg.cron.runTimeoutMinutes ? { runTimeoutMs: cfg.cron.runTimeoutMinutes * 60_000 } : {}),
      onFinish: notifyUrl ? (job, run) => deliverRun(notifyUrl, job, run, o.fetch) : undefined,
      ...(ask ? { exclude: [ask] } : {}),
    });
    syncImproveJob(cfg, store!);
    await scheduler.start();
  }

  const sideCommands = new SideCommands({ harness, models: built.models, route: () => {
    const route = (settings?.resolved() ?? cfg).auxiliary.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  } });

  return {
    sideCommands,
    config: cfg,
    settings,
    compaction,
    busyInput,
    harness,
    conversations,
    /** Added to the agent of every session created in a project. */
    projectExtensions: [board],
    models: built.models,
    providers,
    memory: memory || undefined,
    skillDirs: on("skills") ? cfg.allSkillDirs : undefined,
    model: built.model,
    store,
    scheduler,
    mcp,
    async close() {
      await sideCommands.close();
      providers.close();
      await scheduler?.stop();
      await harness.close(context).catch(() => {});
      await mcp.close();
      store?.close();
      if (memory) memory.close();
      recall?.close();
    },
  };
}

/** Keep the built-in improve job in line with config: create, update, or disable it. */
function syncImproveJob(cfg: LunaConfig, store: CronStore) {
  const existing = store.listJobs().find((j) => j.name === IMPROVE_JOB);
  const want = cfg.improve.schedule;
  if (!want) { if (existing?.enabled) store.setEnabled(existing.id, false); return; }
  if (existing && (existing.expr !== want || existing.prompt !== IMPROVE_PROMPT)) store.removeJob(existing.id);
  else if (existing) { if (!existing.enabled) store.setEnabled(existing.id, true); return; }
  store.addJob(IMPROVE_JOB, want, IMPROVE_PROMPT);
}
