// Reasoning-level rules shared by the picker and the stores. The clamp matches the server (pi-ai clampThinkingLevel).
import type { ModelInfo } from "./types";

export interface ModelRef { provider: string; modelId: string }
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ThinkingLevel = (typeof LEVELS)[number];
/** Matches the server default when neither the model nor the settings name a level. */
export const FALLBACK_LEVEL = "medium";

export interface SiblingMatch {
  base: string;
  level: ThinkingLevel;
}

export interface SiblingGroup {
  provider: string;
  base: string;
  levels: ThinkingLevel[];
  byLevel: Partial<Record<ThinkingLevel, ModelInfo>>;
}

export function findModel(list: readonly ModelInfo[], ref: ModelRef | null | undefined): ModelInfo | undefined {
  return ref ? list.find(m => m.provider === ref.provider && m.id === ref.modelId) : undefined;
}

/** Splits a trailing `-<level>` suffix from a model ID when `<level>` is a recognized thinking level. */
export function parseSiblingSuffix(id: string): SiblingMatch | null {
  const dash = id.lastIndexOf("-");
  if (dash <= 0) return null;
  const suffix = id.slice(dash + 1);
  if (!(LEVELS as readonly string[]).includes(suffix)) return null;
  return { base: id.slice(0, dash), level: suffix as ThinkingLevel };
}

function isSiblingCandidate(model: ModelInfo): boolean {
  return !Array.isArray(model.thinkingLevels) || !model.thinkingLevels.some(level => level !== "off");
}

/**
 * Groups non-reasoning models within the same provider whose IDs share a prefix and differ only by
 * a `-<level>` suffix. Requires at least 2 distinct sibling levels so standalone models (e.g.
 * `gpt-oss-120b-medium`) stay untouched. Returned map is keyed by `"provider/id"`.
 */
export function buildSiblingIndex(list: readonly ModelInfo[]): Map<string, SiblingGroup> {
  const buckets = new Map<string, { provider: string; base: string; byLevel: Partial<Record<ThinkingLevel, ModelInfo>> }>();
  for (const model of list) {
    if (!isSiblingCandidate(model)) continue;
    const parsed = parseSiblingSuffix(model.id);
    if (!parsed) continue;
    const bucketKey = `${model.provider}\0${parsed.base}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { provider: model.provider, base: parsed.base, byLevel: {} };
      buckets.set(bucketKey, bucket);
    }
    if (!bucket.byLevel[parsed.level]) bucket.byLevel[parsed.level] = model;
  }

  const index = new Map<string, SiblingGroup>();
  for (const bucket of buckets.values()) {
    const levels = LEVELS.filter(level => level in bucket.byLevel);
    if (levels.length < 2) continue;
    const group: SiblingGroup = {
      provider: bucket.provider,
      base: bucket.base,
      levels,
      byLevel: bucket.byLevel,
    };
    for (const level of levels) {
      const member = bucket.byLevel[level]!;
      index.set(`${member.provider}/${member.id}`, group);
    }
  }
  return index;
}

export function findSiblingGroup(index: ReadonlyMap<string, SiblingGroup>, ref: ModelRef | null | undefined): SiblingGroup | undefined {
  return ref ? index.get(`${ref.provider}/${ref.modelId}`) : undefined;
}

export function siblingLevelOf(index: ReadonlyMap<string, SiblingGroup>, ref: ModelRef | null | undefined): ThinkingLevel | undefined {
  if (!ref) return undefined;
  const group = findSiblingGroup(index, ref);
  if (!group) return undefined;
  const parsed = parseSiblingSuffix(ref.modelId);
  return parsed && group.byLevel[parsed.level] ? parsed.level : undefined;
}

export function siblingTarget(index: ReadonlyMap<string, SiblingGroup>, ref: ModelRef | null | undefined, level: string): ModelInfo | undefined {
  const group = findSiblingGroup(index, ref);
  if (!group) return undefined;
  return (LEVELS as readonly string[]).includes(level) ? group.byLevel[level as ThinkingLevel] : undefined;
}

/** Label for the composer model button: hides the provider and shows only the model name. */
export function modelDisplayName(model: ModelInfo | undefined, ref: ModelRef | null | undefined): string {
  if (model) return model.name || model.id;
  return ref?.modelId || "Choose model";
}

/** Levels the model accepts, in LEVELS order. An unknown model shows every standard level; the server clamps. Ultra needs a model that lists it. */
export function levelsOf(model: ModelInfo | undefined, siblingGroup?: SiblingGroup): string[] {
  if (siblingGroup) return [...siblingGroup.levels];
  const supported = model?.thinkingLevels;
  if (!Array.isArray(supported) || supported.length === 0) return LEVELS.filter(level => level !== "ultra");
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

/** The level a new session on this model starts at: the sibling suffix, else the model default, else the global default, clamped. */
export function startLevel(model: ModelInfo | undefined, globalDefault: string, siblingGroup?: SiblingGroup, ref?: ModelRef | null): string {
  if (siblingGroup) {
    const id = model?.id ?? ref?.modelId;
    const parsed = id ? parseSiblingSuffix(id) : null;
    if (parsed && siblingGroup.byLevel[parsed.level]) return parsed.level;
  }
  return clampTo(levelsOf(model, siblingGroup), model?.defaultThinkingLevel ?? globalDefault);
}
