// Steward page state: suggestion cards, the sidebar count, and the decisions.
import { reactive, ref } from "vue";
import { api } from "@/lib/api";

export type StewardKind = "skill" | "memory" | "new_project" | "move_session" | "archive_session" | "delete_session" | "feature_tip" | "tune_rule" | "mute_rule" | "mute_kind" | "goal_unfinished" | "cron_failing" | "quota_waits" | "board_stuck" | "new_rule" | "promote_rule" | "cost_habit" | "compaction_heavy" | "weekly_recap" | "reminder_unscheduled" | "worktree_orphan" | "bg_leftover" | "browser_leftover" | "rule_idea" | "tool_error_repeat" | "skill_unused" | "prompt_repeat" | "project_setup_repeat";
export type StewardStatus = "open" | "snoozed" | "dismissed" | "working" | "done" | "failed";
export interface Suggestion {
  id: number; kind: StewardKind; ruleId: string; title: string; body: string; evidence: { sessionId: number; note: string }[];
  status: StewardStatus; snoozeUntil: number | null; sessionId: number | null; result: string | null; created: number; updated: number;
  payload: Record<string, unknown>; undoUntil: number | null;
}

export interface RuleStats { ruleId: string; kind: string; decisions: number; agrees: number; wrong: number; tooAggressive: number; dontCare: number; reasons: Record<string, number> }
export interface StewardStats { agree30: { decisions: number; agrees: number; rate: number | null }; rules: RuleStats[] }
export const stewardStats = ref<StewardStats | null>(null);
export const stewardOpen = ref(0);
export const steward = reactive({ cards: [] as Suggestion[], loading: false, scanning: false, error: "", notice: "", loaded: false, busy: new Set<number>() });
export interface ScanResult { filed: number; withdrawn: number; held: number; shown: number; matched: number }

/** One line that says what a scan did, so a scan that changes nothing still answers. */
export function scanSummary(r: ScanResult): string {
  const parts: string[] = [];
  if (r.filed) parts.push(`${r.filed} new`);
  if (r.shown) parts.push(`${r.shown} shown`);
  if (r.withdrawn) parts.push(`${r.withdrawn} withdrawn`);
  if (r.held) parts.push(`${r.held} held by the daily limit`);
  return parts.length ? `Scan done: ${parts.join(", ")}.` : "Scan done: nothing new.";
}

async function fail(r: Response): Promise<never> {
  const j = await r.json().catch(() => ({})) as { error?: string };
  throw new Error(j.error || `HTTP ${r.status}`);
}

export async function refreshStewardCount() {
  try { const r = await api("/v1/steward/count"); if (r.ok) stewardOpen.value = ((await r.json()) as { open: number }).open; } catch {}
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startStewardBadge() {
  void refreshStewardCount();
  if (!timer) timer = setInterval(refreshStewardCount, 60_000);
}
export function stopStewardBadge() { if (timer) clearInterval(timer); timer = undefined; }

export async function loadSteward() {
  steward.loading = true; steward.error = "";
  try {
    const r = await api("/v1/steward");
    if (!r.ok) await fail(r);
    steward.cards = ((await r.json()) as { suggestions: Suggestion[] }).suggestions;
    steward.loaded = true;
    const st = await api("/v1/steward/stats");
    if (st.ok) stewardStats.value = (await st.json()) as StewardStats;
    stewardOpen.value = steward.cards.filter(c => c.status === "open").length;
  } catch (e) { steward.error = (e as Error).message; }
  finally { steward.loading = false; }
}

export async function scanSteward() {
  if (steward.scanning) return;
  steward.error = ""; steward.notice = ""; steward.scanning = true;
  try {
    const r = await api("/v1/steward/scan", { method: "POST" });
    if (!r.ok) await fail(r);
    steward.notice = scanSummary(await r.json() as ScanResult);
  } catch (e) { steward.error = (e as Error).message; return; }
  finally { steward.scanning = false; }
  await loadSteward();
}

/** Run one decision on a card. Returns an error message, or "" on success. The list reloads either way. */
export async function decide(id: number, action: "agree" | "dismiss" | "snooze" | "undo", body: object = {}): Promise<string> {
  steward.busy.add(id);
  try {
    const r = await api(`/v1/steward/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) await fail(r);
    return "";
  } catch (e) { return (e as Error).message; }
  finally { steward.busy.delete(id); await loadSteward(); }
}

/** Run every detector on one session now, ignoring quiet hours and the daily cap.
 * Returns how many open cards are about the session, or an error text. */
export async function askSteward(sessionId: string | number): Promise<{ matched: number; error: "" } | { matched: 0; error: string }> {
  try {
    const r = await api(`/v1/steward/scan?session=${encodeURIComponent(String(sessionId))}`, { method: "POST" });
    if (!r.ok) await fail(r);
    const res = await r.json() as ScanResult;
    await loadSteward();
    return { matched: res.matched, error: "" };
  } catch (e) { return { matched: 0, error: (e as Error).message }; }
}

/** Open a session about a card. The server seeds it with the card as the first message. */
export async function discussCard(id: number): Promise<{ sessionId: number; error: "" } | { sessionId: 0; error: string }> {
  steward.busy.add(id);
  try {
    const r = await api(`/v1/steward/${id}/discuss`, { method: "POST" });
    if (!r.ok) await fail(r);
    const { sessionId } = await r.json() as { sessionId: number };
    return { sessionId, error: "" };
  } catch (e) { return { sessionId: 0, error: (e as Error).message }; }
  finally { steward.busy.delete(id); await loadSteward(); }
}
