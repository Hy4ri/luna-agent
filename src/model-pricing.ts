// Catalog price estimate for models without their own price (custom endpoints, OpenCode).
// A model ID is matched by name to a priced built-in pi-ai model, or (as a fallback) the live
// OpenRouter catalog. The result is an estimate, never a bill.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

export type ModelCost = Model<string>["cost"];

/** First-party catalogs first, so their prices win over a reseller's for the same name. */
const CATALOGS = [anthropicProvider, openaiProvider, googleProvider, xaiProvider, deepseekProvider, mistralProvider, groqProvider, openrouterProvider];

/** Proxy suffixes that select a thinking mode or effort, not a different model. */
const MODE_SUFFIX = /-(?:thinking|reasoning|minimal|low|medium|high|xhigh|max)$/u;

/** "anthropic/claude-opus-4.6-thinking" -> "claude-opus-4-6". */
export function priceKey(id: string): string {
  let key = id.toLowerCase().replace(/\[1m\]$/u, "");
  key = key.slice(key.lastIndexOf("/") + 1).replace(/[._:]/gu, "-");
  while (MODE_SUFFIX.test(key)) key = key.replace(MODE_SUFFIX, "");
  return key;
}

const isFree = (id: string) => /(?:^|[-:/])free$/iu.test(id);
const priced = (cost: ModelCost) => cost.input > 0 || cost.output > 0;

let index: { exact: Map<string, ModelCost>; byKey: Map<string, ModelCost> } | undefined;
function catalogIndex() {
  if (index) return index;
  const exact = new Map<string, ModelCost>(), byKey = new Map<string, ModelCost>();
  for (const make of CATALOGS) {
    for (const model of make().getModels()) {
      if (!priced(model.cost) || isFree(model.id)) continue;
      const id = model.id.toLowerCase(), key = priceKey(model.id);
      if (!exact.has(id)) exact.set(id, model.cost);
      if (!byKey.has(key)) byKey.set(key, model.cost);
    }
  }
  return index = { exact, byKey };
}

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_CACHE_TTL_MS = 24 * 60 * 60_000;

interface LivePricingIndex {
  exact: Map<string, ModelCost>;
  byKey: Map<string, ModelCost>;
  fetchedAt: number;
}
let liveIndex: LivePricingIndex | undefined;

const perMillion = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Number((n * 1_000_000).toPrecision(12));
};

function indexPrices(entries: Iterable<[string, ModelCost]>): { exact: Map<string, ModelCost>; byKey: Map<string, ModelCost> } {
  const exact = new Map<string, ModelCost>(), byKey = new Map<string, ModelCost>();
  for (const [rawId, cost] of entries) {
    if (!priced(cost) || isFree(rawId)) continue;
    const id = rawId.toLowerCase(), key = priceKey(rawId);
    if (!exact.has(id)) exact.set(id, cost);
    if (!byKey.has(key)) byKey.set(key, cost);
  }
  return { exact, byKey };
}

export function parseOpenRouterModels(payload: unknown): { exact: Map<string, ModelCost>; byKey: Map<string, ModelCost> } {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return { exact: new Map(), byKey: new Map() };
  const entries: Array<[string, ModelCost]> = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { id, pricing } = item as { id?: unknown; pricing?: unknown };
    if (typeof id !== "string" || !id || isFree(id) || !pricing || typeof pricing !== "object") continue;
    const p = pricing as Record<string, unknown>;
    const input = perMillion(p.prompt), output = perMillion(p.completion);
    if (input === undefined || output === undefined) continue;
    const cost: ModelCost = {
      input,
      output,
      cacheRead: perMillion(p.input_cache_read) ?? 0,
      cacheWrite: perMillion(p.input_cache_write) ?? 0,
    };
    if (!priced(cost)) continue;
    entries.push([id, cost]);
  }
  return indexPrices(entries);
}

/** Load cached OpenRouter pricing from disk. Returns true if the cache is still within `maxAgeMs`. */
export function loadOpenRouterPricingCache(cacheFile: string, maxAgeMs = OPENROUTER_CACHE_TTL_MS): boolean {
  if (!existsSync(cacheFile)) return false;
  try {
    const raw = JSON.parse(readFileSync(cacheFile, "utf8")) as { fetchedAt?: unknown; prices?: unknown };
    if (typeof raw.fetchedAt !== "number" || !raw.prices || typeof raw.prices !== "object") return false;
    const parsed = indexPrices(Object.entries(raw.prices as Record<string, ModelCost>));
    if (parsed.exact.size === 0) return false;
    liveIndex = { ...parsed, fetchedAt: raw.fetchedAt };
    return Date.now() - raw.fetchedAt < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Fetch OpenRouter's live model catalog to price models missing from the bundled pi-ai catalogs.
 * Returns true if in-memory pricing was populated or updated. Best-effort: never throws.
 */
export async function refreshOpenRouterPricing(opts?: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  cacheFile?: string;
  maxAgeMs?: number;
  force?: boolean;
}): Promise<boolean> {
  const maxAgeMs = opts?.maxAgeMs ?? OPENROUTER_CACHE_TTL_MS;
  if (!opts?.force) {
    if (liveIndex && Date.now() - liveIndex.fetchedAt < maxAgeMs) return false;
    if (opts?.cacheFile && loadOpenRouterPricingCache(opts.cacheFile, maxAgeMs)) return true;
  }
  try {
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    const res = await (opts?.fetchImpl ?? fetch)(OPENROUTER_MODELS_URL, { signal });
    if (!res.ok) return false;
    const parsed = parseOpenRouterModels(await res.json());
    if (parsed.exact.size === 0) return false;
    const fetchedAt = Date.now();
    liveIndex = { ...parsed, fetchedAt };
    if (opts?.cacheFile) {
      try {
        const tmp = opts.cacheFile + ".tmp";
        writeFileSync(tmp, JSON.stringify({ fetchedAt, prices: Object.fromEntries(parsed.exact) }));
        renameSync(tmp, opts.cacheFile);
      } catch { /* cache write is best-effort */ }
    }
    return true;
  } catch {
    return false;
  }
}

export function clearOpenRouterPricingForTest() { liveIndex = undefined; }

/**
 * Per-million-token rates of the priced built-in model with the same name, or undefined.
 * Free-tier IDs never match: a free route has no cost to estimate.
 */
export function estimatedCost(id: string): ModelCost | undefined {
  if (isFree(id)) return undefined;
  const { exact, byKey } = catalogIndex();
  const cost = exact.get(id.toLowerCase()) ?? byKey.get(priceKey(id))
    ?? liveIndex?.exact.get(id.toLowerCase()) ?? liveIndex?.byKey.get(priceKey(id));
  return cost ? structuredClone(cost) : undefined;
}

/** Catalog estimate for a model without its own price, otherwise zero. */
export function costFor(id: string): ModelCost {
  return estimatedCost(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
