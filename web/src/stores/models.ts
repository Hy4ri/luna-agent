// Model list, selection, pins, and thinking level. Port of vanilla models.js state.
import { computed, reactive } from "vue";
import { json, post, serverUrl, token } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";
import { addErr, chat } from "./chat";

export interface ModelRef { provider: string; modelId: string }
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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
  thinking: "off",
  defaultThinkingLevel: "off",
  draft: {} as { model?: ModelRef; thinkingLevel?: string },
  pins: [] as string[],
  loaded: false,
  refresh: null as { checkedAt: number | null; refreshing: boolean; intervalMs: number; errors: Record<string, string> } | null,
});

export const modelKey = (m: Pick<ModelInfo, "provider" | "id">) => m.provider + "/" + m.id;
export const selectedKey = computed(() => (models.selected ? models.selected.provider + "/" + models.selected.modelId : ""));
export const modelLabel = computed(() => {
  const key = selectedKey.value;
  const m = models.list.find(m => modelKey(m) === key);
  return m ? m.provider + " · " + (m.name || m.id) : key || "Choose model";
});

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
      models.list = r.models; models.defaultModel = r.default; models.refresh = r.refresh;
      models.defaultThinkingLevel = r.defaultThinkingLevel ?? "off";
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
      models.thinking = models.draft.thinkingLevel ?? models.defaultThinkingLevel;
    }
    return true;
  })();

  const current = { origin, credential, promise: task };
  inFlightModels = current;
  const cleanup = () => { if (inFlightModels === current) inFlightModels = null; };
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
      return true;
    }
    await post(`/v1/sessions/${target}`, { model: { provider: m.provider, modelId: m.id } }, "PATCH");
    if (chat.session === target) { setSelectedModel({ provider: m.provider, modelId: m.id }); return true; }
  } catch (e) { addErr((e as Error).message); }
  return false;
}

export async function setThinking(level: string) {
  models.thinking = level;
  const sid = chat.session, epoch = chat.epoch;
  if (!sid) { models.draft.thinkingLevel = level; return; }
  await post(`/v1/sessions/${sid}`, { thinkingLevel: level }, "PATCH").catch(e => { if (epoch === chat.epoch) addErr((e as Error).message); });
}
