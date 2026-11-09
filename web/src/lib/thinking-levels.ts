// Reasoning-level rules shared by the picker and the stores. The clamp matches the server (pi-ai clampThinkingLevel).
import type { ModelInfo } from "./types";

export interface ModelRef { provider: string; modelId: string }
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Matches the server default when neither the model nor the settings name a level. */
export const FALLBACK_LEVEL = "medium";

export function findModel(list: readonly ModelInfo[], ref: ModelRef | null | undefined): ModelInfo | undefined {
  return ref ? list.find(m => m.provider === ref.provider && m.id === ref.modelId) : undefined;
}

/** Levels the model accepts, in LEVELS order. An unknown model shows every level; the server clamps. */
export function levelsOf(model: ModelInfo | undefined): string[] {
  const supported = model?.thinkingLevels;
  if (!Array.isArray(supported) || supported.length === 0) return [...LEVELS];
  return LEVELS.filter(level => supported.includes(level));
}

/** The nearest supported level above the request, else the nearest below. */
export function clampTo(levels: readonly string[], level: string): string {
  if (levels.includes(level)) return level;
  const at = LEVELS.indexOf(level as (typeof LEVELS)[number]);
  if (at >= 0) {
    for (let i = at; i < LEVELS.length; i++) if (levels.includes(LEVELS[i]!)) return LEVELS[i]!;
    for (let i = at - 1; i >= 0; i--) if (levels.includes(LEVELS[i]!)) return LEVELS[i]!;
  }
  return levels[0] ?? "off";
}

/** The level a new session on this model starts at: the model default, else the global default, clamped. */
export function startLevel(model: ModelInfo | undefined, globalDefault: string): string {
  return clampTo(levelsOf(model), model?.defaultThinkingLevel ?? globalDefault);
}
