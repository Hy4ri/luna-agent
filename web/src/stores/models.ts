// Model list, selection, pins, and thinking level. Port of vanilla models.js state.
import { computed, reactive } from "vue";
import { json, post } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";

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
  pins: readPins(),
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

/** Returns false when the browser refused to store the pins. */
export function togglePin(key: string): boolean {
  const next = new Set(readPins());
  if (next.has(key)) next.delete(key); else next.add(key);
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...next])); } catch { return false; }
  models.pins = [...next];
  return true;
}

export async function loadModels() {
  try {
    const r = await json<{ models: ModelInfo[]; default: ModelRef | null; refresh: typeof models.refresh }>("/v1/models");
    models.list = r.models; models.defaultModel = r.default; models.refresh = r.refresh;
  } catch {
    // Keep the last usable catalog when the server is unavailable.
    models.loaded = true;
    return false;
  }
  models.loaded = true;
  const { chat } = await import("./chat");
  if (!chat.session) setSelectedModel(models.defaultModel);
  return true;
}

/** Switches the model of the open conversation (creating one first when needed). */
export async function chooseModel(m: ModelInfo): Promise<boolean> {
  const { chat, newSession, addErr } = await import("./chat");
  try {
    const target = chat.session || String((await newSession()) || "");
    if (!target) return false;
    await post(`/v1/sessions/${target}`, { model: { provider: m.provider, modelId: m.id } }, "PATCH");
    if (chat.session === target) { setSelectedModel({ provider: m.provider, modelId: m.id }); return true; }
  } catch (e) { addErr((e as Error).message); }
  return false;
}

export async function setThinking(level: string) {
  const { chat, addErr } = await import("./chat");
  models.thinking = level;
  const sid = chat.session, epoch = chat.epoch;
  if (!sid) return;
  await post(`/v1/sessions/${sid}`, { thinkingLevel: level }, "PATCH").catch(e => { if (epoch === chat.epoch) addErr((e as Error).message); });
}
