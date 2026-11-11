import { createImageGenExtension, ImageGenManager, type ImageGenProvider } from "./image-gen.js";
import { ensureGeneratedDirectories, generatedDirectories, generatedFilesInstructions, generatedRoot, workerGeneratedRoot } from "./generated-files.js";
import { isWorkerEnv, WORKER_ENV_PREFIX } from "./worker-protocol.js";
import { UploadStore, workerUploadRoot } from "./uploads.js";
import { withUploadModels } from "./upload-models.js";
import { conversationStorage } from "./conversation-storage.js";
import { createOpenAICodexImageProvider } from "./plugins/image_gen/openai-codex.js";
import { createChatCompletionsImageProvider } from "./plugins/image_gen/chat-completions.js";
import { createCodexImageAuth } from "./codex-image-auth.js";
import { createMediaExtension } from "./media.js";
import { SideCommands } from "./side-commands.js";
import { ConversationStore } from "./conversations.js";
import { analyticsService } from "./analytics/index.js";
import { WifeStore } from "./wife/store.js";
import { WifeService } from "./wife/service.js";
import { createWifeExtension } from "./wife/tool.js";
import { createBoardExtension } from "./board.js";
import { createSessionTalkExtension } from "./session-talk.js";
import { createFileMentionExtension } from "./file-mentions.js";
import { createWorkerExecExtension } from "./worker-exec.js";
import { createSkillViewer, scanSkills } from "./skills.js";
// One entrypoint that wires every subsystem from a validated LunaConfig: harness (coding tools, memory, skills),
// delegate, cron (scheduler + tools + delivery), MCP servers, tool_search, and the self-improvement loop.
// Only extensions named in config.extensions and MCP servers in config.mcpServers are loaded.
import { mkdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { listSessionWorktrees, removeSessionWorktree } from "./wife/git.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createLunaCodemodeExtension } from "./codemode.js";
import { createAgentTerminalExtension } from "./terminal/agent-tools.js";
import { loadVt } from "./terminal/vt-model.js";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createDeferredToolsExtension } from "./deferred-tools.js";
import { SettingsStore } from "./settings.js";
import { BUILTIN_EXTENSIONS, BUILTIN_REGISTRY_NAMES, type LunaConfig } from "./config.js";
import { createToggleExtension } from "./toggles.js";
import { createStableToolsExtension } from "./stable-tools.js";
import { createSessionWorktreeExtension } from "./session-worktree.js";
import { createAskExtension } from "./ask.js";
import { createCronExtension, deliverRun } from "./cron-tools.js";
import { createDelegateExtension } from "./delegate.js";
import { DelegateResults } from "./delegate-results.js";
import { createGoalExtension } from "./goal.js";
import { createRecallExtension, RecallIndex } from "./recall.js";
import { Todo } from "./todo.js";
import { SkillImprover } from "./improve.js";
import { createSkillManageExtension, SkillManager } from "./skill-manage.js";
import { context, MemoryStore, openLuna } from "./luna.js";
import { McpManager, providerBackedServers } from "./mcp.js";
import { createBrowserResolver, createBrowserToolsExtension } from "./browser-tools.js";
import { BrowserPanel } from "./browser/panel.js";
import { createCamofoxBrowserProvider } from "./camofox-browser-provider.js";
import { createMoliBrowserProvider } from "./moli-browser-provider.js";
import { createChromiumBrowserProvider } from "./chromium-browser-provider.js";
import { createWebToolsExtension } from "./web-tools.js";
import { createDdgsWebProvider } from "./ddgs-web-provider.js";
import { createFreeserpWebProvider, createSearxngWebProvider } from "./http-search-providers.js";
import { FileCredentialStore, ProviderManager } from "./providers.js";
import { CronStore, Scheduler, type ModelRef } from "./scheduler.js";
import { SessionTitler } from "./titles.js";
import { RecoveryStateDoc } from "./recovery-state.js";
import { parseResetTime } from "./reset-time-parser.js";
import { LimitRecoveryService } from "./limit-recovery.js";
import { ScheduledMessagesService } from "./scheduled-messages.js";
import { DeviceStore, FcmSender, loadServiceAccount, PushNotifier } from "./push.js";
import { WebhookStore, Webhooks, type WebhookTargets } from "./webhooks.js";
import { createWebhookExtension } from "./webhook-tools.js";
import { createPlannedSession, linkProject, planSession } from "./session-create.js";
import { SubagentNotifier } from "./subagent-notify.js";
import { CrewNotifier, createSessionCrewExtension } from "./session-crew.js";
import { TerminalRegistry } from "./terminal/registry.js";
import { localLauncher } from "./terminal/pty-host.js";
import { TerminalService } from "./terminal/service.js";
import { createWorkersExtension, ExecTarget, WorkerHub, WorkerStore } from "./workers.js";
import { WorkerMcpProxy } from "./worker-mcp-proxy.js";
import { resolveThinkingLevel, withUltraModels } from "./thinking.js";
import { createSpeedExtension, withSpeedPricing } from "./speed.js";

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
  built.models = withSpeedPricing(withUltraModels(withUploadModels(built.models, uploads)));
  // Register built-in and configured providers. File-backed runtimes share one settings store.
  const providers = new ProviderManager({ dataDir: cfg.dataDir, models: built.models, fallbackModel: built.model, fetch: o.fetch, settings });
  if (!o.models) {
    const refreshed = await providers.refreshCatalog(false);
    for (const [id, error] of Object.entries(refreshed.errors)) log(`models ${id}: ${error}`);
  }
  providers.startAutoRefresh();
  const registry = createRegistry();

  // MCP first, so their (deferred) tools are in the registry before the harness resumes old runs.
  // A server behind a selected web or browser provider stays connected, but the model gets only the native tool.
  const mcp = new McpManager(registry, cfg.mcpServers, join(cfg.dataDir, "mcp.json"), settings, () => providerBackedServers(settings?.resolved() ?? cfg));
  await mcp.start();
  for (const f of mcp.failures) log(`mcp ${f.name}: failed to start: ${f.error}`);
  for (const c of mcp.connections) log(`mcp ${c.name}: ${c.toolNames.length} tools`);

  const cronDb = join(cfg.dataDir, "cron.db");
  const store = on("cron") ? new CronStore(cronDb) : undefined;
  let scheduler: Scheduler | undefined;

  let harnessRef: Awaited<ReturnType<typeof openLuna>> | undefined;
  const extensions: Extension[] = [];
  // Workers hub early so browser tools can proxy to the session's worker.
  const terminals = new TerminalService({
    registry: new TerminalRegistry({
      launcher: (worker, options) => worker === null ? localLauncher(null, options)
        : workers.openPty(worker, { cwd: options.cwd, cols: options.cols, rows: options.rows, ...(options.command ? { command: options.command } : {}) }),
      vt: loadVt,
    }),
    enabled: () => (settings?.shared() ?? cfg).terminal.user,
    agentEnabled: () => (settings?.shared() ?? cfg).terminal.agent,
  });
  const workers = new WorkerHub(new WorkerStore(join(cfg.dataDir, "workers.db")), log);
  extensions.push(createWorkersExtension(() => workers));
  extensions.push(createWorkerExecExtension({ hub: () => workers }));
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
  const imageGenConfig = () => (settings?.shared() ?? cfg).image_gen;
  const imageGen = new ImageGenManager({ config: imageGenConfig, providers: o.imageGenProviders ?? new Map([
    ["openai-codex", createOpenAICodexImageProvider({ config: () => imageGenConfig()["openai-codex"],
      auth: createCodexImageAuth({ config: () => imageGenConfig()["openai-codex"] }),
      outputDir: generatedDirectories(outputRoot).images, fetch: o.fetch })],
    ["chat-completions", createChatCompletionsImageProvider({ config: () => imageGenConfig()["chat-completions"],
      models: built.models, outputDir: generatedDirectories(outputRoot).images, fetch: o.fetch })],
  ]) });
  extensions.push(createToggleExtension(() => live().disabledTools));
  extensions.push(createAgentTerminalExtension({ registry: terminals.registry, enabled: () => live().terminal.agent, cwd: cfg.cwd, wrapSearch: on("tool-search") }));
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
  extensions.push(createMediaExtension({ config: () => settings?.resolved() ?? cfg, models: built.models, defaultModel: () => providers.defaultModel(), fetch: o.fetch,
    history: async (id, ctx) => {
      const view = await (await harnessRef!.conversation(id, ctx))!.context(ctx);
      return { ...view, messages: uploads.hydrate(view.messages) };
    } }));
  // Read per call so Settings changes apply to the next tool call.
  const live = () => settings?.shared() ?? cfg;
  extensions.push(createWebToolsExtension(() => live().web, new Map([
    ["ddgs", createDdgsWebProvider(() => live().web.providers.ddgs, mcp)],
    ["searxng", createSearxngWebProvider(() => live().web.providers.searxng, o.fetch)],
    ["freeserp", createFreeserpWebProvider(() => live().web.providers.freeserp, o.fetch)],
  ])));
  const browserProviders = new Map([
    ["camofox", createCamofoxBrowserProvider(() => live().browser.providers.camofox, mcp)],
    ["moli", createMoliBrowserProvider(() => live().browser.providers.moli)],
    ["chromium", createChromiumBrowserProvider(() => live().browser.providers.chromium)],
  ]);
  const browserPanel = new BrowserPanel({
    enabled: () => live().browser.panel && live().browser.provider !== "disabled",
    resolve: createBrowserResolver(() => live().browser, browserProviders, { hub: () => workers }),
  });
  extensions.push(createBrowserToolsExtension(() => live().browser, browserProviders, { hub: () => workers, panel: browserPanel }));
  // Identity belongs to top-level and cron sessions. Delegated children remove this extension.
  extensions.push(defineExtension({ name: "identity", sections: [section("identity", () => {
    // SOUL.md is the only identity file. User facts and memories live in memory.db (memory section).
    // Sent with every prompt, so the file is capped; the model can read the full file with its tools.
    const CAP = 4000, path = join(cfg.dataDir, "SOUL.md");
    if (!existsSync(path)) return undefined;
    const body = readFileSync(path, "utf8");
    const cut = body.length > CAP ? `${body.slice(0, CAP)}\n[truncated: ${body.length - CAP} more chars in ${path}]` : body;
    return `## SOUL.md\n${cut}`;
  })] }));
  if (on("delegate")) extensions.push(DelegateResults, createDelegateExtension(() => settings?.resolved().subagents ?? cfg.subagents, () => (settings?.resolved() ?? cfg).compaction.subagents));
  // Crew sessions are full sessions, created with the same rules as the web UI's new-session request.
  let projectExtensions: Extension[] = [];
  const newSessionAgent = () => {
    const c = live();
    const model = providers.defaultModel();
    return { model, thinkingLevel: resolveThinkingLevel(built.models, model, c), ...(c.maxTurns ? { maxTurns: c.maxTurns } : {}), ...(c.instructions ? { instructions: c.instructions } : {}) };
  };
  if (on("delegate")) extensions.push(createSessionCrewExtension({
    harness: () => harnessRef,
    session: () => conversationsRef && { base: newSessionAgent, thinking: live, models: built.models, projects: conversationsRef.projects, workers: workers.store, projectExtensions },
    projects: () => conversationsRef?.projects,
    workers: () => workers.list(),
    title: id => conversationsRef?.get(id).title ?? null,
    setTitle: (id, title) => conversationsRef!.update(id, { title }),
  }));
  // Webhooks: the store and receiver always run; the extension name only controls the agent tools.
  let webhookTargets: WebhookTargets | undefined;
  const webhooks = new Webhooks(new WebhookStore(join(cfg.dataDir, "webhooks.db")), { targets: () => webhookTargets, fetch: o.fetch, log });
  if (on("webhooks")) extensions.push(createWebhookExtension(() => webhooks));
  const improver = on("skills") ? new SkillImprover({ skillsDir: join(cfg.dataDir, "skills"), readDirs: cfg.allSkillDirs }) : undefined;
  if (on("cron")) extensions.push(createCronExtension(store!, () => scheduler?.rearm(), () => scheduler, { jobs: () => live().extensions.includes("cron") }));
  const disabledSkills = (id?: number) => {
    const global = live().disabledSkills;
    const pid = id === undefined ? undefined : conversationsRef?.projects.projectOf(id);
    return pid ? conversationsRef!.projectSkills.disabled(pid, global, () => scanSkills(cfg.allSkillDirs).map(s => s.name)) : global;
  };
  if (on("skills")) extensions.push(createSkillManageExtension(new SkillManager(improver!, cfg.allSkillDirs), improver!, {
    allowCommandBenchmarks: () => live().improve.allowCommandBenchmarks,
    view: { load: createSkillViewer({ dirs: cfg.allSkillDirs, disabled: disabledSkills }), enabled: () => live().extensions.includes("skills") },
  }));
  const memory = on("memory") ? new MemoryStore(join(cfg.dataDir, "memory.db")) : false;
  if (on("tool-search")) extensions.push(createToolSearchExtension(), createDeferredToolsExtension());
  if (on("todo")) extensions.push(Todo);
  // All chat sessions get a board. Unlinked sessions use General. The store exists once the harness is open.
  let conversationsRef: ConversationStore | undefined;
  const board = createBoardExtension(() => conversationsRef);
  extensions.push(board);
  projectExtensions = [board];
  let wifeRef: WifeService | undefined;
  let cancelScheduledRef: ((id: number) => Promise<unknown>) | undefined;
  if (on("wife")) extensions.push(createWifeExtension({
    wife: () => wifeRef,
    sessionExists: id => !!conversationsRef && conversationsRef.exists(id),
    conversations: () => conversationsRef,
    onArchive: id => cancelScheduledRef?.(id) ?? Promise.resolve(),
  }));
  extensions.push(createSessionWorktreeExtension({ projects: () => conversationsRef?.projects, title: id => conversationsRef?.get(id).title }));
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
  const sessionTalk = () => (settings?.shared() ?? cfg).sessionTalk;
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
  extensions.push(createSpeedExtension());
  extensions.push(createFileMentionExtension({ home: (w) => w === null ? homedir() : workers.store.get(w)?.capabilities?.home }));

  const codemodeSandbox = on("codemode") ? new CodemodeSandbox({
    memoryLimitBytes: cfg.codemode.memoryLimitBytes,
  }) : undefined;
  if (codemodeSandbox) extensions.push(createLunaCodemodeExtension({
    sandbox: codemodeSandbox,
    inlineBudget: cfg.codemode.inlineBudget,
    models: false,
  }, cfg.codemode.timeoutMs, cfg.codemode.pinned));
  // After the toggle filter, so a disabled codemode is already gone from the request it checks.
  if (codemodeSandbox) extensions.push(createStableToolsExtension({ models: built.models, defaultModel: () => providers.defaultModel() }));

  const busyInput = () => settings?.shared().busyInput ?? cfg.busyInput;
  const harness = await openLuna({
    registry,
    compaction: () => (settings?.shared() ?? cfg).compaction,
    afterFailedRun: () => (settings?.shared() ?? cfg).afterFailedRun,
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
    ...(on("skills") ? { skillDirs: cfg.allSkillDirs, disabledSkills } : {}),
    // A built-in missing from the live list is hidden from sessions. Its store and scheduler keep running.
    hiddenExtensions: () => {
      const on = live().extensions;
      const hidden = new Set(BUILTIN_EXTENSIONS.filter(e => !on.includes(e)).flatMap(e => BUILTIN_REGISTRY_NAMES[e]));
      if (!on.includes("cron")) hidden.add("cron");
      if (!on.includes("skills")) hidden.add("skill-manage");
      return hidden;
    },
    extensions,
  });
  uploads.bind(conversationStorage(harness).db);
  const conversations = new ConversationStore(harness, recall, uploads);
  conversationsRef = conversations;
  const wifeStore = new WifeStore(join(cfg.dataDir, "wife.db"));
  const skillMgr = improver ? new SkillManager(improver, cfg.allSkillDirs) : undefined;
  const wife = new WifeService({ store: wifeStore, analytics: () => analyticsService(harness, conversations).store, conversations, config: () => live().wife, log,
    cron: store ? { jobs: () => store.listJobs().map(j => ({ id: j.id, name: j.name, enabled: j.enabled, runs: store.runs(j.id, 7).map(r => ({ status: r.status, output: r.output ?? null, startedAt: r.startedAt })) })),
      disable: id => { store.setEnabled(id, false); scheduler?.rearm(); } } : undefined,
    startSession: (project, title, content, requestId) => webhookTargets!.newSession(project ?? 0, title, content, requestId),
    scheduleMessage: async (sessionId, content, dueAt, requestId) => {
      await harness.commit(tx => scheduledMessages.create(tx, { conversationId: sessionId, content, dueAt, requestId, source: { kind: "user" } }), context);
      await scheduledMessages.scheduleChanged();
    },
    worktrees: () => listSessionWorktrees([...new Set([cfg.cwd ?? "", ...conversations.projects.list().map(p => p.cwd)])]),
    removeWorktree: async (path, branch) => removeSessionWorktree(path, branch),
    terminals: () => terminals.registry.all().map(t => ({ id: t.id, session: t.session, command: t.command, status: t.status })),
    closeTerminal: id => terminals.registry.close(id),
    browserTabs: () => browserPanel.all().map(t => ({ tabId: t.tabId, session: t.session, url: t.url })),
    closeBrowserTab: (session, tabId) => browserPanel.close(session, tabId),
    skills: skillMgr ? () => skillMgr.list().map(s => ({ name: s.name, managed: s.managed, modified: statSync(s.path).mtimeMs })) : undefined,
    trashSkill: skillMgr ? name => { skillMgr.deleteSkill(name); } : undefined,
    userMessages: recall ? (since, first) => (first
      ? recall.db.query<{ conv: number; ts: number; text: string }, [number]>("SELECT m.conv AS conv, m.ts AS ts, m.head AS text FROM messages m WHERE m.role='user' AND m.entry=(SELECT MIN(entry) FROM messages WHERE conv=m.conv AND role='user') AND m.ts>=?").all(since)
      : recall.db.query<{ conv: number; ts: number; text: string }, [number]>("SELECT conv, ts, head AS text FROM messages WHERE role='user' AND tail='' AND length(head) BETWEEN 30 AND 600 AND ts>=? LIMIT 20000").all(since)) : undefined,
    skillExists: name => scanSkills(cfg.allSkillDirs).some(sk => sk.name === name),
    remember: memory ? ({ key, content }) => {
      const old = key ? memory.recall(key, { kind: "fact" }).find(r => r.key === key) : undefined;
      const row = memory.remember({ content, key });
      return { key: row.key ?? null, before: old?.content ?? null };
    } : undefined,
    restoreMemory: memory ? (key, content) => {
      for (const r of memory.recall(key, { kind: "fact" })) if (r.key === key) memory.forget(r.id);
      if (content !== null) memory.remember({ key, content });
    } : undefined,
    setConfig: settings ? fn => settings.update(c => fn(c.wife as unknown as Record<string, unknown>)) : undefined,
    extensions: settings ? { enabled: n => settings.read().extensions.includes(n as never), enable: n => settings.update(c => { if (!c.extensions.includes(n as never)) c.extensions.push(n as never); }) } : undefined });
  wifeRef = wife;
  conversations.subscribeDeleted(ids => { for (const id of ids) { terminals.registry.closeSession(id); browserPanel.closeSession(id); } });
  harnessRef = harness;
  // Subscribe before recovered work can settle; reconcile undelivered results without replaying work.
  const subagentNotifier = new SubagentNotifier({ harness, log, skip: id => conversations.get(id).archived });
  if (on("delegate")) await subagentNotifier.start();
  const crewNotifier = new CrewNotifier({ harness, log, title: id => conversations.get(id).title, skip: id => conversations.get(id).archived });
  if (on("delegate")) await crewNotifier.start();
  // Android push: needs a Firebase service-account key. Without one the feature is off.
  let push: { devices: DeviceStore; notifier: PushNotifier } | undefined;
  if (cfg.push.serviceAccountFile) {
    try {
      const devices = new DeviceStore(join(cfg.dataDir, "push-devices.json"));
      const sender = new FcmSender(loadServiceAccount(cfg.push.serviceAccountFile), devices, o.fetch);
      const notifier = new PushNotifier({ harness, log, send: m => sender.send(m), title: id => conversations.get(id).title,
        skip: id => conversations.get(id).archived, isCron: id => !!store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1").get(String(id)) });
      notifier.start();
      push = { devices, notifier };
    } catch (e) { log(`push disabled: ${(e as Error).message}`); }
  }
  // Outbound webhooks: the same status transitions as push, as session.<status> events.
  const webhookNotifier = new PushNotifier({ harness, log,
    send: async m => { webhooks.emit(`session.${m.status}`, { title: m.title, text: m.body, sessionId: Number(m.sessionId), status: m.status }); },
    title: id => conversations.get(id).title, skip: id => conversations.get(id).archived,
    isCron: id => !!store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1").get(String(id)) });
  webhookNotifier.start();
  // Continue after a usage limit resets. Cron runs have their own timeout and run log, so they never wait.
  const isCronConversation = store?.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1");
  const scheduledMessages = new ScheduledMessagesService({
    harness,
    log,
    defaultModel: () => providers.defaultModel(),
    recoveryPolicy: () => live().autoContinue,
    skip: (id) => conversations.get(id).archived || !!isCronConversation?.get(String(id)),
  });
  await scheduledMessages.start();
  cancelScheduledRef = id => scheduledMessages.cancelForConversation(id, "all", "Session archived.");

  const limitRecovery = new LimitRecoveryService({
    harness,
    scheduledMessages,
    log,
    policy: () => {
      const ac = (settings?.shared() ?? cfg).autoContinue;
      return { enabled: ac.enabled, maxWaitHours: ac.maxWaitHours, resetGraceSeconds: ac.resetGraceSeconds };
    },
    defaultModel: () => providers.defaultModel(),
    parserModel: failedModel => {
      const defaults = live().subagents;
      return defaults.provider && defaults.model
        ? { provider: defaults.provider, modelId: defaults.model }
        : failedModel;
    },
    parseResetTime: input => parseResetTime(built.models, input),
    skip: (id) => conversations.get(id).archived || !!isCronConversation?.get(String(id)),
  });
  await limitRecovery.start();

  harness.resume(); // continue any run a previous process left unfinished

  if (on("cron")) {
    scheduler = new Scheduler({
      harness, store: store!, defaultModel: () => providers.defaultModel(), log,
      thinkingLevel: model => resolveThinkingLevel(built.models, model, live()),
      runTimeoutMs: () => { const m = live().cron.runTimeoutMinutes; return m ? m * 60_000 : 30 * 60_000; },
      retention: () => live().cron.retention,
      onFinish: (job, run) => {
        if (run.status === "ok" || run.status === "error") {
          const ok = run.status === "ok", name = job?.name ?? `job ${run.jobId}`;
          webhooks.emit(ok ? "cron.run.ok" : "cron.run.failed", {
            title: `Cron ${name} ${ok ? "ok" : "failed"}`, text: ((ok ? run.output : run.error) ?? "").slice(0, 4000),
            jobId: run.jobId, runId: run.id, jobName: name, status: run.status, reason: run.reason,
            sessionId: run.conversationId ? Number(run.conversationId) : null,
          }, `evt_cron_run_${run.id}`);
        }
        const url = notifyUrl(); return url ? deliverRun(url, job, run, o.fetch) : undefined;
      },
      exclude: [board, ...(ask ? [ask] : [])],
      // Wife's model pass stays home when no session (other than cron runs) was active since its last run.
      skipRun: job => {
        if (job.name !== WIFE_JOB_NAME || !wifeRef) return null;
        const last = store!.queryRuns({ jobId: job.id, history: true, limit: 5 }).find(r => r.status === "ok" || r.status === "error");
        if (!last) return null;
        const cron = store!.db.prepare("SELECT 1 FROM runs WHERE conversation_id=? LIMIT 1");
        return wifeRef.activitySince(last.startedAt, id => !!cron.get(String(id))) ? null : "no session activity since the last run";
      },
    });
    disableLegacyJobs(store!);
    syncWifeJob(store!, live().wife, on("wife"));
    await scheduler.start();
  }

  webhookTargets = {
    async toSession(id, content, requestId) {
      const conv = await harness.conversation(id as never, context);
      if (!conv) return false;
      await scheduledMessages.cancelForConversation(id, "limit_recovery", "New input replaced automatic recovery.");
      await conv.submit({ type: "input", content, requestId }, context);
      return true;
    },
    async newSession(project, title, content, requestId) {
      const plan = planSession({ base: newSessionAgent, thinking: live, models: built.models, projects: conversations.projects, workers: workers.store, projectExtensions },
        { project: project || null });
      const id = Number(await harness.commit(tx => createPlannedSession(tx, plan), context));
      linkProject(conversations.projects, id, plan);
      conversations.update(id, { title });
      const conv = await harness.conversation(id as never, context);
      await conv!.submit({ type: "input", content, requestId }, context);
      return id;
    },
    async runCron(id) {
      if (!scheduler) throw new Error("cron is disabled");
      return scheduler.runNow(id).id;
    },
    async exists(t) {
      if (t.kind === "session") return !!await harness.conversation(t.id as never, context);
      if (t.kind === "project") return t.id === 0 || !!conversations.projects.get(t.id);
      return !!store?.getJob(t.id);
    },
  };
  webhooks.start();
  wife.start();

  // Settings saved while running: bring live state in line without a restart.
  settings?.onApply(async (_old, next) => {
    const warnings: string[] = [];
    providers.reconcile(next.providers);
    if (!next.autoContinue.enabled) {
      const ids = await harness.commit(async tx => Object.values((await tx.doc(RecoveryStateDoc)).attempts)
        .filter(a => a.status === "parsing" || a.status === "scheduled").map(a => a.conversationId), context);
      for (const id of new Set(ids)) await scheduledMessages.cancelForConversation(id, "limit_recovery", "Automatic recovery disabled.");
    }
    await scheduledMessages.scheduleChanged();
    for (const f of await mcp.reconcile(next.mcpServers)) warnings.push(`mcp ${f.name}: ${f.error}`);
    mcp.syncExposure();
    if (scheduler && store) {
      disableLegacyJobs(store);
      syncWifeJob(store, next.wife, next.extensions.includes("wife" as never));
      scheduler.rearm();
    }
    return warnings;
  });

  const sideCommands = new SideCommands({ harness, models: built.models, remoteEnv: (worker, cwd) => workers.env(worker, cwd), reviewEnvironment: worker => workers.reviewEnvironment(worker), route: () => {
    const route = (settings?.shared() ?? cfg).auxiliary.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  }, reviewRoute: () => {
    const route = (settings?.shared() ?? cfg).auxiliary.review;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  }, cwd: cfg.cwd });

  // Session titles use their own route, else the side-question route; never the session model.
  const titler = new SessionTitler({ harness, conversations, models: built.models, route: () => {
    const aux = (settings?.shared() ?? cfg).auxiliary, route = aux.session_title ?? aux.side_question;
    return route ? { provider: route.provider, modelId: route.model } : undefined;
  } });
  titler.start();
  recall?.titles((id) => conversations.get(id).title);

  return {
    uploads,
    sideCommands,
    titler,
    scheduledMessages,
    push: push?.devices,
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
    improver,
    wife,
    store,
    scheduler,
    mcp,
    workers,
    terminals,
    browserPanel,
    webhooks,
    async close() {
      wife.stop();
      wifeStore.close();
      await limitRecovery.close();
      await scheduledMessages.close();
      await push?.notifier.close();
      await webhookNotifier.close();
      await webhooks.close();
      webhooks.store.close();
      await subagentNotifier.close();
      await crewNotifier.close();
      await titler.close();
      await sideCommands.close();
      providers.close();
      await scheduler?.stop();
      await codemodeSandbox?.close();
      await harness.close(context).catch(() => {});
      terminals.close();
      browserPanel.closeAll();
      workers.close();
      workers.store.close();
      await mcp.close();
      store?.close();
      if (memory) memory.close();
      recall?.close();
    },
  };
}

/** Session learning and the self-improve loop were replaced by Wife. Disable their old jobs and keep the history. */
const LEGACY_JOBS = ["luna-learn", "luna-self-improve"];
function disableLegacyJobs(store: CronStore) {
  for (const job of store.listJobs()) if (LEGACY_JOBS.includes(job.name) && job.enabled) store.setEnabled(job.id, false);
}

/** Prompt of the daily model pass. Self-contained: a cron run starts with no other context. */
export const WIFE_JOB_NAME = "luna-wife";
export const WIFE_JOB_PROMPT = [
  "You are Wife's daily review. File suggestion cards with the `wife` tool. Use only its list and suggest actions. Do not change anything else.",
  "1. Call `wife action=list`. Never file a card whose fingerprint is listed.",
  "2. Use `session_search` and recall to read sessions active since your last run. Read `skill action=list` and search memory first, so you do not duplicate what exists.",
  "3. Procedures that repeat across sessions become kind=skill cards (payload {name, existing, outline}). Stable facts or preferences m57 stated more than once become kind=memory cards (payload {key, content}).",
  "   Two skills that overlap or load together become a kind=skill card with existing=true and an outline that merges them. Facts or notes that contradict each other or are out of date become a kind=memory card with the corrected content for the same key. A correction m57 made in 3 or more sessions becomes a memory card (a fact) or a skill card (a procedure rule).",
  "   Also: a repeated way m57 uses tools that a new rule could flag becomes kind=new_rule (payload {tip:{id,title,body,when:{tool,minCalls,minSessions,withinDays,withoutTool,kind,project,cwd,idleDays}}}); a good rule that needs data Wife does not collect becomes kind=rule_idea (payload {idea}). If m57 said remind me, later, or tomorrow in a session and nothing scheduled it, file kind=reminder_unscheduled with a future dueAt (payload {sessionId, content, dueAt}).",
  "4. File at most 5 cards with `wife action=suggest`. Each needs real evidence sessions with a note. Prefer fewer, stronger cards.",
  "5. Finish with one line: what you filed, or 'nothing'.",
].join("\n");
/** Keep the built-in luna-wife job in step with config: create it, change its schedule, or turn it off. */
export function syncWifeJob(store: CronStore, wife: { enabled: boolean; modelSchedule?: string }, extensionOn: boolean) {
  const want = wife.enabled && extensionOn && !!wife.modelSchedule;
  const job = store.listJobs().find(j => j.name === WIFE_JOB_NAME);
  if (!job) { if (want) store.addJob(WIFE_JOB_NAME, wife.modelSchedule!, WIFE_JOB_PROMPT, undefined, Date.now(), "changes"); return; }
  if (want && (job.expr !== wife.modelSchedule || job.prompt !== WIFE_JOB_PROMPT)) store.updateJob(job.id, { expr: wife.modelSchedule, prompt: WIFE_JOB_PROMPT });
  if (job.enabled !== want) store.setEnabled(job.id, want);
}
