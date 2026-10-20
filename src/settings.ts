// Shared user settings. Credentials and generated OAuth device state are not user configuration.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigSchema, parseConfig, type LunaConfig } from "./config.js";

export type Settings = ReturnType<typeof ConfigSchema.parse>;
const FORM_SCHEMA = ConfigSchema.toJSONSchema();
const HIDDEN = "<secret: unchanged>";

export class SettingsStore {
  private applied: Settings;
  get restartRequired() { return structural(this.read()) !== structural(this.applied); }
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
  resolved(env: NodeJS.ProcessEnv = process.env): LunaConfig { return parseConfig(this.read(), dirname(this.path), env); }
  private write(value: Settings) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  assertMutable() {
    if (this.restartRequired) throw new Error("Restart Luna to apply saved settings before making more changes.");
  }
  update(fn: (s: Settings) => void) {
    this.assertMutable();
    const next = this.read(); fn(next);
    const value = ConfigSchema.parse(next);
    this.write(value);
    this.applied = value;
  }
  revision() { return createHash("sha256").update(readFileSync(this.path)).digest("hex"); }
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
  const { provider, model, subagents, thinkingLevel, instructions, compaction, busyInput, autoContinue, auxiliary, vision, image_gen, ...rest } = s;
  return JSON.stringify(rest);
}
