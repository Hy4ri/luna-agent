// Catalog price estimate for models without their own price (custom endpoints, OpenCode).
// A model ID is matched by name to a priced built-in pi-ai model. The result is an estimate, never a bill.
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

/**
 * Per-million-token rates of the priced built-in model with the same name, or undefined.
 * Free-tier IDs never match: a free route has no cost to estimate.
 */
export function estimatedCost(id: string): ModelCost | undefined {
  if (isFree(id)) return undefined;
  const { exact, byKey } = catalogIndex();
  const cost = exact.get(id.toLowerCase()) ?? byKey.get(priceKey(id));
  return cost ? structuredClone(cost) : undefined;
}

/** Catalog estimate for a model without its own price, otherwise zero. */
export function costFor(id: string): ModelCost {
  return estimatedCost(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
