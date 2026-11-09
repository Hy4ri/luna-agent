// One rule for the thinking level a session stores: the level the model will actually run.
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "./session-create.js";

/** Used when neither the request, the model override, nor the global setting gives a level. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export interface ThinkingDefaults {
  /** Global default (config `thinkingLevel`). */
  thinkingLevel?: ThinkingLevel;
  /** Per-model defaults keyed `provider/modelId` (config `modelThinkingLevels`). */
  modelThinkingLevels?: Record<string, ThinkingLevel>;
}

const refKey = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

/** Levels the model accepts. Unknown models accept every level; the provider clamps at request time. */
export function supportedThinkingLevels(model: Model<Api> | undefined): ThinkingLevel[] | undefined {
  return model ? getSupportedThinkingLevels(model) as ThinkingLevel[] : undefined;
}

/**
 * Resolve and clamp a level for `ref`. Order: explicit request, the model's override,
 * `fallback` (the level kept across a model switch), the global default, then medium.
 */
export function resolveThinkingLevel(
  models: Pick<Models, "getModel"> | undefined,
  ref: ModelRef | null | undefined,
  defaults: ThinkingDefaults | undefined,
  requested?: ThinkingLevel,
  fallback?: ThinkingLevel,
): ThinkingLevel {
  const level = requested ?? (ref ? defaults?.modelThinkingLevels?.[refKey(ref)] : undefined)
    ?? fallback ?? defaults?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const model = ref ? models?.getModel(ref.provider as never, ref.modelId as never) : undefined;
  return model ? clampThinkingLevel(model, level) as ThinkingLevel : level;
}
