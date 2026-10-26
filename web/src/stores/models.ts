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
function pinOperation(body?: object): Promise<boolean> {
  const origin = serverUrl.value, credential = token.value;
  const operation = pinQueue.then(async () => {
    if (origin !== serverUrl.value || credential !== token.value) return false;
    // Remove legacy data only after the server has saved it. Failed imports can retry.
    const legacy = readPins();
    if (legacy.length) {
      const imported = await post<{ pins: string[] }>("/v1/models/pins", { action: "import", pins: legacy });
      models.pins = imported.pins;
      localStorage.removeItem(PIN_KEY);
    }
    const result = body
      ? await post<{ pins: string[] }>("/v1/models/pins", body)
      : await json<{ pins: string[] }>("/v1/models/pins");
    models.pins = result.pins;
    return true;
  }).catch(e => { addErr((e as Error).message); return false; });
  pinQueue = operation;
  return operation;
}
export function togglePin(key: string): Promise<boolean> {
  return pinOperation({ action: "toggle", key });
}
export function movePin(key: string, direction: -1 | 1): Promise<boolean> {
  return pinOperation({ action: "move", key, direction });
}

export async function loadModels() {
  await pinOperation();
  try {
    const r = await json<{ models: ModelInfo[]; default: ModelRef | null; refresh: typeof models.refresh }>("/v1/models");
    models.list = r.models; models.defaultModel = r.default; models.refresh = r.refresh;
  } catch {
    // Keep the last usable catalog when the server is unavailable.
    models.loaded = true;
    return false;
  }
  models.loaded = true;
  if (!chat.session) setSelectedModel(models.draft.model ?? models.defaultModel);
  return true;
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
