import { createProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider as baseOpenaiProvider } from "@earendil-works/pi-ai/providers/openai";

// This suffix identifies a local selection, never an upstream API model.
const LONG_CONTEXT_SUFFIX = "-long-context";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function contextLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1000 ? value : undefined;
}

function capacityLabel(tokens: number): string {
  return tokens % 1000 === 0 ? `${tokens / 1000}K` : String(tokens);
}

/**
 * Ultra support from the catalog's `supported_reasoning_levels`: the request effort is
 * `multi_agent_reasoning_effort` when set, else max (Codex rule). An entry without the list keeps the model.
 */
export function withUltra<T extends Model<Api>>(model: T, entry: Record<string, unknown>): T {
  const levels = entry.supported_reasoning_levels;
  if (!Array.isArray(levels) || !model.reasoning) return model;
  const ultra = levels.some(level => record(level)?.effort === "ultra");
  const delegated = entry.multi_agent_reasoning_effort;
  const effort = !ultra ? null : typeof delegated === "string" && delegated !== "ultra" ? delegated : "max";
  return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, ultra: effort } as T["thinkingLevelMap"] };
}

/** Add context variants from OpenAI's authenticated catalog, keeping built-in capabilities and auth. */
export function openaiProvider(fetchImpl: typeof fetch = fetch): ReturnType<typeof baseOpenaiProvider> {
  const provider = baseOpenaiProvider();
  const baseline = provider.getModels();
  // Use pi-ai's refresh publication and catalog cache. A failed refresh retains the last good catalog.
  const catalog = createProvider({
    id: provider.id,
    auth: provider.auth,
    models: provider.getAllModels?.() ?? baseline,
    api: openAIResponsesApi(),
    fetchModels: async ({ credential, signal, baseUrl }) => {
      const key = credential?.type === "oauth" ? credential.access : credential?.key;
      if (!key) throw new Error("OpenAI catalog requires authentication");
      const response = await fetchImpl(`${(baseUrl ?? provider.baseUrl!).replace(/\/+$/, "")}/models`, {
        headers: { accept: "application/json", authorization: `Bearer ${key}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenAI catalog HTTP ${response.status}`);
      }
      const body = record(await response.json());
      // ChatGPT subscription catalogs use models/slug; API-key catalogs use data/id.
      const rows: unknown = body?.models ?? body?.data;
      if (!Array.isArray(rows)) throw new Error("Invalid OpenAI model catalog");
      const metadata = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const entry = record(row);
        const id = entry?.slug ?? entry?.id;
        if (entry && typeof id === "string") metadata.set(id, entry);
      }
      const variants: Model<"openai-responses">[] = [];
      const normal = baseline.map(model => {
        const entry = metadata.get(model.id);
        if (!entry || entry.visibility === "hide" || entry.supported_in_api === false) return model;
        const contextWindow = contextLimit(entry.context_window);
        const maximum = contextLimit(entry.max_context_window);
        const updated = withUltra(contextWindow === undefined ? model : { ...model, contextWindow }, entry);
        // Never infer a larger limit from a model name, another model, or a missing field.
        // Keep native IDs that happen to use our suffix distinct from local variants.
        if (contextWindow !== undefined && maximum !== undefined && maximum > contextWindow
          && !baseline.some(other => other.id === model.id + LONG_CONTEXT_SUFFIX)) {
          variants.push({ ...updated, id: model.id + LONG_CONTEXT_SUFFIX,
            name: `${model.name} (${capacityLabel(maximum)})`, contextWindow: maximum });
        }
        return updated;
      });
      // Preserve non-chat models and their separate implementations on the original provider.
      return [...normal, ...variants];
    },
  });
  function upstreamModel<T extends Model<Api>>(model: T): T {
    if (!model.id.endsWith(LONG_CONTEXT_SUFFIX) || baseline.some(original => original.id === model.id)) return model;
    const id = model.id.slice(0, -LONG_CONTEXT_SUFFIX.length);
    return baseline.some(original => original.id === id) ? { ...model, id } : model;
  }
  return {
    ...provider,
    getModels: catalog.getModels,
    getAllModels: catalog.getAllModels,
    refreshModels: catalog.refreshModels,
    // Rewrite before message conversion too, so reasoning replay uses the upstream identity.
    stream: (model, context, options) => provider.stream(upstreamModel(model), context, options),
    streamSimple: (model, context, options) => provider.streamSimple(upstreamModel(model), context, options),
  };
}
