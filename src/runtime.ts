import { createImageGenExtension, ImageGenManager, type ImageGenProvider } from "./image-gen.js";
import { ensureGeneratedDirectories, generatedDirectories, generatedFilesInstructions, generatedRoot, workerGeneratedRoot } from "./generated-files.js";
import { isWorkerEnv, WORKER_ENV_PREFIX } from "./worker-protocol.js";
import { UploadStore, workerUploadRoot } from "./uploads.js";
import { withUploadModels } from "./upload-models.js";
import { conversationStorage } from "./conversation-storage.js";
import { createOpenAICodexImageProvider } from "./plugins/image_gen/openai-codex.js";
import { createChatCompletionsImageProvider } from "./plugins/image_gen/chat-completions.js";
import { createCodexImageAuth } from "./codex-image-auth.js";
import { createVideoExtension } from "./video.js";
import { createVisionExtension } from "./vision.js";
import { SideCommands } from "./side-commands.js";
import { ConversationStore } from "./conversations.js";
import { createBoardExtension } from "./board.js";
import { createSessionTalkExtension } from "./session-talk.js";
import { createFileMentionExtension } from "./file-mentions.js";
import { createMachineFilesExtension } from "./machine-files.js";
import { createMachineExecExtension } from "./machine-exec.js";
// One entrypoint that wires every subsystem from a validated LunaConfig: harness (coding tools, memory, skills),
// delegate, cron (scheduler + tools + delivery), MCP servers, tool_search, and the self-improvement loop.
// Only extensions named in config.extensions and MCP servers in config.mcpServers are loaded.
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createLunaCodemodeExtension } from "./codemode.js";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { SettingsStore } from "./settings.js";
import { BUILTIN_EXTENSIONS, BUILTIN_REGISTRY_NAMES, type LunaConfig } from "./config.js";
import { createToggleExtension } from "./toggles.js";
import { createAskExtension } from "./ask.js";
import { createCronExtension, deliverRun } from "./cron-tools.js";
import { createDelegateExtension } from "./delegate.js";
import { DelegateResults } from "./delegate-results.js";
import { createGoalExtension } from "./goal.js";
import { createRecallExtension, RecallIndex } from "./recall.js";
import { Todo } from "./todo.js";
import { createImproveExtension, cronRunSource, SkillImprover } from "./improve.js";
import { createSkillManageExtension, SkillManager } from "./skill-manage.js";
import { createLearnExtension, LEARN_JOB, LearnStore, scanIdle } from "./learn.js";
import { LearnFiles } from "./learn-files.js";
import { context, MemoryStore, openLuna } from "./luna.js";
import { McpManager } from "./mcp.js";
import { createBrowserToolsExtension } from "./browser-tools.js";
import { createCamofoxBrowserProvider } from "./camofox-browser-provider.js";
import { createMoliBrowserProvider } from "./moli-browser-provider.js";
import { createChromiumBrowserProvider } from "./chromium-browser-provider.js";
import { createWebToolsExtension } from "./web-tools.js";
import { createDdgsWebProvider } from "./ddgs-web-provider.js";
import { createFreeserpWebProvider, createSearxngWebProvider } from "./http-search-providers.js";
import { FileCredentialStore, ProviderManager } from "./providers.js";
import { CronStore, Scheduler, type ModelRef } from "./scheduler.js";
import { SessionTitler } from "./titles.js";
import { LimitContinuer } from "./limit-continue.js";
import { SubagentNotifier } from "./subagent-notify.js";
import { CrewNotifier, createSessionCrewExtension } from "./session-crew.js";
import { createWorkersExtension, ExecTarget, WorkerHub, WorkerStore } from "./workers.js";
import { WorkerMcpProxy } from "./worker-mcp-proxy.js";

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
  const outputRoot = generatedRoot(cfg.dataDir);
  ensureGeneratedDirectories(outputRoot);

  const uploadRoot = join(cfg.dataDir, "uploads");
  const uploads = new UploadStore(uploadRoot);
  const built = o.models ? { models: o.models, model: o.model! } : buildModels(cfg);
  built.models = withUploadModels(built.models, uploads);
  // Register built-in and configured providers. File-backed runtimes share one settings store.
  const providers = new ProviderManager({ dataDir: cfg.dataDir, models: built.models, fallbackModel: built.model, fetch: o.fetch, settings });
  if (!o.models) {
    const refreshed = await providers.refreshCatalog(false);
    for (const [id, error] of Object.entries(refreshed.errors)) log(`models ${id}: ${error}`);
  }
  providers.startAutoRefresh();
  const registry = createRegistry();

  // MCP first, so their (deferred) tools are in the registry before the harness resumes old runs.
  const mcp = new McpManager(registry, cfg.mcpServers, join(cfg.dataDir, "mcp.json"), settings);
  await mcp.start();
  for (const f of mcp.failures) log(`mcp ${f.name}: failed to start: ${f.error}`);
  for (const c of mcp.connections) log(`mcp ${c.name}: ${c.toolNames.length} tools`);

  const cronDb = join(cfg.dataDir, "cron.db");
  const store = on("cron") || on("improve") || on("learn") ? new CronStore(cronDb) : undefined;
  let scheduler: Scheduler | undefined;

  let harnessRef: Awaited<ReturnType<typeof openLuna>> | undefined;
  const extensions: Extension[] = [];
  // Workers hub early so browser tools can proxy to the session's worker.
  const workers = new WorkerHub(new WorkerStore(join(cfg.dataDir, "workers.db")), log);
  extensions.push(createWorkersExtension(() => workers));
  extensions.push(createMachineFilesExtension({ hub: () => workers }));
  extensions.push(createMachineExecExtension({ hub: () => workers }));
  const workerOutput = (id: number) => {
    const caps = workers.store.get(id)?.capabilities;
    if (!caps?.generatedFiles) return undefined;
    try { return { root: workerGeneratedRoot(caps.home, caps.platform), platform: caps.platform }; }
    catch { return undefined; }
  };
  extensions.push(defineExtension({ name: "generated-files", sections: [section("generated-files", async ({ conversationId, read }, ctx) => {
    const target = await read.snapshot(ExecTarget, conversationId, ctx);
    if (!target?.worker) return generatedFilesInstructions(outputRoot);
    const output = workerOutput(target.worker);
    return output ? generatedFilesInstructions(output.root, output.platform)
      : "Generated storage is unavailable on this execution worker. Update the worker to the same Luna version and ensure it reports its home directory. Do not save unrelated generated files in the project or on the main host as a fallback.";
  })] }));
  // Per-worker MCP: worker-only tools appear as w<id>_<server>__* and proxy via WorkerHub.mcpCall. Main MCP stays available.
  new WorkerMcpProxy(workers, registry, log).attach();
  const imageGenConfig = () => (settings?.resolved() ?? cfg).image_gen;
  const imageGen = new ImageGenManager({ config: imageGenConfig, providers: o.imageGenProviders ?? new Map([
    ["openai-codex", createOpenAICodexImageProvider({ config: () => imageGenConfig()["openai-codex"],
      auth: createCodexImageAuth({ config: () => imageGenConfig()["openai-codex"] }),
      outputDir: generatedDirectories(outputRoot).images, fetch: o.fetch })],
    ["chat-completions", createChatCompletionsImageProvider({ config: () => imageGenConfig()["chat-completions"],
      models: built.models, outputDir: generatedDirectories(outputRoot).images, fetch: o.fetch })],
  ]) });
  extensions.push(createToggleExtension(() => live().disabledTools));
  extensions.push(createImageGenExtension(imageGen, cfg.cwd, env => {
    if (!isWorkerEnv(env)) return generatedDirectories(outputRoot).images;
    const output = workerOutput(Number(env!.id.slice(WORKER_ENV_PREFIX.length)));
    return output ? generatedDirectories(output.root, output.platform).images : undefined;
  }, env => {
    if (!isWorkerEnv(env)) return uploadRoot;
    const caps = workers.store.get(Number(env!.id.slice(WORKER_ENV_PREFIX.length)))?.capabilities;
    if (!caps?.uploadFiles) return undefined;
    try { return workerUploadRoot(caps.home, caps.platform); } catch { return undefined; }
  }));
  extensions.push(createVisionExtension({ config: () => settings?.resolved() ?? cfg, models: built.models, defaultModel: () => providers.defaultModel(),
    history: async (id, ctx) => {
      const view = await (await harnessRef!.conversation(id, ctx))!.context(ctx);
      return { ...view, messages: uploads.hydrate(view.messages) };
    } }));
  extensions.push(createVideoExtension({ config: () => settings?.resolved() ?? cfg, models: built.models,
    defaultModel: () => providers.defaultModel(), fetch: o.fetch }));
  // Read per call so Settings changes apply to the next tool call.
  const live = () => settings?.resolved() ?? cfg;
  extensions.push(createWebToolsExtension(() => live().web, new Map([
    ["ddgs", createDdgsWebProvider(() => live().web.providers.ddgs, mcp)],
    ["searxng", createSearxngWebProvider(() => live().web.providers.searxng, o.fetch)],
    ["freeserp", createFreeserpWebProvider(() => live().web.providers.freeserp, o.fetch)],
  ])));
  extensions.push(createBrowserToolsExtension(() => live().browser, new Map([
    ["camofox", createCamofoxBrowserProvider(() => live().browser.providers.camofox, mcp)],
    ["moli", createMoliBrowserProvider(() => live().browser.providers.moli)],
    ["chromium", createChromiumBrowserProvider(() => live().browser.providers.chromium)],
  ]), { hub: () => workers }));
  // Identity belongs to top-level and cron sessions. Delegated children remove this extension.
  extensions.push(defineExtension({ name: "identity", sections: [section("identity", () => {
    const projection = learn?.projectionState(memory || undefined);
    const files = ["SOUL.md", "USER.md", ...(projection?.managed && projection.stale ? [] : ["MEMORY.md"])];
    // Sent with every prompt, so each file is capped; the model can read the full file with its tools.
    const CAP = 4000;
    const text = files.filter(f => existsSync(join(cfg.dataDir, f)))
      .map((f) => {
        const body = readFileSync(join(cfg.dataDir, f), "utf8");
        const cut = body.length > CAP ? `${body.slice(0, CAP)}\n[truncated: ${body.length - CAP} more chars in ${join(cfg.dataDir, f)}]` : body;
        return `## ${f}\n${cut}`;
      }).join("\n\n");
    return (text + (projection?.managed && projection.stale ? "\nMEMORY.md projection is stale or edited. Use recall for current database facts; request review before refreshing the file." : "")) || undefined;
  })] }));
  if (on("delegate")) extensions.push(DelegateResults, createDelegateExtension(() => settings?.resolved().subagents ?? cfg.subagents));
  // Crew sessions are full sessions, created with the same rules as the web UI's new-session request.
  let projectExtensions: Extension[] = [];
  const newSessionAgent = () => {
    const c = live();
    return { model: providers.defaultModel(), ...(c.thinkingLevel ? { thinkingLevel: c.thinkingLevel } : {}), ...(c.maxTurns ? { maxTurns: c.maxTurns } : {}), ...(c.instructions ? { instructions: c.instructions } : {}) };
  };
  if (on("delegate")) extensions.push(createSessionCrewExtension({
    harness: () => harnessRef,
    session: () => conversationsRef && { base: newSessionAgent, models: built.models, projects: conversationsRef.projects, workers: workers.store, projectExtensions },
    projects: () => conversationsRef?.projects,
    workers: () => workers.list(),
    title: id => conversationsRef?.get(id).title ?? null,
    setTitle: (id, title) => conversationsRef!.update(id, { title }),
  }));
  if (on("cron")) extensions.push(createCronExtension(store!, () => scheduler?.rearm(), () => scheduler));
  const improver = on("improve") || on("learn") || on("skills")
    ? new SkillImprover({ skillsDir: join(cfg.dataDir, "skills"), sources: [cronRunSource(cronDb)], readDirs: cfg.allSkillDirs })
    : undefined;
  if (on("improve")) extensions.push(createImproveExtension(improver!, { allowCommandBenchmarks: () => live().improve.allowCommandBenchmarks }));
  if (on("skills")) extensions.push(createSkillManageExtension(new SkillManager(improver!, cfg.allSkillDirs)));
  const memory = on("memory") ? new MemoryStore(join(cfg.dataDir, "memory.db")) : false;
  const learn = on("learn") ? new LearnStore(join(cfg.dataDir, "learn.db"), {
    files: new LearnFiles(cfg.dataDir, () => live().learn.files),
    skip: id => !!store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1").get(String(id)),
  }) : undefined;
  if (learn) extensions.push(createLearnExtension(learn, improver!, memory || undefined));
  if (on("tool-search")) extensions.push(createToolSearchExtension());
  if (on("todo")) extensions.push(Todo);
  // All chat sessions get a board. Unlinked sessions use General. The store exists once the harness is open.
  let conversationsRef: ConversationStore | undefined;
  const board = createBoardExtension(() => conversationsRef);
  extensions.push(board);
  projectExtensions = [board];
  // ask_user_question waits for a human, so cron runs never get it. A push goes to cron.notifyUrl when one is set.
  const notifyUrl = () => live().cron.notifyUrl;
  const ask = on("ask-user") ? createAskExtension({
    onAsk: async (conv, p) => {
      const url = notifyUrl();
      if (!url) return;
      const body = p.questions.map((q) => `• ${q.question}`).join("\n");
      await (o.fetch ?? fetch)(url, { method: "POST", headers: { Title: `Luna is asking (session ${conv})`, "Content-Type": "text/plain; charset=utf-8" }, body: body.slice(0, 4000) });
    },
  }) : undefined;
  if (ask) extensions.push(ask);
  // Live policy: Settings changes apply to the next send without a restart.
  const sessionTalk = () => (settings?.resolved() ?? cfg).sessionTalk;
  extensions.push(createSessionTalkExtension({
    policy: sessionTalk,
    harness: () => harnessRef,
    titles: () => conversationsRef && {
      title: (id) => conversationsRef!.get(id).title,
      project: (id) => { const p = conversationsRef!.projects.projectOf(id); return p === undefined ? undefined : conversationsRef!.projects.get(p)?.name; },
    },
  }));
  const recall = on("recall") ? new RecallIndex(join(cfg.dataDir, "recall.db")) : undefined;
  if (recall) extensions.push(createRecallExtension(recall));
  if (on("goal")) extensions.push(createGoalExtension({ harness: () => harnessRef }));
  extensions.push(createFileMentionExtension({ home: (w) => w === null ? homedir() : workers.store.get(w)?.capabilities?.home }));

  const codemodeSandbox = on("codemode") ? new CodemodeSandbox({
    memoryLimitBytes: cfg.codemode.memoryLimitBytes,
  }) : undefined;
  if (codemodeSandbox) extensions.push(createLunaCodemodeExtension({
    sandbox: codemodeSandbox,
    inlineBudget: cfg.codemode.inlineBudget,
    models: false,
  }, cfg.codemode.timeoutMs));

  const busyInput = () => settings?.resolved().busyInput ?? cfg.busyInput;
  const harness = await openLuna({
    registry,
    afterFailedRun: () => (settings?.resolved() ?? cfg).afterFailedRun,
    alert: async (title, body) => {
      const url = notifyUrl();
      if (!url) return;
      const r = await (o.fetch ?? fetch)(url, { method: "POST", signal: AbortSignal.timeout(5000), headers: { Title: title, "Content-Type": "text/plain; charset=utf-8" }, body });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
    dbPath: join(cfg.dataDir, "luna.db"),
    models: built.models,
    cwd: cfg.cwd,
    coding: on("coding"),
    processes: cfg.processes,
    processDirectory: join(cfg.dataDir, "processes"),
    remoteEnv: (worker, cwd) => workers.env(worker, cwd),
    log,
    processNotify: async (id, message) => {
      const url = notifyUrl();
      if (!url) return;
      const response = await (o.fetch ?? fetch)(url, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { Title: `Luna process finished (session ${id})`, "Content-Type": "text/plain; charset=utf-8" },
        // Shell output can contain secrets. External notifications carry status only.
        body: message.split("\n", 1)[0]!.slice(0, 500),
      });
      if (!response.ok) throw new Error(`notification HTTP ${response.status}`);
    },
    memory,
    ...(on("skills") ? { skillDirs: cfg.allSkillDirs, disabledSkills: id => {
      const global = live().disabledSkills;
      const pid = id === undefined ? undefined : conversationsRef?.projects.projectOf(id);
      return pid ? conversationsRef!.projectSkills.disabled(pid, global) : global;
    } } : {}),
    // A built-in missing from the live list is hidden from sessions. Its store and scheduler keep running.
    hiddenExtensions: () => new Set(BUILTIN_EXTENSIONS.filter(e => !live().extensions.includes(e)).flatMap(e => BUILTIN_REGISTRY_NAMES[e])),
    extensions,
  });
  uploads.bind(conversationStorage(harness).db);
  const conversations = new ConversationStore(harness, recall, uploads);
  conversationsRef = conversations;
  harnessRef = harness;
  // Subscribe before recovered work can settle; reconcile undelivered results without replaying work.
  const subagentNotifier = new SubagentNotifier({ harness, log, skip: id => conversations.get(id).archived });
  if (on("delegate")) await subagentNotifier.start();
  const crewNotifier = new CrewNotifier({ harness, log, title: id => conversations.get(id).title, skip: id => conversations.get(id).archived });
  if (on("delegate")) await crewNotifier.start();
  // Continue after a usage limit resets. Cron runs have their own timeout and run log, so they never wait.
  const isCronConversation = store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1");
  const limitContinuer = new LimitContinuer({ harness, log, policy: () => (settings?.resolved() ?? cfg).autoContinue,
    defaultModel: () => providers.defaultModel(),
    skip: (id) => conversations.get(id).archived || !!isCronConversation?.get(String(id)) });
  await limitContinuer.start();

  harness.resume(); // continue any run a previous process left unfinished

  if (on("cron")) {
    scheduler = new Scheduler({
      harness, store: store!, defaultModel: () => providers.defaultModel(), log,
      runTimeoutMs: () => { const m = live().cron.runTimeoutMinutes; return m ? m * 60_000 : 30 * 60_000; },
      onFinish: (job, run) => { const url = notifyUrl(); return url ? deliverRun(url, job, run, o.fetch) : undefined; },
      exclude: [board, ...(ask ? [ask] : [])],
    });
    syncImproveJob(cfg, store!);
    disableLegacyLearnJob(store!);
    await scheduler.start();
  }

  // Session learning runs after a conversation goes idle, never inside a live turn.
  let learnTimer: ReturnType<typeof setInterval> | undefined;
  let learnRunning: Promise<unknown> | undefined;
  const learnScan = () => {
    if (!learn || !live().learn.captureEnabled || !live().extensions.includes("learn") || learnRunning) return learnRunning;
    const isCronRun = store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1");
    learnRunning = scanIdle({
      store: learn, idleMs: live().learn.idleMinutes * 60_000, log,
      commit: (fn) => harness.commit(fn, context),
      skip: (id) => !!isCronRun?.get(String(id)),
    }).catch((e) => log(`learn: scan failed: ${(e as Error).message}`)).finally(() => { learnRunning = undefined; });
    return learnRunning;
  };
  if (learn) {
    learnTimer = setInterval(learnScan, 60_000);
    learnTimer.unref();
    void learnScan();
  }

  // Settings saved while running: bring live state in line without a restart.
  settings?.onApply(async (_old, next) => {
    const warnings: string[] = [];
    providers.reconcile(next.providers);
    await limitContinuer.reconcile();
    for (const f of await mcp.reconcile(next.mcpServers)) warnings.push(`mcp ${f.name}: ${f.error}`);
    if (scheduler && store) {
      syncImproveJob(live(), store);
      disableLegacyLearnJob(store);
      scheduler.rearm();
    }
    return warnings;
  });

  const sideCommands = new SideCommands({ harness, models: built.models, remoteEnv: (worker, cwd) => workers.env(worker, cwd), reviewEnvironment: worker => workers.reviewEnvironment(worker), route: () => {
    const route = (settings?.resolved() ?? cfg).auxiliary.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  }, reviewRoute: () => {
    const route = (settings?.resolved() ?? cfg).auxiliary.review;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  }, cwd: cfg.cwd });

  // Session titles use their own route, else the side-question route; never the session model.
  const titler = new SessionTitler({ harness, conversations, models: built.models, route: () => {
    const aux = (settings?.resolved() ?? cfg).auxiliary, route = aux.session_title ?? aux.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  } });
  titler.start();
  recall?.titles((id) => conversations.get(id).title);

  return {
    uploads,
    sideCommands,
    titler,
    limitContinuer,
    config: cfg,
    settings,
    busyInput,
    sessionTalk,
    harness,
    conversations,
    /** Added to the agent of every session created in a project. */
    projectExtensions,
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
    workers,
    async close() {
      if (learnTimer) clearInterval(learnTimer);
      await learnRunning;
      await limitContinuer.close();
      await subagentNotifier.close();
      await crewNotifier.close();
      await titler.close();
      await sideCommands.close();
      providers.close();
      await scheduler?.stop();
      await codemodeSandbox?.close();
      await harness.close(context).catch(() => {});
      workers.close();
      workers.store.close();
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

/** Never recreate or re-enable the legacy model pass. Keep its history intact. */
function disableLegacyLearnJob(store: CronStore) {
  const job = store.listJobs().find(j => j.name === LEARN_JOB);
  if (job?.enabled) store.setEnabled(job.id, false);
}

/** Keep one built-in job in line with config: create, update, or disable it (`want` undefined = disabled). */
function syncJob(store: CronStore, name: string, want: string | undefined, prompt: string) {
  const existing = store.listJobs().find((j) => j.name === name);
  if (!want) { if (existing?.enabled) store.setEnabled(existing.id, false); return; }
  if (existing && (existing.expr !== want || existing.prompt !== prompt)) store.removeJob(existing.id);
  else if (existing) { if (!existing.enabled) store.setEnabled(existing.id, true); return; }
  store.addJob(name, want, prompt);
}
