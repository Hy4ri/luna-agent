// Wife page state: suggestion cards, the sidebar count, and the decisions.
import { reactive, ref } from "vue";
import { api } from "@/lib/api";

export type WifeKind = "skill" | "memory" | "new_project" | "move_session" | "archive_session" | "delete_session" | "feature_tip";
export type WifeStatus = "open" | "snoozed" | "dismissed" | "working" | "done" | "failed";
export interface Suggestion {
  id: number; kind: WifeKind; title: string; body: string; evidence: { sessionId: number; note: string }[];
  status: WifeStatus; snoozeUntil: number | null; sessionId: number | null; result: string | null; created: number; updated: number;
}

export const wifeOpen = ref(0);
export const wife = reactive({ cards: [] as Suggestion[], loading: false, error: "", loaded: false, busy: new Set<number>() });

async function fail(r: Response): Promise<never> {
  const j = await r.json().catch(() => ({})) as { error?: string };
  throw new Error(j.error || `HTTP ${r.status}`);
}

export async function refreshWifeCount() {
  try { const r = await api("/v1/wife/count"); if (r.ok) wifeOpen.value = ((await r.json()) as { open: number }).open; } catch {}
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startWifeBadge() {
  void refreshWifeCount();
  if (!timer) timer = setInterval(refreshWifeCount, 60_000);
}
export function stopWifeBadge() { if (timer) clearInterval(timer); timer = undefined; }

export async function loadWife() {
  wife.loading = true; wife.error = "";
  try {
    const r = await api("/v1/wife");
    if (!r.ok) await fail(r);
    wife.cards = ((await r.json()) as { suggestions: Suggestion[] }).suggestions;
    wife.loaded = true;
    wifeOpen.value = wife.cards.filter(c => c.status === "open").length;
  } catch (e) { wife.error = (e as Error).message; }
  finally { wife.loading = false; }
}

export async function scanWife() {
  wife.error = "";
  try { const r = await api("/v1/wife/scan", { method: "POST" }); if (!r.ok) await fail(r); } catch (e) { wife.error = (e as Error).message; return; }
  await loadWife();
}

/** Run one decision on a card. Returns an error message, or "" on success. The list reloads either way. */
export async function decide(id: number, action: "agree" | "dismiss" | "snooze", body: object = {}): Promise<string> {
  wife.busy.add(id);
  try {
    const r = await api(`/v1/wife/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) await fail(r);
    return "";
  } catch (e) { return (e as Error).message; }
  finally { wife.busy.delete(id); await loadWife(); }
}
