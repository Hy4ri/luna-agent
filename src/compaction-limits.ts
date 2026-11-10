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

export function catalogModels(models: Models) {
  const result: Array<{ provider: string; id: string; contextWindow?: number }> = [];
  for (const provider of models.getProviders()) {
    for (const model of provider.getModels()) result.push(model);
  }
  return result;
}
