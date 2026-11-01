// Model providers: built-in pi-ai providers (API key and subscription OAuth logins), user-added custom
// OpenAI/Anthropic-compatible endpoints, a persistent credential store, and the default model.
// Runtime settings use SettingsStore. Standalone users retain the legacy providers.json adapter.
// Credentials remain in auth.json (mode 0600); generated OAuth device identity is not user configuration.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createModels, createProvider, type AuthEvent, type AuthPrompt, type AuthType, type Credential, type CredentialInfo,
  type CredentialStore, type Model, type MutableModels, type Provider,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiCodexProvider as baseOpenaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "./openai-context.js";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ModelRef } from "./scheduler.js";
import type { SettingsStore } from "./settings.js";
import { claudeCliProvider } from "./claude-cli.js";
import { opencodeCliProvider } from "./opencode-cli.js";
import { invalidateClaudeLoginStatus } from "./claude-native/status.js";

/** Codex subscription (ChatGPT OAuth, chatgpt.com/backend-api). It uses the Codex plan quota, not the Sign in with ChatGPT sharing quota of `openai`. */
const openaiCodexProvider = (): Provider => ({ ...baseOpenaiCodexProvider(), name: "OpenAI Codex" });

/** Built-in providers offered in the UI. Each brings its own catalog, API-key auth and (where supported) OAuth login. */
export const BUILTIN_PROVIDERS: ((fetchImpl?: typeof fetch) => Provider)[] = [
  claudeCliProvider, opencodeCliProvider, anthropicProvider, openaiProvider, openaiCodexProvider, githubCopilotProvider, openrouterProvider, googleProvider,
  xaiProvider, deepseekProvider, groqProvider, mistralProvider,
];

// ---------------------------------------------------------------- credential store

/** JSON-file CredentialStore (same shape as pi's auth.json). Writes are serialized and atomic; the file is 0600. */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}
  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>; } catch { return {}; }
  }
  private save(data: Record<string, Credential>) {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
  async read(providerId: string) { return this.load()[providerId]; }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.serial(async () => {
      const current = this.load()[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      const data = this.load(); data[providerId] = next; this.save(data);
      return next;
    });
  }
  delete(providerId: string) {
    return this.serial(async () => { const data = this.load(); if (providerId in data) { delete data[providerId]; this.save(data); } });
  }
}

// ---------------------------------------------------------------- custom providers

export const CUSTOM_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];
export interface CustomModelDef { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; vision?: boolean }
export interface CustomProviderCompat { supportsMidConvoSystemMessages?: boolean; sendSessionAffinityHeaders?: boolean }
export interface CustomProviderDef { id: string; name: string; api: CustomApi; baseUrl: string; models: CustomModelDef[]; compat?: CustomProviderCompat }

interface ProvidersFile { custom: CustomProviderDef[]; defaultModel?: ModelRef; deviceId?: string }

const API_IMPL = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi, "anthropic-messages": anthropicMessagesApi };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function customProvider(def: CustomProviderDef, fetchImpl: typeof fetch = fetch): Provider {
  const baseUrl = def.baseUrl.replace(/\/+$/, "");
  const toModel = (m: CustomModelDef): Model<CustomApi> => ({
    id: m.id, name: m.name || m.id, api: def.api, provider: def.id, baseUrl,
    input: m.vision ? ["text", "image"] : ["text"], reasoning: m.reasoning ?? false,
    contextWindow: m.contextWindow ?? 128_000, maxTokens: m.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Mid-conversation system messages keep the leading prompt fixed; affinity headers keep a session on one upstream account.
    ...(def.compat ? { compat: def.compat } : {}),
  } as Model<CustomApi>);
  const models = def.models.map(toModel);
  // Discover models, limits, and image input support. Explicit saved definitions still win.
  const fetchModels = def.api === "anthropic-messages" ? undefined : async ({ credential, signal }: { credential?: { type: string; key?: string }; signal: AbortSignal }) => {
    const live = await detectModels(baseUrl, credential?.type === "api_key" ? credential.key : undefined, fetchImpl, signal);
    return live.map((m) => toModel({ ...m, ...def.models.find((saved) => saved.id === m.id) }));
  };
  return createProvider({
    id: def.id, name: def.name, baseUrl,
    auth: {
      apiKey: {
        name: `${def.name} API key`,
        login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: `Enter ${def.name} API key` }) }),
        // Keyless local servers store the key "none"; the provider is configured once any key is stored.
        resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined),
      },
    },
    models,
    ...(fetchModels ? { fetchModels } : {}),
    api: API_IMPL[def.api](),
  });
}

/** First positive integer >= 1000 among `keys` (dotted paths allowed). */
function limit(m: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = k.split(".").reduce<unknown>((o, p) => (o && typeof o === "object" ? (o as Record<string, unknown>)[p] : undefined), m);
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n >= 1000) return n;
  }
  return undefined;
}
// OpenRouter/ZenMux: context_length; vLLM: max_model_len; Anthropic format: max_input_tokens; others: context_window / max_context_length.
const CONTEXT_KEYS = ["context_length", "context_window", "max_input_tokens", "max_context_length", "max_model_len", "top_provider.context_length", "contextWindow"];
const OUTPUT_KEYS = ["max_completion_tokens", "max_output_tokens", "top_provider.max_completion_tokens", "max_tokens", "maxTokens"];

type ModelEntry = Record<string, unknown>;
async function listModels(baseUrl: string, headers: Record<string, string>, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ModelEntry[]> {
  const r = await fetchImpl(baseUrl.replace(/\/+$/, "") + "/models", {
    headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GET /models: HTTP ${r.status}`);
  const body = await r.json() as { data?: ModelEntry[]; models?: ModelEntry[] };
  return body.data ?? body.models ?? [];
}
const entryId = (m: ModelEntry) => String(m.id ?? m.name ?? "");
// CLIProxyAPI's Anthropic-format list cloaks non-Claude ids as this prefix + the id reversed.
const CLOAK_PREFIX = "claude-fable-5-dd-";

/** Read reported image input support. Missing metadata stays unknown; never infer it from model names or image output. */
function imageInput(m: ModelEntry): boolean | undefined {
  if (typeof m.vision === "boolean") return m.vision;
  if (typeof m.supports_vision === "boolean") return m.supports_vision;
  const architecture = m.architecture as { input_modalities?: unknown } | undefined;
  const capabilities = m.capabilities as { input?: unknown; vision?: unknown } | undefined;
  if (typeof capabilities?.vision === "boolean") return capabilities.vision;
  const modalities = architecture?.input_modalities ?? m.input_modalities ?? capabilities?.input;
  if (Array.isArray(modalities) && modalities.every(v => typeof v === "string")) return modalities.includes("image");
  return undefined;
}

/** Ask an OpenAI-compatible endpoint for its models, reported limits, and image input support. */
export async function detectModels(baseUrl: string, key: string | undefined, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<CustomModelDef[]> {
  const auth: Record<string, string> = key && key !== "none" ? { authorization: `Bearer ${key}` } : {};
  const entries = await listModels(baseUrl, auth, fetchImpl, signal);
  const models: CustomModelDef[] = [];
  const apply = (def: CustomModelDef, m: ModelEntry) => {
    const cw = limit(m, CONTEXT_KEYS), mt = limit(m, OUTPUT_KEYS);
    if (cw !== undefined) def.contextWindow = cw;
    if (mt !== undefined && (cw === undefined || mt <= cw)) def.maxTokens = mt;
    const vision = imageInput(m);
    if (vision !== undefined && def.vision === undefined) def.vision = vision;
  };
  for (const m of entries) {
    const id = entryId(m);
    if (!id) continue;
    const def: CustomModelDef = { id };
    apply(def, m);
    models.push(def);
  }
  if (!models.length) throw new Error("the endpoint listed no models; enter model ids by hand");
  // Proxies such as CLIProxyAPI expose extra metadata in Anthropic format. Ask once more; best effort.
  if (models.some((d) => d.contextWindow === undefined || d.vision === undefined)) {
    const anthropic = await listModels(baseUrl, { ...auth, "anthropic-version": "2023-06-01" }, fetchImpl, signal).catch(() => []);
    const byId = new Map(models.map((d) => [d.id, d]));
    for (const m of anthropic) {
      let id = entryId(m);
      if (!byId.has(id) && id.startsWith(CLOAK_PREFIX)) id = [...id.slice(CLOAK_PREFIX.length)].reverse().join("");
      const def = byId.get(id);
      if (!def) continue;
      if (def.contextWindow === undefined) apply(def, m);
      // Keep primary capability metadata, including explicit false values.
      const vision = imageInput(m);
      if (def.vision === undefined && vision !== undefined) def.vision = vision;
    }
  }
  return models;
}

// ---------------------------------------------------------------- interactive logins

type PromptView = Omit<AuthPrompt, "signal"> & { seq: number };
export interface LoginView {
  id: string; providerId: string; type: AuthType;
  status: "running" | "done" | "error" | "cancelled";
  events: AuthEvent[]; prompt: PromptView | null; error: string | null;
}
interface LoginState extends LoginView {
  abort: AbortController;
  pending?: { seq: number; resolve: (v: string) => void; reject: (e: Error) => void };
  seq: number; updated: number;
}
const LOGIN_TTL_MS = 15 * 60_000;

// ---------------------------------------------------------------- manager

export interface ProviderManagerOptions {
  dataDir: string;
  settings?: SettingsStore;
  /** Use this Models collection (tests) instead of a new one backed by <dataDir>/auth.json. */
  models?: MutableModels;
  /** Model used when no default was saved from the UI (from config). */
  fallbackModel: ModelRef;
  fetch?: typeof fetch;
}

export const MODEL_REFRESH_INTERVAL_MS = 60 * 60_000;
export interface CatalogRefreshStatus {
  checkedAt: number | null;
  refreshing: boolean;
  intervalMs: number;
  errors: Record<string, string>;
}

export class ProviderManager {
  readonly models: MutableModels;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshRunning?: Promise<CatalogRefreshStatus>;
  private refreshAbort?: AbortController;
  private refreshStatus: CatalogRefreshStatus = { checkedAt: null, refreshing: false, intervalMs: MODEL_REFRESH_INTERVAL_MS, errors: {} };
  private settings?: SettingsStore;
  private file: string;
  private state: ProvidersFile;
  private logins = new Map<string, LoginState>();
  private fallback: ModelRef;
  private fetchImpl: typeof fetch;

  constructor(o: ProviderManagerOptions) {
    this.settings = o.settings;
    this.file = join(o.dataDir, "providers.json");
    this.state = this.load();
    this.fallback = o.fallbackModel;
    this.fetchImpl = o.fetch ?? fetch;
    this.models = o.models ?? createModels({ credentials: new FileCredentialStore(join(o.dataDir, "auth.json")) });
    for (const make of BUILTIN_PROVIDERS) { const p = make(this.fetchImpl); if (!this.models.getProvider(p.id)) this.models.setProvider(p); }
    for (const def of this.state.custom) {
      if (this.models.getProvider(def.id)) throw new Error(`provider ${def.id} conflicts with a built-in provider`);
      this.models.setProvider(customProvider(def, this.fetchImpl));
    }
  }

  catalogStatus(): CatalogRefreshStatus { return { ...this.refreshStatus, errors: { ...this.refreshStatus.errors } }; }

  /** Coalesce automatic and manual requests; failed providers retain their catalog. */
  refreshCatalog(force = true): Promise<CatalogRefreshStatus> {
    if (this.refreshRunning) return this.refreshRunning;
    this.refreshStatus.refreshing = true;
    const abort = this.refreshAbort = new AbortController();
    this.refreshRunning = (async () => {
      try {
        const result = await this.models.refresh({ allowNetwork: true, force, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
        this.refreshStatus.errors = Object.fromEntries([...result.errors].map(([id, error]) => [id, error.message]));
        if (result.aborted) this.refreshStatus.errors.catalog = "Model refresh stopped or timed out. Existing models are kept.";
        this.refreshStatus.checkedAt = Date.now();
      } catch (error) {
        this.refreshStatus.errors = { catalog: (error as Error).message };
      } finally {
        this.refreshStatus.refreshing = false;
        this.refreshRunning = undefined;
        this.refreshAbort = undefined;
      }
      return this.catalogStatus();
    })();
    return this.refreshRunning;
  }

  startAutoRefresh(intervalMs = MODEL_REFRESH_INTERVAL_MS) {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshStatus.intervalMs = intervalMs;
    this.refreshTimer = setInterval(() => { void this.refreshCatalog(false); }, intervalMs);
    this.refreshTimer.unref();
  }

  /** Ids of user-defined providers, for refreshing the limits their endpoints report. */
  customIds(): string[] { return this.state.custom.map((c) => c.id); }

  private load(): ProvidersFile {
    if (this.settings) return { custom: this.settings.read().providers };
    if (!existsSync(this.file)) return { custom: [] };
    try { const s = JSON.parse(readFileSync(this.file, "utf8")) as ProvidersFile; return { ...s, custom: s.custom ?? [] }; }
    catch (e) { throw new Error(`${this.file}: ${(e as Error).message}`); }
  }
  private save() {
    if (this.settings) {
      this.settings.update(s => { s.providers = this.state.custom; });
      return;
    }
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ---- default model ----
  defaultModel(): ModelRef {
    if (this.settings) {
      const c = this.settings.resolved();
      return c.model ? { provider: c.provider, modelId: c.model } : this.fallback;
    }
    const d = this.state.defaultModel;
    return d && this.models.getModel(d.provider, d.modelId) ? d : this.fallback;
  }
  setDefaultModel(ref: ModelRef) {
    if (!this.models.getModel(ref.provider, ref.modelId)) throw new Error("unknown model");
    if (this.settings) {
      this.settings.update(s => { s.provider = ref.provider; s.model = ref.modelId; });
      return;
    }
    this.state.defaultModel = { provider: ref.provider, modelId: ref.modelId };
    this.save();
  }

  // ---- status ----
  async list() {
    const custom = new Set(this.state.custom.map((c) => c.id));
    const providers = this.models.getProviders();
    return Promise.all(providers.map(async (p) => {
      let check: { source?: string; type: AuthType } | undefined, error: string | null = null;
      try { check = await this.models.checkAuth(p.id); } catch (e) { error = (e as Error).message; }
      const oauth = p.auth.oauth;
      return {
        id: p.id, name: p.name, custom: custom.has(p.id),
        apiKey: !!p.auth.apiKey,
        oauth: oauth ? { name: oauth.name, label: oauth.loginLabel ?? null, subscription: !!oauth.isSubscription } : null,
        connected: !!check, via: check?.type ?? null, source: check?.source ?? null, error,
        models: p.getModels().length,
        ...(custom.has(p.id) ? { def: this.state.custom.find((c) => c.id === p.id) } : {}),
      };
    }));
  }

  private provider(id: string) {
    const p = this.models.getProvider(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    return p;
  }

  /** Store an API key through the provider's own API-key login, answering its secret prompt with `key`. */
  async setApiKey(providerId: string, key: string) {
    if (providerId === "claude-cli") invalidateClaudeLoginStatus();
    const p = this.provider(providerId);
    if (!p.auth.apiKey?.login) throw new Error(`${p.name} has no API-key login`);
    if (!key.trim()) throw new Error("key is empty");
    await this.models.login(providerId, "api_key", {
      notify: () => {},
      prompt: async (pr) => {
        if (pr.type === "secret" || pr.type === "text") return key.trim();
        throw new Error(`${p.name} needs interactive setup; use its login flow`);
      },
    });
  }

  /** Remove the stored credential (API key or OAuth tokens). Environment variables are not touched. */
  async logout(providerId: string) {
    if (providerId === "claude-cli") invalidateClaudeLoginStatus();
    this.provider(providerId);
    await this.models.logout(providerId);
  }

  // ---- custom providers ----
  async addCustom(input: { id?: unknown; name?: unknown; api?: unknown; baseUrl?: unknown; key?: unknown; models?: unknown }) {
    const id = String(input.id ?? "").trim().toLowerCase();
    if (id === "claude-cli") invalidateClaudeLoginStatus();
    if (!ID_RE.test(id)) throw new Error("id: lowercase letters, digits and -, max 40");
    if (this.models.getProvider(id)) throw new Error(`provider ${id} already exists`);
    const api = String(input.api ?? "openai-completions") as CustomApi;
    if (!CUSTOM_APIS.includes(api)) throw new Error(`api must be one of ${CUSTOM_APIS.join(", ")}`);
    let baseUrl: string;
    try { const u = new URL(String(input.baseUrl ?? "")); if (!/^https?:$/.test(u.protocol)) throw 0; baseUrl = u.toString().replace(/\/+$/, ""); }
    catch { throw new Error("baseUrl must be an http(s) URL"); }
    const key = typeof input.key === "string" && input.key.trim() ? input.key.trim() : "none";
    let models: CustomModelDef[];
    if (Array.isArray(input.models) && input.models.length) {
      models = input.models.map((m) => (typeof m === "string" ? { id: m.trim() } : (m as CustomModelDef))).filter((m) => m.id);
    } else {
      if (api === "anthropic-messages") throw new Error("list the model ids (auto-detect works for OpenAI-compatible endpoints)");
      models = await detectModels(baseUrl, key, this.fetchImpl);
    }
    if (!models.length) throw new Error("at least one model id is required");
    for (const m of models) {
      for (const k of ["contextWindow", "maxTokens"] as const) {
        const v = m[k];
        if (v !== undefined && (!Number.isInteger(v) || v < 1000)) throw new Error(`${m.id}: ${k} must be an integer >= 1000`);
      }
      if (m.contextWindow === undefined) console.warn(`provider ${id}/${m.id}: no contextWindow given, assuming 128000; compaction triggers late if the real window is smaller`);
    }
    const def: CustomProviderDef = { id, name: String(input.name ?? "").trim() || id, api, baseUrl, models };
    this.models.setProvider(customProvider(def, this.fetchImpl));
    await this.setApiKey(id, key);
    this.state.custom.push(def);
    this.save();
    return def;
  }

  /** Bring registered custom providers in line with saved settings. Credentials stay in auth.json. */
  reconcile(next: CustomProviderDef[]) {
    const same = (a: CustomProviderDef, b: CustomProviderDef) => JSON.stringify(a) === JSON.stringify(b);
    for (const old of this.state.custom) {
      if (!next.some((n) => n.id === old.id)) this.models.deleteProvider(old.id);
    }
    for (const def of next) {
      const prev = this.state.custom.find((c) => c.id === def.id);
      if (prev && same(prev, def)) continue;
      if (!prev && this.models.getProvider(def.id)) throw new Error(`provider ${def.id} conflicts with an existing provider`);
      this.models.setProvider(customProvider(def, this.fetchImpl));
    }
    this.state.custom = structuredClone(next);
  }

  async removeCustom(id: string) {
    if (id === "claude-cli") invalidateClaudeLoginStatus();
    const i = this.state.custom.findIndex((c) => c.id === id);
    if (i < 0) throw new Error("not a custom provider");
    if (this.settings && this.settings.read().subagents.provider === id) throw new Error("Provider is selected as the subagent default");
    if (this.settings && this.settings.read().provider === id) throw new Error("Select another main default model before removing this provider");
    this.state.custom.splice(i, 1);
    if (this.state.defaultModel?.provider === id) delete this.state.defaultModel;
    this.save();
    await this.models.logout(id);
    this.models.deleteProvider(id);
  }

  // ---- interactive login (OAuth subscriptions, or a provider's own API-key flow) ----
  startLogin(providerId: string, type: AuthType): LoginView {
    const p = this.provider(providerId);
    if (type === "oauth" ? !p.auth.oauth : !p.auth.apiKey?.login) throw new Error(`${p.name} has no ${type} login`);
    this.gc();
    for (const l of this.logins.values()) if (l.providerId === providerId && l.status === "running") this.cancelLogin(l.id);
    const st: LoginState = { id: randomUUID(), providerId, type, status: "running", events: [], prompt: null, error: null, abort: new AbortController(), seq: 0, updated: Date.now() };
    this.logins.set(st.id, st);
    const touch = () => { st.updated = Date.now(); };
    const interaction = {
      signal: st.abort.signal,
      notify: (e: AuthEvent) => { st.events.push(e); touch(); },
      prompt: (pr: AuthPrompt) => new Promise<string>((resolve, reject) => {
        const seq = ++st.seq;
        const { signal, ...view } = pr;
        st.prompt = { ...view, seq } as PromptView;
        st.pending = { seq, resolve, reject };
        touch();
        // A prompt raced against a callback server is aborted when the callback wins.
        signal?.addEventListener("abort", () => {
          if (st.pending?.seq === seq) { st.pending = undefined; st.prompt = null; }
          reject(signal.reason instanceof Error ? signal.reason : new Error("prompt aborted"));
        }, { once: true });
      }),
    };
    this.models.login(providerId, type, interaction, { getDeviceId: () => this.deviceId(), agentName: "Luna" })
      .then(() => {
        st.status = "done";
        if (providerId === "claude-cli") invalidateClaudeLoginStatus();
      })
      .catch((e: Error) => { if (st.status === "running") { st.status = "error"; st.error = e?.message ?? String(e); } })
      .finally(() => { st.prompt = null; st.pending = undefined; touch(); });
    return this.view(st);
  }

  getLogin(id: string): LoginView | undefined { const l = this.logins.get(id); return l && this.view(l); }

  answerLogin(id: string, seq: number, value: string) {
    const l = this.logins.get(id);
    if (!l || l.status !== "running") throw new Error("no running login");
    if (!l.pending || l.pending.seq !== seq) throw new Error("that prompt is no longer open");
    const p = l.pending; l.pending = undefined; l.prompt = null; l.updated = Date.now();
    p.resolve(value);
  }

  cancelLogin(id: string) {
    const l = this.logins.get(id);
    if (!l || l.status !== "running") return;
    l.status = "cancelled";
    l.pending?.reject(new Error("cancelled"));
    l.abort.abort(new Error("cancelled"));
  }

  private view(l: LoginState): LoginView {
    return { id: l.id, providerId: l.providerId, type: l.type, status: l.status, events: l.events, prompt: l.prompt, error: l.error };
  }
  private gc() {
    const now = Date.now();
    for (const [id, l] of this.logins) if (now - l.updated > LOGIN_TTL_MS) { this.cancelLogin(id); this.logins.delete(id); }
  }
  private deviceId() {
    if (this.settings) {
      const file = this.file.replace("providers.json", "oauth-device-id");
      if (existsSync(file)) return readFileSync(file, "utf8").trim();
      const id = randomUUID(); writeFileSync(file, id, { mode: 0o600 }); return id;
    }
    if (!this.state.deviceId) { this.state.deviceId = randomUUID(); this.save(); }
    return this.state.deviceId;
  }

  close() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshAbort?.abort();
    for (const id of this.logins.keys()) this.cancelLogin(id);
  }
}
