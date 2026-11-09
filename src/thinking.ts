// One rule for the thinking level a session stores: the level the model will actually run.
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type Models, type MutableModels } from "@earendil-works/pi-ai";
import type { AgentChange, ModelRef } from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "./session-create.js";

/** Used when neither the request, the model override, nor the global setting gives a level. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export interface ThinkingDefaults {
  /** Global default (config `thinkingLevel`). */
  thinkingLevel?: ThinkingLevel;
  /** Per-model defaults keyed `provider/modelId` (config `modelThinkingLevels`). */
  modelThinkingLevels?: Record<string, ThinkingLevel>;
}

type ApiLevel = Exclude<ThinkingLevel, "ultra">;

/**
 * pi-durable stores the level as an opaque string and passes it to the provider as `reasoning`.
 * Its type omits Luna's "ultra"; withUltraModels translates ultra before any provider sees it.
 */
export type StoredThinkingLevel = NonNullable<AgentChange["thinkingLevel"]>;
export const stored = <T extends ThinkingLevel | undefined>(level: T) => level as T extends undefined ? StoredThinkingLevel | undefined : StoredThinkingLevel;

/**
 * Ultra is a harness level (Codex): the request runs at a model-chosen effort, and the prompt turns on
 * proactive delegation. A model supports it when `thinkingLevelMap.ultra` names the effort to send.
 * Built-in OpenAI catalogs do not carry it, so these defaults come from the Codex model catalog
 * (`multi_agent_reasoning_effort`, else max). The live OpenAI catalog overrides them.
 */
const OPENAI_ULTRA: Record<string, ApiLevel> = {
  "gpt-5.6-sol": "max", "gpt-5.6-terra": "max", "gpt-6-sol": "max", "gpt-6-astra": "xhigh",
  "gpt-6.1-sol": "xhigh", "gpt-6.1-terra": "xhigh", "gpt-daybreak-blue-latest": "max", "gpt-daybreak-red-latest": "max",
};
const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const LONG_CONTEXT_SUFFIX = "-long-context";

/** The effort an ultra request sends, or undefined when the model has no ultra level. */
export function ultraEffort(model: Model<Api> | undefined): ApiLevel | undefined {
  if (!model?.reasoning) return undefined;
  const mapped = (model.thinkingLevelMap as Record<string, string | null | undefined> | undefined)?.ultra;
  let level: string | null | undefined = mapped;
  if (level === undefined && OPENAI_PROVIDERS.has(model.provider)) {
    const id = model.id.endsWith(LONG_CONTEXT_SUFFIX) ? model.id.slice(0, -LONG_CONTEXT_SUFFIX.length) : model.id;
    level = OPENAI_ULTRA[id];
  }
  if (typeof level !== "string") return undefined;
  // Send a level the model accepts; an unknown or unsupported name falls back to the highest one.
  const levels = getSupportedThinkingLevels(model) as ApiLevel[];
  if (levels.includes(level as ApiLevel) && level !== "off") return level as ApiLevel;
  return clampThinkingLevel(model, "max") as ApiLevel;
}

const refKey = (ref: ModelRef) => `${ref.provider}/${ref.modelId}`;

/** Levels the model accepts. Unknown models accept every level; the provider clamps at request time. */
export function supportedThinkingLevels(model: Model<Api> | undefined): ThinkingLevel[] | undefined {
  if (!model) return undefined;
  const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
  return ultraEffort(model) ? [...levels, "ultra"] : levels;
}

/** Clamp `level` to `model`. Ultra stays ultra where supported, else it clamps like max. */
export function clampLevel(model: Model<Api>, level: ThinkingLevel): ThinkingLevel {
  if (level === "ultra") return ultraEffort(model) ? "ultra" : clampThinkingLevel(model, "max") as ThinkingLevel;
  return clampThinkingLevel(model, level) as ThinkingLevel;
}

/** The level providers receive: ultra becomes its effort. Other levels pass through. */
export function requestLevel(model: Model<Api>, level: string | undefined): string | undefined {
  return level === "ultra" ? ultraEffort(model) ?? clampThinkingLevel(model, "max") : level;
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
): StoredThinkingLevel {
  const level = requested ?? (ref ? defaults?.modelThinkingLevels?.[refKey(ref)] : undefined)
    ?? fallback ?? defaults?.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const model = ref ? models?.getModel(ref.provider as never, ref.modelId as never) : undefined;
  return stored(model ? clampLevel(model, level) : level);
}

type ReasoningOptions = { reasoning?: string } | undefined;
const translate = <O extends ReasoningOptions>(model: Model<Api>, options: O): O =>
  options?.reasoning === "ultra" ? { ...options, reasoning: requestLevel(model, "ultra") } as O : options;

/** Translate ultra to its request effort before any provider sees it. Providers never get "ultra". */
export function withUltraModels(models: MutableModels): MutableModels {
  return new Proxy(models, {
    get(target, prop, receiver) {
      if (prop === "streamSimple" || prop === "completeSimple") {
        const fn = (target[prop] as (...a: unknown[]) => unknown).bind(target);
        return (model: Model<Api>, context: unknown, options?: ReasoningOptions) => fn(model, context, translate(model, options));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Codex's proactive multi-agent text, adapted to Luna's delegation tools. */
export const ULTRA_SECTION = "Ultra reasoning is active: proactive multi-agent delegation is on. " +
  "Any earlier instruction requiring an explicit user request before you spawn sub-agents no longer applies. User requests override this hint.\n\n" +
  "If at any point you can parallelize work by delegating tasks to another agent (no matter if you are the root session or a child), " +
  "do so with subagent or session_crew when it could save time or improve quality.";
