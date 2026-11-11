// Cheap deterministic detectors over the analytics index. No model calls.
import type { AnalyticsSessionRecord } from "../analytics/types.js";
import type { NewSuggestion } from "./store.js";

export interface DetectorConfig { staleDays: number; deleteArchivedAfterDays: number }
const DAY = 86_400_000;
const label = (s: AnalyticsSessionRecord) => s.title?.trim() || `Session ${s.id}`;

/** Sessions nobody touched for a while: archive them; delete long-archived ones. */
export function staleSessions(sessions: AnalyticsSessionRecord[], cfg: DetectorConfig, now: number): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const s of sessions) {
    if (s.deletedAt !== null || s.pinned || s.parentId !== null || s.status === "running") continue;
    const last = s.lastActivity ?? s.createdAt;
    if (last == null) continue;
    const days = Math.floor((now - last) / DAY);
    if (!s.archived && days >= cfg.staleDays) out.push({
      kind: "archive_session", fingerprint: `archive_session:${s.id}`, source: "detector",
      title: `Archive "${label(s)}"`, body: `No activity for ${days} days, and it is not pinned.`,
      evidence: [{ sessionId: s.id, note: `last activity ${days} days ago` }], payload: { sessionId: s.id },
    });
    else if (s.archived && days >= cfg.deleteArchivedAfterDays) out.push({
      kind: "delete_session", fingerprint: `delete_session:${s.id}`, source: "detector",
      title: `Delete "${label(s)}"`, body: `Archived and untouched for ${days} days. Deleting cannot be undone.`,
      evidence: [{ sessionId: s.id, note: `last activity ${days} days ago` }], payload: { sessionId: s.id },
    });
  }
  return out;
}
