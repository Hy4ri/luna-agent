// Runtime config: one JSON file (LUNA_CONFIG, default ./luna.config.json) validated strictly with zod.
// Extensions are an allowlist of built-in names; MCP servers run only when listed here. Unknown keys,
// unknown extension names and duplicate MCP names are errors, never silently ignored.
// Secrets stay in the environment: LUNA_TOKEN for the API, provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { parseCron } from "./cron-expr.js";

export const BUILTIN_EXTENSIONS = ["coding", "memory", "skills", "delegate", "cron", "improve", "tool-search", "todo", "ask-user", "recall", "goal", "learn"] as const;
export type BuiltinExtension = (typeof BUILTIN_EXTENSIONS)[number];

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/, "1-40 letters, digits, _ or -");
const common = { name, enabled: z.boolean().optional(), defer: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() };
const headers = z.record(z.string(), z.string()).optional();
export const McpServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({ ...common, transport: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }),
  z.strictObject({ ...common, transport: z.literal("http"), url: z.url(), headers }),
  z.strictObject({ ...common, transport: z.literal("sse"), url: z.url(), headers }),
]);
export const CustomProviderSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), name: z.string().min(1),
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  baseUrl: z.url().refine(u => /^https?:/.test(u), "HTTP(S) URL required"),
  models: z.array(z.strictObject({ id: z.string().min(1), name: z.string().optional(),
    contextWindow: z.number().int().min(1000).optional(), maxTokens: z.number().int().min(1000).optional(),
    reasoning: z.boolean().optional(), vision: z.boolean().optional(),
  })).min(1),
});
const thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const cronExpr = z.string().refine((e) => { try { parseCron(e); return true; } catch { return false; } }, "invalid cron expression");

export const ConfigSchema = z
  .strictObject({
    /** Holds luna.db, memory.db, cron.db and skills/. */
    dataDir: z.string().default("~/.luna"),
    /** Default working directory for tools. */
    cwd: z.string().optional(),
    /** Default provider id (faux, a built-in provider, or a custom provider). */
    provider: z.string().regex(/^[a-z0-9-]{1,40}$/).default("faux"),
    model: z.string().optional(),
    thinkingLevel: thinking.optional(),
    instructions: z.string().optional(),
    busyInput: z.strictObject({
      mode: z.enum(["interrupt", "queue", "steer"]).default("interrupt"),
      acknowledgements: z.boolean().default(true),
    }).prefault({}),
    /** Continue a turn automatically after a usage limit resets. Off by default. */
    autoContinue: z.strictObject({
      enabled: z.boolean().default(false),
      /** Longer waits (for example a weekly cap) are not scheduled. */
      maxWaitHours: z.number().positive().max(24 * 31).default(168),
      /** Continuations in a row that may hit a limit again before Luna stops. */
      maxAttempts: z.number().int().min(1).max(50).default(5),
    }).prefault({}),
    /** Sessions can message each other with session_send. A peer message never interrupts and grants no permission. */
    sessionTalk: z.strictObject({
      enabled: z.boolean().default(true),
      /** Messages allowed in one exchange between two sessions before session_send refuses. */
      maxHops: z.number().int().min(1).max(20).default(3),
    }).prefault({}),
    compaction: z.strictObject({
      enabled: z.boolean().default(true),
      triggerPercent: z.number().int().min(1).max(99).default(75),
    }).prefault({}),
    video: z.strictObject({
      blocked_paths: z.array(z.string().min(1)).default([]),
      blocked_hosts: z.array(z.string().min(1)).default([]),
      timeout_ms: z.number().int().min(180_000).default(180_000),
    }).prefault({}),
    auxiliary: z.strictObject({
      side_question: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      session_title: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      video: z.strictObject({ model: z.string().min(1) }).optional(),
      vision: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
    }).prefault({}),
    vision: z.strictObject({
      image_mode: z.enum(["native", "auxiliary"]).default("native"),
      history_budget_bytes: z.number().int().positive().default(256 * 1024),
      long_edge: z.number().int().positive().default(2048),
      hard_bytes: z.number().int().positive().default(1024 * 1024),
      max_calls_per_image: z.number().int().nonnegative().default(0),
      subagent_max_calls_per_image: z.number().int().nonnegative().default(3),
      profiles: z.record(z.string(), z.strictObject({ tool_result_images: z.boolean() })).default({}),
    }).prefault({}),
    image_gen: z.strictObject({
      provider: z.string().trim().min(1).optional(),
      "openai-codex": z.strictObject({
        model: z.literal("gpt-image-2").default("gpt-image-2"),
        quality: z.enum(["low", "medium", "high"]).default("low"),
        codexHome: z.string().min(1).optional(), codexCommand: z.string().min(1).optional(),
      }).prefault({}),
    }).prefault({}),
    providers: z.array(CustomProviderSchema).default([]),
    // Agent-facing web tools use a common interface; options belong to each provider.
    web: z.strictObject({
      searchProvider: z.enum(["disabled", "ddgs"]).default("disabled"),
      extractProvider: z.enum(["disabled", "ddgs"]).default("disabled"),
      providers: z.strictObject({
        ddgs: z.strictObject({
          mcpServer: name.default("ddgs"),
          backend: z.string().trim().min(1).default("auto"),
          region: z.string().trim().min(1).default("us-en"),
          safesearch: z.enum(["on", "moderate", "off"]).default("moderate"),
        }).prefault({}),
      }).prefault({}),
    }).prefault({}),
    browser: z.strictObject({
      provider: z.enum(["disabled", "camofox"]).default("disabled"),
      providers: z.strictObject({
        camofox: z.strictObject({ mcpServer: name.default("camofox") }).prefault({}),
      }).prefault({}),
    }).prefault({}),
    processes: z.strictObject({
      enabled: z.boolean().default(false),
      retentionHours: z.number().positive().default(168),
      maxOutputBytes: z.number().int().min(1024).max(16777216).default(1048576),
    }).prefault({}),
    subagents: z.strictObject({
      provider: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(), model: z.string().min(1).optional(),
      thinkingLevel: thinking.optional(), cwd: z.string().optional(),
    }).prefault({}),
    extensions: z.array(z.enum(BUILTIN_EXTENSIONS)).default([...BUILTIN_EXTENSIONS]),
    /** Extra skill dirs, scanned after <dataDir>/skills. */
    skillDirs: z.array(z.string()).default([]),
    mcpServers: z.array(McpServerSchema).default([]),
    cron: z.strictObject({ notifyUrl: z.url().optional(), runTimeoutMinutes: z.number().positive().optional() }).prefault({}),
    improve: z.strictObject({ schedule: cronExpr.optional(), allowCommandBenchmarks: z.boolean().default(false) }).prefault({}),
    /** Session learning: scan idle conversations for lessons; a daily cron pass diagnoses them, applies routine fixes and holds critical ones for the user. */
    learn: z.strictObject({
      idleMinutes: z.number().positive().default(30),
      schedule: cronExpr.default("0 4 * * *"),
    }).prefault({}),
    server: z.strictObject({ host: z.string().default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(8787) }).prefault({}),
  })
  .superRefine((c, ctx) => {
    if (!!c.subagents.provider !== !!c.subagents.model) ctx.addIssue({ code: "custom", path: ["subagents"], message: "provider and model must be set together" });
    if (new Set(c.providers.map(p => p.id)).size !== c.providers.length) ctx.addIssue({ code: "custom", path: ["providers"], message: "duplicate provider id" });
    const builtinProviders = ["faux", "claude-cli", "anthropic", "openai", "github-copilot", "openrouter", "google", "xai", "deepseek", "groq", "mistral"];
    if (c.providers.some(p => builtinProviders.includes(p.id))) ctx.addIssue({ code: "custom", path: ["providers"], message: "custom provider id conflicts with a built-in provider" });
    const seen = new Set<string>();
    for (const s of c.mcpServers) {
      if (seen.has(s.name)) ctx.addIssue({ code: "custom", path: ["mcpServers"], message: `duplicate MCP server name "${s.name}"` });
      seen.add(s.name);
    }
    if (new Set(c.extensions).size !== c.extensions.length) ctx.addIssue({ code: "custom", path: ["extensions"], message: "duplicate extension" });
    if (c.improve.schedule && !c.extensions.includes("cron")) ctx.addIssue({ code: "custom", path: ["improve", "schedule"], message: "needs the cron extension" });
    if (c.improve.schedule && !c.extensions.includes("improve")) ctx.addIssue({ code: "custom", path: ["improve", "schedule"], message: "needs the improve extension" });
    if (c.provider !== "faux" && !c.model) ctx.addIssue({ code: "custom", path: ["model"], message: `model is required for provider ${c.provider}` });
  });

export type LunaConfig = z.output<typeof ConfigSchema> & { /** Resolved: <dataDir>/skills first, then skillDirs. */ allSkillDirs: string[]; configPath?: string };
export type McpServerConfig = LunaConfig["mcpServers"][number];

const expand = (p: string, base: string) => {
  const h = p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(h) ? h : resolve(base, h);
};

/** Parse and resolve a config object. `base` resolves relative paths (the config file's directory). */
export function parseConfig(raw: unknown, base = process.cwd(), env: NodeJS.ProcessEnv = process.env): LunaConfig {
  const obj: Record<string, any> = raw && typeof raw === "object" ? structuredClone(raw as object) : {};
  if (env.LUNA_DATA) obj.dataDir = env.LUNA_DATA;
  if (env.LUNA_CWD) obj.cwd = env.LUNA_CWD;
  if (env.LUNA_PROVIDER) obj.provider = env.LUNA_PROVIDER;
  if (env.LUNA_MODEL) obj.model = env.LUNA_MODEL;
  if (env.LUNA_HOST || env.LUNA_PORT) {
    obj.server = { ...(obj.server ?? {}) };
    if (env.LUNA_HOST) obj.server.host = env.LUNA_HOST;
    if (env.LUNA_PORT) obj.server.port = Number(env.LUNA_PORT);
  }
  const r = ConfigSchema.safeParse(obj);
  if (!r.success) throw new Error("invalid luna config:\n" + r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"));
  const c = r.data;
  const dataDir = expand(c.dataDir, base);
  return {
    ...c,
    dataDir,
    subagents: { ...c.subagents, ...(c.subagents.cwd ? { cwd: expand(c.subagents.cwd, base) } : {}) },
    cwd: c.cwd ? expand(c.cwd, base) : undefined,
    image_gen: { ...c.image_gen, "openai-codex": { ...c.image_gen["openai-codex"], ...(c.image_gen["openai-codex"].codexHome ? { codexHome: expand(c.image_gen["openai-codex"].codexHome, base) } : {}) } },
    skillDirs: c.skillDirs.map((d) => expand(d, base)),
    allSkillDirs: [join(dataDir, "skills"), ...c.skillDirs.map((d) => expand(d, base))],
    mcpServers: c.mcpServers.map((s) => (s.transport === "stdio" && s.cwd ? { ...s, cwd: expand(s.cwd, base) } : s)),
  };
}

/** Load LUNA_CONFIG (default ./luna.config.json). A missing default file means all defaults. */
export function loadConfig(path = process.env.LUNA_CONFIG): LunaConfig {
  const file = resolve(path ?? "luna.config.json");
  if (!existsSync(file)) {
    if (path) throw new Error(`config not found: ${file}`);
    return { ...parseConfig({}), configPath: file };
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
  return { ...parseConfig(raw, dirname(file)), configPath: file };
}
