// Model providers: built-in pi-ai providers (API key and subscription OAuth logins), user-added custom
// OpenAI/Anthropic-compatible endpoints, a persistent credential store, and the default model.
// Files under dataDir: auth.json (credentials, mode 0600), providers.json (custom providers, default model, device id).
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
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ModelRef } from "./scheduler.js";

/** Built-in providers offered in the UI. Each brings its own catalog, API-key auth and (where supported) OAuth login. */
export const BUILTIN_PROVIDERS: (() => Provider)[] = [
  anthropicProvider, openaiProvider, githubCopilotProvider, openrouterProvider, googleProvider,
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
export interface CustomProviderDef { id: string; name: string; api: CustomApi; baseUrl: string; models: CustomModelDef[] }

interface ProvidersFile { custom: CustomProviderDef[]; defaultModel?: ModelRef; deviceId?: string }

const API_IMPL = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi, "anthropic-messages": anthropicMessagesApi };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function customProvider(def: CustomProviderDef): Provider {
  const baseUrl = def.baseUrl.replace(/\/+$/, "");
  const models: Model<CustomApi>[] = def.models.map((m) => ({
    id: m.id, name: m.name || m.id, api: def.api, provider: def.id, baseUrl,
    input: m.vision ? ["text", "image"] : ["text"], reasoning: m.reasoning ?? false,
    contextWindow: m.contextWindow ?? 128_000, maxTokens: m.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
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
    api: API_IMPL[def.api](),
  });
}

/** Ask an OpenAI-compatible endpoint for its model ids (GET <baseUrl>/models). */
export async function detectModels(baseUrl: string, key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const r = await fetchImpl(baseUrl.replace(/\/+$/, "") + "/models", {
    headers: key && key !== "none" ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GET /models: HTTP ${r.status}`);
  const body = await r.json() as { data?: { id?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
  const ids = (body.data ?? body.models ?? []).map((m) => String((m as { id?: unknown }).id ?? (m as { name?: unknown }).name ?? "")).filter(Boolean);
  if (!ids.length) throw new Error("the endpoint listed no models; enter model ids by hand");
  return ids;
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
  /** Use this Models collection (tests) instead of a new one backed by <dataDir>/auth.json. */
  models?: MutableModels;
  /** Model used when no default was saved from the UI (from config). */
  fallbackModel: ModelRef;
  fetch?: typeof fetch;
}

export class ProviderManager {
  readonly models: MutableModels;
  private file: string;
  private state: ProvidersFile;
  private logins = new Map<string, LoginState>();
  private fallback: ModelRef;
  private fetchImpl: typeof fetch;

  constructor(o: ProviderManagerOptions) {
    this.file = join(o.dataDir, "providers.json");
    this.state = this.load();
    this.fallback = o.fallbackModel;
    this.fetchImpl = o.fetch ?? fetch;
    this.models = o.models ?? createModels({ credentials: new FileCredentialStore(join(o.dataDir, "auth.json")) });
    for (const make of BUILTIN_PROVIDERS) { const p = make(); if (!this.models.getProvider(p.id)) this.models.setProvider(p); }
    for (const def of this.state.custom) this.models.setProvider(customProvider(def));
  }

  private load(): ProvidersFile {
    if (!existsSync(this.file)) return { custom: [] };
    try { const s = JSON.parse(readFileSync(this.file, "utf8")) as ProvidersFile; return { ...s, custom: s.custom ?? [] }; }
    catch (e) { throw new Error(`${this.file}: ${(e as Error).message}`); }
  }
  private save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // ---- default model ----
  defaultModel(): ModelRef {
    const d = this.state.defaultModel;
    return d && this.models.getModel(d.provider, d.modelId) ? d : this.fallback;
  }
  setDefaultModel(ref: ModelRef) {
    if (!this.models.getModel(ref.provider, ref.modelId)) throw new Error("unknown model");
    this.state.defaultModel = { provider: ref.provider, modelId: ref.modelId };
    this.save();
  }

  // ---- status ----
  async list() {
    const custom = new Set(this.state.custom.map((c) => c.id));
    const out = [];
    for (const p of this.models.getProviders()) {
      let check: { source?: string; type: AuthType } | undefined, error: string | null = null;
      try { check = await this.models.checkAuth(p.id); } catch (e) { error = (e as Error).message; }
      const oauth = p.auth.oauth;
      out.push({
        id: p.id, name: p.name, custom: custom.has(p.id),
        apiKey: !!p.auth.apiKey,
        oauth: oauth ? { name: oauth.name, label: oauth.loginLabel ?? null, subscription: !!oauth.isSubscription } : null,
        connected: !!check, via: check?.type ?? null, source: check?.source ?? null, error,
        models: p.getModels().length,
        ...(custom.has(p.id) ? { def: this.state.custom.find((c) => c.id === p.id) } : {}),
      });
    }
    return out;
  }

  private provider(id: string) {
    const p = this.models.getProvider(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    return p;
  }

  /** Store an API key through the provider's own API-key login, answering its secret prompt with `key`. */
  async setApiKey(providerId: string, key: string) {
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
    this.provider(providerId);
    await this.models.logout(providerId);
  }

  // ---- custom providers ----
  async addCustom(input: { id?: unknown; name?: unknown; api?: unknown; baseUrl?: unknown; key?: unknown; models?: unknown }) {
    const id = String(input.id ?? "").trim().toLowerCase();
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
      models = (await detectModels(baseUrl, key, this.fetchImpl)).map((mid) => ({ id: mid }));
    }
    if (!models.length) throw new Error("at least one model id is required");
    const def: CustomProviderDef = { id, name: String(input.name ?? "").trim() || id, api, baseUrl, models };
    this.models.setProvider(customProvider(def));
    await this.setApiKey(id, key);
    this.state.custom.push(def);
    this.save();
    return def;
  }

  async removeCustom(id: string) {
    const i = this.state.custom.findIndex((c) => c.id === id);
    if (i < 0) throw new Error("not a custom provider");
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
      .then(() => { st.status = "done"; })
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
    if (!this.state.deviceId) { this.state.deviceId = randomUUID(); this.save(); }
    return this.state.deviceId;
  }

  close() { for (const id of this.logins.keys()) this.cancelLogin(id); }
}
