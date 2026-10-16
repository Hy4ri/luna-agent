// One entrypoint that wires every subsystem from a validated LunaConfig: harness (coding tools, memory, skills),
// delegate, cron (scheduler + tools + delivery), MCP servers, tool_search, and the self-improvement loop.
// Only extensions named in config.extensions and MCP servers in config.mcpServers are loaded.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type MutableModels } from "@earendil-works/pi-ai";
import { createRegistry, type Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import type { LunaConfig } from "./config.js";
import { createCronExtension, deliverRun } from "./cron-tools.js";
import { Delegate } from "./delegate.js";
import { createImproveExtension, cronRunSource, SkillImprover } from "./improve.js";
import { context, MemoryStore, openLuna } from "./luna.js";
import { installMcpServers } from "./mcp.js";
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
  const log = o.log ?? ((m: string) => console.error(m));
  const on = (e: LunaConfig["extensions"][number]) => cfg.extensions.includes(e);
  mkdirSync(join(cfg.dataDir, "skills"), { recursive: true });

  const built = o.models ? { models: o.models, model: o.model! } : buildModels(cfg);
  // Adds the built-in and custom providers; the default model saved in the UI wins over config.
  const providers = new ProviderManager({ dataDir: cfg.dataDir, models: built.models, fallbackModel: built.model, fetch: o.fetch });
  const registry = createRegistry();

  // MCP first, so their (deferred) tools are in the registry before the harness resumes old runs.
  const mcp = await installMcpServers(registry, cfg.mcpServers);
  for (const f of mcp.failures) log(`mcp ${f.name}: failed to start: ${f.error}`);
  for (const c of mcp.connections) log(`mcp ${c.name}: ${c.toolNames.length} tools`);

  const cronDb = join(cfg.dataDir, "cron.db");
  const store = on("cron") || on("improve") ? new CronStore(cronDb) : undefined;
  let scheduler: Scheduler | undefined;

  const extensions: Extension[] = [];
  if (on("delegate")) extensions.push(Delegate);
  if (on("cron")) extensions.push(createCronExtension(store!, () => scheduler?.rearm()));
  if (on("improve")) {
    const imp = new SkillImprover({ skillsDir: join(cfg.dataDir, "skills"), sources: [cronRunSource(cronDb)] });
    extensions.push(createImproveExtension(imp, { allowCommandBenchmarks: cfg.improve.allowCommandBenchmarks }));
  }
  if (on("tool-search")) extensions.push(createToolSearchExtension());

  const memory = on("memory") ? new MemoryStore(join(cfg.dataDir, "memory.db")) : false;
  const harness = await openLuna({
    registry,
    dbPath: join(cfg.dataDir, "luna.db"),
    models: built.models,
    cwd: cfg.cwd,
    coding: on("coding"),
    memory,
    ...(on("skills") ? { skillDirs: cfg.allSkillDirs } : {}),
    extensions,
  });
  harness.resume(); // continue any run a previous process left unfinished

  if (on("cron")) {
    const notifyUrl = cfg.cron.notifyUrl;
    scheduler = new Scheduler({
      harness, store: store!, defaultModel: () => providers.defaultModel(), log,
      ...(cfg.cron.runTimeoutMinutes ? { runTimeoutMs: cfg.cron.runTimeoutMinutes * 60_000 } : {}),
      onFinish: notifyUrl ? (job, run) => deliverRun(notifyUrl, job, run, o.fetch) : undefined,
    });
    syncImproveJob(cfg, store!);
    await scheduler.start();
  }

  return {
    config: cfg,
    harness,
    models: built.models,
    providers,
    memory: memory || undefined,
    skillDirs: on("skills") ? cfg.allSkillDirs : undefined,
    model: built.model,
    store,
    scheduler,
    mcp,
    async close() {
      providers.close();
      await scheduler?.stop();
      await harness.close(context).catch(() => {});
      await mcp.close();
      store?.close();
      if (memory) memory.close();
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
