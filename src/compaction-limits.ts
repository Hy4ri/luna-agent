import type { Models } from "@earendil-works/pi-ai";
import type { CompactionPolicy, CompactionSettings } from "@earendil-works/pi-durable";

// Stock pi-durable defaults (dist/harness/agent.js:12-14).
export const STOCK_RESERVE = 16384;
export const STOCK_BACKGROUND = 32768;

export const STOCK_POLICY: CompactionPolicy = {
  enabled: true,
  reserveTokens: STOCK_RESERVE,
  keepRecentTokens: 20000,
  backgroundTokens: STOCK_BACKGROUND,
};

export type CompactionLimits = {
  backgroundAtTokens: number;
  blockAtTokens: number;
  keepRecentTokens: number;
};

export function nativeCompaction(
  limits: CompactionLimits,
  models: Iterable<{ provider: string; id: string; contextWindow?: number }>,
): Pick<CompactionSettings, "modelOverrides"> & { keepRecentTokens: number } {
  const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};
  for (const model of models) {
    const window = model.contextWindow;
    if (window === undefined || window <= 0) continue;
    const safety = window - STOCK_RESERVE;
    const blocking = Math.max(0, Math.min(safety, limits.blockAtTokens));
    const background = Math.max(0, Math.min(safety - STOCK_BACKGROUND, limits.backgroundAtTokens, blocking));
    modelOverrides[`${model.provider}/${model.id}`] = {
      reserveTokens: window - blocking,
      backgroundTokens: blocking - background,
      keepRecentTokens: limits.keepRecentTokens,
    };
  }
  return { keepRecentTokens: limits.keepRecentTokens, modelOverrides };
}

/**
 * Memoized `nativeCompaction` over the whole catalog. The harness reads `settings.compaction` on every task schedule;
 * rebuilding a per-model table there costs ~10 ms and ~1 MB at 10k models. The table is rebuilt only when the limits
 * change or a provider publishes a new model array (pi-ai keeps a provider's array stable between refreshes).
 */
export function catalogCompaction(models: Models) {
  let limitsKey: string | undefined;
  let lists: readonly unknown[] = [];
  let value: ReturnType<typeof nativeCompaction> | undefined;
  return (limits: CompactionLimits) => {
    const current = models.getProviders().map(provider => provider.getModels());
    const key = `${limits.backgroundAtTokens}/${limits.blockAtTokens}/${limits.keepRecentTokens}`;
    if (value && key === limitsKey && current.length === lists.length && current.every((list, i) => list === lists[i])) return value;
    const all: Array<{ provider: string; id: string; contextWindow?: number }> = [];
    for (const list of current) all.push(...list);
    limitsKey = key;
    lists = current;
    value = nativeCompaction(limits, all);
    return value;
  };
}
