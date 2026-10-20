import { createImageGenExtension, ImageGenManager, type ImageGenProvider } from "./image-gen.js";
import { createOpenAICodexImageProvider } from "./plugins/image_gen/openai-codex.js";
import { createCodexImageAuth } from "./codex-image-auth.js";
import { createVisionExtension } from "./vision.js";
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
import { createLearnExtension, LEARN_JOB, LEARN_PROMPT, LearnStore, scanIdle } from "./learn.js";
import { context, MemoryStore, openLuna } from "./luna.js";
import { McpManager } from "./mcp.js";
import { createBrowserToolsExtension } from "./browser-tools.js";
import { createCamofoxBrowserProvider } from "./camofox-browser-provider.js";
import { createWebToolsExtension } from "./web-tools.js";
import { createDdgsWebProvider } from "./ddgs-web-provider.js";
import { FileCredentialStore, ProviderManager } from "./providers.js";
import { CronStore, Scheduler, type ModelRef } from "./scheduler.js";
import { SessionTitler } from "./titles.js";
import { LimitContinuer } from "./limit-continue.js";

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
  /** Override image adapters for contract tests. Never changes provider selection. */
  imageGenProviders?: ReadonlyMap<string, ImageGenProvider>;
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
    const refreshed = await built.models.refresh({ providers: ["claude-cli", ...providers.customIds()], allowNetwork: true });
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

  let harnessRef: Awaited<ReturnType<typeof openLuna>> | undefined;
  const extensions: Extension[] = [];
  const imageGenConfig = () => (settings?.resolved() ?? cfg).image_gen;
  const imageGen = new ImageGenManager({ config: imageGenConfig, providers: o.imageGenProviders ?? new Map([
    ["openai-codex", createOpenAICodexImageProvider({ config: () => imageGenConfig()["openai-codex"],
      auth: createCodexImageAuth({ config: () => imageGenConfig()["openai-codex"] }),
      outputDir: join(cfg.dataDir, "generated-images"), fetch: o.fetch })],
  ]) });
  extensions.push(createImageGenExtension(imageGen, cfg.cwd));
  extensions.push(createVisionExtension({ config: () => settings?.resolved() ?? cfg, models: built.models, defaultModel: () => providers.defaultModel(),
    history: async (id, ctx) => (await (await harnessRef!.conversation(id, ctx))!.context(ctx)) }));
  extensions.push(createWebToolsExtension(cfg.web, new Map([
    ["ddgs", createDdgsWebProvider(cfg.web.providers.ddgs, mcp)],
  ])));
  extensions.push(createBrowserToolsExtension(cfg.browser, new Map([
    ["camofox", createCamofoxBrowserProvider(cfg.browser.providers.camofox, mcp)],
  ])));
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
  const improver = on("improve") || on("learn")
    ? new SkillImprover({ skillsDir: join(cfg.dataDir, "skills"), sources: [cronRunSource(cronDb)], readDirs: cfg.allSkillDirs })
    : undefined;
  if (on("improve")) extensions.push(createImproveExtension(improver!, { allowCommandBenchmarks: cfg.improve.allowCommandBenchmarks }));
  const learn = on("learn") ? new LearnStore(join(cfg.dataDir, "learn.db")) : undefined;
  if (learn) extensions.push(createLearnExtension(learn, improver!));
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
    processes: cfg.processes,
    processDirectory: join(cfg.dataDir, "processes"),
    log,
    processNotify: notifyUrl ? async (id, message) => {
      const response = await (o.fetch ?? fetch)(notifyUrl, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { Title: `Luna process finished (session ${id})`, "Content-Type": "text/plain; charset=utf-8" },
        // Shell output can contain secrets. External notifications carry status only.
        body: message.split("\n", 1)[0]!.slice(0, 500),
      });
      if (!response.ok) throw new Error(`notification HTTP ${response.status}`);
    } : undefined,
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
    syncJob(store!, LEARN_JOB, learn ? cfg.learn.schedule : undefined, LEARN_PROMPT);
    await scheduler.start();
  }

  // Session learning runs after a conversation goes idle, never inside a live turn.
  let learnTimer: ReturnType<typeof setInterval> | undefined;
  let learnRunning: Promise<unknown> | undefined;
  const learnScan = () => {
    if (!learn || learnRunning) return learnRunning;
    const isCronRun = store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1");
    learnRunning = scanIdle({
      store: learn, idleMs: cfg.learn.idleMinutes * 60_000, log,
      commit: (fn) => harness.commit(fn, context),
      skip: (id) => !!isCronRun?.get(String(id)),
    }).catch((e) => log(`learn: scan failed: ${(e as Error).message}`)).finally(() => { learnRunning = undefined; });
    return learnRunning;
  };
  if (learn) {
    learnTimer = setInterval(learnScan, Math.max(60_000, Math.min(5 * 60_000, cfg.learn.idleMinutes * 60_000)));
    learnTimer.unref();
    void learnScan();
  }

  const sideCommands = new SideCommands({ harness, models: built.models, route: () => {
    const route = (settings?.resolved() ?? cfg).auxiliary.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  } });

  // Session titles use their own route, else the side-question route; never the session model.
  const titler = new SessionTitler({ harness, conversations, models: built.models, route: () => {
    const aux = (settings?.resolved() ?? cfg).auxiliary, route = aux.session_title ?? aux.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  } });
  titler.start();
  recall?.titles((id) => conversations.get(id).title);

  // Continue after a usage limit resets. Cron runs have their own timeout and run log, so they never wait.
  const isCronConversation = store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1");
  const limitContinuer = new LimitContinuer({ harness, log, policy: () => (settings?.resolved() ?? cfg).autoContinue,
    skip: (id) => !!isCronConversation?.get(String(id)) });
  await limitContinuer.start();

  return {
    sideCommands,
    titler,
    limitContinuer,
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
    learn,
    improver,
    /** Run one idle scan now (tests and manual triggers). */
    learnScan,
    store,
    scheduler,
    mcp,
    async close() {
      if (learnTimer) clearInterval(learnTimer);
      await learnRunning;
      await limitContinuer.close();
      await titler.close();
      await sideCommands.close();
      providers.close();
      await scheduler?.stop();
      await harness.close(context).catch(() => {});
      await mcp.close();
      store?.close();
      if (memory) memory.close();
      recall?.close();
      learn?.close();
    },
  };
}

/** Keep the built-in improve job in line with config: create, update, or disable it. */
function syncImproveJob(cfg: LunaConfig, store: CronStore) { syncJob(store, IMPROVE_JOB, cfg.improve.schedule, IMPROVE_PROMPT); }

/** Keep one built-in job in line with config: create, update, or disable it (`want` undefined = disabled). */
function syncJob(store: CronStore, name: string, want: string | undefined, prompt: string) {
  const existing = store.listJobs().find((j) => j.name === name);
  if (!want) { if (existing?.enabled) store.setEnabled(existing.id, false); return; }
  if (existing && (existing.expr !== want || existing.prompt !== prompt)) store.removeJob(existing.id);
  else if (existing) { if (!existing.enabled) store.setEnabled(existing.id, true); return; }
  store.addJob(name, want, prompt);
}
