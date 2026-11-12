// Model list, selection, pins, and thinking level. Port of vanilla models.js state.
import { computed, markRaw, reactive } from "vue";
import { json, post, serverUrl, token } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";
import {
  FALLBACK_LEVEL,
  LEVELS,
  buildSiblingIndex,
  clampTo,
  findSiblingGroup,
  levelsOf,
  modelDisplayName,
  siblingLevelOf,
  siblingTarget,
  startLevel,
  type ModelRef,
} from "@/lib/thinking-levels";
import { addErr, busy, chat } from "./chat";

export { FALLBACK_LEVEL, LEVELS, type ModelRef };
export type Speed = "fast" | "ultrafast";
export const speedLabel = (s: Speed | null) => (s === "ultrafast" ? "Ultrafast" : s === "fast" ? "Fast" : "Standard");
export const levelLabel = (l: string) => (l === "off" ? "Off" : l.charAt(0).toUpperCase() + l.slice(1));
const PIN_KEY = "luna.pinnedModels";

function readPins(): string[] {
  try {
    const pins = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
    return Array.isArray(pins) ? pins.filter((p): p is string => typeof p === "string") : [];
  } catch { return []; }
}

export const models = reactive({
  list: [] as ModelInfo[],
  defaultModel: null as ModelRef | null,
  selected: null as ModelRef | null,
  thinking: FALLBACK_LEVEL,
  defaultThinkingLevel: FALLBACK_LEVEL,
  /** OpenAI service tier for the session: null is standard speed. */
  speed: null as Speed | null,
  draft: {} as { model?: ModelRef; thinkingLevel?: string; speed?: Speed | null },
  pins: [] as string[],
  loaded: false,
  refresh: null as { checkedAt: number | null; refreshing: boolean; intervalMs: number; errors: Record<string, string> } | null,
});

export const modelKey = (m: Pick<ModelInfo, "provider" | "id">) => m.provider + "/" + m.id;
/** "provider/id" to model, rebuilt once per catalog load. Lookups stay O(1) with catalogs of thousands of models. */
export const modelIndex = computed(() => {
  const index = new Map<string, ModelInfo>();
  for (const m of models.list) { const key = modelKey(m); if (!index.has(key)) index.set(key, m); }
  return index;
});
export const modelByKey = (key: string) => modelIndex.value.get(key);
export const selectedKey = computed(() => (models.selected ? models.selected.provider + "/" + models.selected.modelId : ""));
export const modelLabel = computed(() => modelDisplayName(modelInfo(models.selected), models.selected));
export const modelTitle = computed(() => {
  const key = selectedKey.value;
  const m = modelByKey(key);
  return m ? m.provider + " · " + (m.name || m.id) : key || "Choose model";
});

export const siblingIndex = computed(() => buildSiblingIndex(models.list));
export const siblingGroupFor = (ref: ModelRef | null | undefined) => findSiblingGroup(siblingIndex.value, ref);
export const siblingLevelFor = (ref: ModelRef | null | undefined) => siblingLevelOf(siblingIndex.value, ref);
export const siblingTargetFor = (ref: ModelRef | null | undefined, level: string) => siblingTarget(siblingIndex.value, ref, level);
export const isSiblingModel = computed(() => !!siblingGroupFor(models.selected));

export const modelInfo = (ref: ModelRef | null | undefined) => (ref ? modelByKey(ref.provider + "/" + ref.modelId) : undefined);
export const levelsFor = (ref: ModelRef | null | undefined) => levelsOf(modelInfo(ref), siblingGroupFor(ref));
export const availableLevels = computed(() => levelsFor(models.selected));
/** Speeds the selected model offers; empty hides the speed button. */
export const availableSpeeds = computed<Speed[]>(() => (modelInfo(models.selected)?.speeds as Speed[] | undefined) ?? []);
/** The speed requests run: Ultrafast falls back to Fast on models without it (the server applies the same rule). */
export const effectiveSpeed = computed<Speed | null>(() => {
  const s = models.speed, speeds = availableSpeeds.value;
  if (!s) return null;
  if (speeds.includes(s)) return s;
  return s === "ultrafast" && speeds.includes("fast") ? "fast" : null;
});
export const clampLevel = (level: string, ref: ModelRef | null | undefined) => clampTo(levelsFor(ref), level);
export const defaultLevelFor = (ref: ModelRef | null | undefined) =>
  startLevel(modelInfo(ref), models.defaultThinkingLevel, siblingGroupFor(ref), ref);
const draftLevel = (ref: ModelRef | null | undefined) =>
  siblingLevelFor(ref) ?? (models.draft.thinkingLevel ? clampLevel(models.draft.thinkingLevel, ref) : defaultLevelFor(ref));

export function setSelectedModel(m: ModelRef | null | undefined) { models.selected = m ? { provider: m.provider, modelId: m.modelId } : null; }

let pinQueue: Promise<unknown> = Promise.resolve();
let inFlightPins: { origin: string; credential: string; promise: Promise<boolean> } | null = null;
function pinOperation(body?: object): Promise<boolean> {
  const origin = serverUrl.value, credential = token.value;
  if (!body && inFlightPins && inFlightPins.origin === origin && inFlightPins.credential === credential) {
    return inFlightPins.promise;
  }
  const operation = pinQueue.then(async () => {
    if (origin !== serverUrl.value || credential !== token.value) return false;
    // Remove legacy data only after the server has saved it. Failed imports can retry.
    const legacy = readPins();
    if (legacy.length) {
      const imported = await post<{ pins: string[] }>("/v1/models/pins", { action: "import", pins: legacy });
      if (origin !== serverUrl.value || credential !== token.value) return false;
      models.pins = imported.pins;
      localStorage.removeItem(PIN_KEY);
    }
    const result = body
      ? await post<{ pins: string[] }>("/v1/models/pins", body)
      : await json<{ pins: string[] }>("/v1/models/pins");
    if (origin !== serverUrl.value || credential !== token.value) return false;
    models.pins = result.pins;
    return true;
  }).catch(e => { addErr((e as Error).message); return false; });
  pinQueue = operation;
  if (!body) {
    const current = { origin, credential, promise: operation };
    inFlightPins = current;
    const cleanup = () => { if (inFlightPins === current) inFlightPins = null; };
    operation.then(cleanup, cleanup);
  }
  return operation;
}
export function togglePin(key: string): Promise<boolean> {
  return pinOperation({ action: "toggle", key });
}
export function movePin(key: string, direction: -1 | 1): Promise<boolean> {
  return pinOperation({ action: "move", key, direction });
}

export interface LoadModelsOptions {
  force?: boolean;
}

let inFlightModels: { origin: string; credential: string; promise: Promise<boolean> } | null = null;
let modelsRequest = 0;
let catalogFresh: { origin: string; credential: string; expires: number } | undefined;

export async function loadModels(options?: LoadModelsOptions): Promise<boolean> {
  const origin = serverUrl.value, credential = token.value;
  if (!options?.force && catalogFresh?.origin === origin && catalogFresh.credential === credential && catalogFresh.expires > Date.now()) return true;
  if (!options?.force && inFlightModels && inFlightModels.origin === origin && inFlightModels.credential === credential) {
    return inFlightModels.promise;
  }

  const generation = ++modelsRequest;
  const task = (async () => {
    await pinOperation();
    if (generation !== modelsRequest || origin !== serverUrl.value || credential !== token.value) return false;
    try {
      const r = await json<{ models: ModelInfo[]; default: ModelRef | null; defaultThinkingLevel?: string; refresh: typeof models.refresh }>("/v1/models");
      if (generation !== modelsRequest || origin !== serverUrl.value || credential !== token.value) return false;
      // The list is replaced, never mutated. markRaw keeps Vue from proxying every model and its nested arrays.
      models.list = markRaw(r.models); models.defaultModel = r.default; models.refresh = r.refresh;
      models.defaultThinkingLevel = r.defaultThinkingLevel ?? FALLBACK_LEVEL;
      catalogFresh = { origin, credential, expires: Date.now() + 30_000 };
    } catch {
      // Keep the last usable catalog when the server is unavailable.
      if (generation === modelsRequest && origin === serverUrl.value && credential === token.value) {
        models.loaded = true;
      }
      return false;
    }
    models.loaded = true;
    if (!chat.session) {
      setSelectedModel(models.draft.model ?? models.defaultModel);
      models.thinking = draftLevel(models.selected);
    } else {
      const sibLevel = siblingLevelFor(models.selected);
      if (sibLevel) models.thinking = sibLevel;
    }
    return true;
  })();

  const current = { origin, credential, promise: task };
  inFlightModels = current;
  const cleanup = () => { if (inFlightModels === current) inFlightModels = null; };
  task.then(cleanup, cleanup);
  return task;
}

export interface CatalogRefreshResult {
  /** The updated catalog loaded. */
  ok: boolean;
  /** Provider id to error message for providers that could not refresh. */
  errors: Record<string, string>;
  /** Set when the refresh request or the reload failed. */
  error?: string;
}

let inFlightCatalog: Promise<CatalogRefreshResult> | null = null;

/** Asks the server to re-check every provider, then reloads the list. Shared by the pickers and Settings. */
export function refreshCatalog(): Promise<CatalogRefreshResult> {
  if (inFlightCatalog) return inFlightCatalog;
  const task = (async (): Promise<CatalogRefreshResult> => {
    let errors: Record<string, string> = {};
    try {
      // The server allows each provider up to 30 s, so the default 15 s client limit is too short.
      const r = await post<{ refresh?: { errors?: Record<string, string> } }>("/v1/models/refresh", undefined, "POST", { timeoutMs: 60_000 });
      errors = r?.refresh?.errors ?? {};
    } catch (e) {
      return { ok: false, errors, error: (e as Error).message || "Model refresh failed." };
    }
    if (!await loadModels({ force: true })) {
      return { ok: false, errors, error: "Refresh finished, but the updated catalog could not be loaded." };
    }
    return { ok: true, errors };
  })();
  inFlightCatalog = task;
  const cleanup = () => { if (inFlightCatalog === task) inFlightCatalog = null; };
  task.then(cleanup, cleanup);
  return task;
}

/** Selects a draft model, or updates the open server conversation. */
export async function chooseModel(m: ModelInfo): Promise<boolean> {
  try {
    const target = chat.session;
    if (!target) {
      models.draft.model = { provider: m.provider, modelId: m.id };
      setSelectedModel(models.draft.model);
      models.thinking = draftLevel(models.draft.model);
      return true;
    }
    const r = await post<{ thinkingLevel?: string }>(`/v1/sessions/${target}`, { model: { provider: m.provider, modelId: m.id } }, "PATCH");
    if (chat.session === target) {
      const ref = { provider: m.provider, modelId: m.id };
      setSelectedModel(ref);
      // For sibling models, the UI displays the sibling's suffix level instead of the server's clamped "off".
      const sibLevel = siblingLevelFor(ref);
      if (sibLevel) models.thinking = sibLevel;
      else if (r?.thinkingLevel) models.thinking = r.thinkingLevel;
      return true;
    }
  } catch (e) { addErr((e as Error).message); }
  return false;
}

export async function setSpeed(speed: Speed | null) {
  const previous = models.speed;
  models.speed = speed;
  const sid = chat.session, epoch = chat.epoch;
  if (!sid) { models.draft.speed = speed; return; }
  try {
    const r = await post<{ speed?: Speed | null }>(`/v1/sessions/${sid}`, { speed }, "PATCH");
    if (chat.session === sid && epoch === chat.epoch && r && "speed" in r) models.speed = r.speed ?? null;
  } catch (e) {
    if (epoch === chat.epoch) { models.speed = previous; addErr((e as Error).message); }
  }
}

let pendingSiblingSwitch: { sid: string; epoch: number; key: string; promise: Promise<boolean> } | null = null;

export async function setThinking(level: string): Promise<boolean> {
  const clamped = clampLevel(level, models.selected);
  const sid = chat.session, epoch = chat.epoch;

  if (siblingGroupFor(models.selected)) {
    const target = siblingTargetFor(models.selected, clamped);
    if (!target) return false;
    if (target.provider === models.selected?.provider && target.id === models.selected?.modelId) {
      models.thinking = clamped;
      return true;
    }
    if (!sid) {
      models.draft.model = { provider: target.provider, modelId: target.id };
      models.draft.thinkingLevel = clamped;
      setSelectedModel(models.draft.model);
      models.thinking = clamped;
      return true;
    }
    if (busy.value) {
      addErr("Cannot change reasoning level while busy.");
      return false;
    }
    const targetKey = modelKey(target);
    if (pendingSiblingSwitch?.sid === sid && pendingSiblingSwitch.epoch === epoch && pendingSiblingSwitch.key === targetKey) {
      return pendingSiblingSwitch.promise;
    }
    const task = chooseModel(target).finally(() => {
      if (pendingSiblingSwitch?.promise === task) pendingSiblingSwitch = null;
    });
    pendingSiblingSwitch = { sid, epoch, key: targetKey, promise: task };
    return task;
  }

  models.thinking = clamped;
  if (!sid) { models.draft.thinkingLevel = models.thinking; return true; }
  try {
    const r = await post<{ thinkingLevel?: string }>(`/v1/sessions/${sid}`, { thinkingLevel: level }, "PATCH");
    if (chat.session === sid && epoch === chat.epoch && r?.thinkingLevel) models.thinking = r.thinkingLevel;
    return true;
  } catch (e) {
    if (epoch === chat.epoch) addErr((e as Error).message);
    return false;
  }
}
