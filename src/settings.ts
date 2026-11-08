// Shared user settings. Credentials and generated OAuth device state are not user configuration.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigSchema, parseConfig, type LunaConfig } from "./config.js";

export type Settings = ReturnType<typeof ConfigSchema.parse>;
const FORM_SCHEMA = ConfigSchema.toJSONSchema();
const HIDDEN = "<secret: unchanged>";
// Every environment input of parseConfig, including HOME for `~` expansion.
const RESOLVE_ENV = ["LUNA_DATA", "LUNA_CWD", "LUNA_PROVIDER", "LUNA_MODEL", "LUNA_HOST", "LUNA_PORT", "HOME"] as const;

export class SettingsStore {
  private applied: Settings;
  private resolvedCache?: { file: string; env: string; value: LunaConfig };
  private listeners: ((old: Settings, next: Settings) => Promise<string[]>)[] = [];
  get restartRequired() {
    const next = this.read();
    // Turning an extension off applies live. Turning one on needs a restart only if it did not start at boot.
    return structural(next) !== structural(this.applied) || next.extensions.some(e => !this.applied.extensions.includes(e));
  }
  constructor(readonly path: string, dataDir: string) {
    const raw = this.readRaw();
    let changed = !existsSync(path) || raw.providers === undefined;
    const migrate = raw.providers === undefined;
    const legacyProviders = join(dataDir, "providers.json"), legacyMcp = join(dataDir, "mcp.json");
    // Only migrate absent fields. Old files remain as backups and never override the new file.
    if (migrate && existsSync(legacyProviders)) {
      const old = JSON.parse(readFileSync(legacyProviders, "utf8"));
      if (raw.providers === undefined) { raw.providers = old.custom ?? []; changed = true; }
      if (old.defaultModel) {
        // The old UI default had precedence over the config default.
        raw.provider = old.defaultModel.provider; raw.model = old.defaultModel.modelId; changed = true;
      }
    }
    if (existsSync(legacyMcp) && migrate) {
      const old = JSON.parse(readFileSync(legacyMcp, "utf8"));
      const servers = raw.mcpServers ?? [];
      raw.mcpServers = [...servers, ...(old.servers ?? []).filter((s: {name: string}) => !servers.some((c: {name: string}) => c.name === s.name))];
      changed = true;
    }
    this.applied = ConfigSchema.parse(raw);
    if (changed) this.write(this.applied);
  }
  private readRaw(): Record<string, any> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }
  read(): Settings { return ConfigSchema.parse(this.readRaw()); }
  /**
   * Live policy reads call this many times per request. Reuse the validated result until the file changes.
   * The file identity includes inode and nanosecond change time, so atomic saves and external edits both refresh it.
   * Callers receive a private copy and may change it freely.
   */
  resolved(env: NodeJS.ProcessEnv = process.env): LunaConfig {
    const file = this.fileIdentity(), envKey = RESOLVE_ENV.map(k => env[k] ?? "\0").join("\n");
    const cached = this.resolvedCache;
    if (cached && cached.file === file && cached.env === envKey) return structuredClone(cached.value);
    const value = parseConfig(this.read(), dirname(this.path), env);
    this.resolvedCache = { file, env: envKey, value };
    return structuredClone(value);
  }
  private fileIdentity() {
    try {
      const s = statSync(this.path, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch { return "missing"; }
  }
  private write(value: Settings) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + "." + crypto.randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  /** Register live-apply code. It runs after a Settings form save; it returns warnings for the UI. */
  onApply(fn: (old: Settings, next: Settings) => Promise<string[]>) { this.listeners.push(fn); }
  /** Apply a saved change to the running daemon. Fields in `structural` still need a restart. */
  async apply(old: Settings): Promise<string[]> {
    const next = this.read(), warnings: string[] = [];
    for (const fn of this.listeners) {
      try { warnings.push(...await fn(old, next)); } catch (e) { warnings.push((e as Error).message); }
    }
    return warnings;
  }
  update(fn: (s: Settings) => void) {
    const next = this.read(); fn(next);
    this.write(ConfigSchema.parse(next));
  }
  revision() { return new Bun.CryptoHasher("sha256").update(readFileSync(this.path)).digest("hex"); }
  view() {
    const config = this.read();
    for (const s of config.mcpServers) {
      if (s.transport === "stdio") { for (const k of Object.keys(s.env ?? {})) s.env![k] = HIDDEN; }
      else { for (const k of Object.keys(s.headers ?? {})) s.headers![k] = HIDDEN; s.url = hideUrl(s.url); }
    }
    for (const p of config.providers) p.baseUrl = hideUrl(p.baseUrl);
    return { schema: FORM_SCHEMA, config, revision: this.revision(), path: this.path, restartRequired: this.restartRequired, environmentOverrides: ["LUNA_DATA", "LUNA_CWD", "LUNA_PROVIDER", "LUNA_MODEL", "LUNA_HOST", "LUNA_PORT"].filter(k => !!process.env[k]) };
  }
  replace(input: unknown, revision: string) {
    if (revision !== this.revision()) throw new Error("Settings changed. Reload before saving.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("config must be an object");
    const raw = structuredClone(input) as Settings;
    const old = this.read();
    for (const s of raw.mcpServers ?? []) {
      const prev = old.mcpServers.find(p => p.name === s.name && p.transport === s.transport);
      if (s.transport === "stdio") restoreMap(s.env, prev?.transport === "stdio" ? prev.env : undefined);
      else {
        restoreMap(s.headers, prev && prev.transport !== "stdio" ? prev.headers : undefined);
        if (s.url === HIDDEN && prev && prev.transport !== "stdio") s.url = prev.url;
      }
    }
    for (const p of raw.providers ?? []) {
      if (p.baseUrl === HIDDEN) p.baseUrl = old.providers.find(o => o.id === p.id)?.baseUrl ?? HIDDEN;
    }
    const value = ConfigSchema.parse(raw);
    this.write(value);
  }
}
function hideUrl(value: string) {
  const u = new URL(value);
  return u.username || u.password || u.search || u.hash ? HIDDEN : value;
}
function restoreMap(map: Record<string,string> | undefined, old: Record<string,string> | undefined) {
  for (const k of Object.keys(map ?? {})) if (map![k] === HIDDEN) {
    if (old?.[k] === undefined) throw new Error(`No saved secret for ${k}`);
    map![k] = old[k];
  }
}

function structural(s: Settings) {
  // Only these fields are read once at startup. Everything else applies live.
  const { dataDir, cwd, skillDirs, processes, server } = s;
  return JSON.stringify({ dataDir, cwd, skillDirs, processes, server });
}
