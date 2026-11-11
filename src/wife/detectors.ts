// Cheap deterministic detectors over the analytics index. No model calls.
import type { AnalyticsSessionRecord } from "../analytics/types.js";
import { basename } from "node:path";
import type { Project } from "../projects.js";
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

/** The project directory that applies to a session on its worker, or undefined. */
function dirOf(p: Project, worker: string): string | undefined {
  if (p.general) return undefined;
  const dir = worker === "main" || worker === "" ? p.cwd : p.workerDirs?.find(d => String(d.worker) === worker)?.cwd;
  return dir ? dir.replace(/\/+$/, "") : undefined;
}
const inside = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(dir + "/");
const live = (s: AnalyticsSessionRecord) => s.deletedAt === null && s.parentId === null && !s.archived && s.status !== "running" && !!s.cwd;
/** Longest project directory that holds the session's cwd. */
function owner(s: AnalyticsSessionRecord, projects: Project[]): Project | undefined {
  let best: Project | undefined, len = -1;
  for (const p of projects) { const d = dirOf(p, s.worker); if (d && inside(s.cwd!, d) && d.length > len) { best = p; len = d.length; } }
  return best;
}

/** A session whose directory belongs to another project than the one it sits in. */
export function misfiledSessions(sessions: AnalyticsSessionRecord[], projects: Project[]): NewSuggestion[] {
  const out: NewSuggestion[] = [];
  for (const s of sessions) {
    if (!live(s)) continue;
    const target = owner(s, projects);
    if (!target || target.id === s.projectId) continue;
    const current = projects.find(p => p.id === s.projectId);
    const currentDir = current && dirOf(current, s.worker);
    if (currentDir && inside(s.cwd!, currentDir)) continue;   // it already sits in a project that holds its directory
    out.push({ kind: "move_session", fingerprint: `move_session:${s.id}:${target.id}`, source: "detector",
      title: `Move "${label(s)}" to ${target.name}`, body: `Its directory ${s.cwd} is inside the ${target.name} project, but it sits in ${s.projectId === 0 ? "General" : s.projectName}.`,
      evidence: [{ sessionId: s.id, note: s.cwd! }], payload: { sessionId: s.id, projectId: target.id } });
  }
  return out;
}

/** Three or more recent General sessions in one directory that no project owns. */
export function newProjects(sessions: AnalyticsSessionRecord[], projects: Project[], now: number, minSessions = 3, windowDays = 30): NewSuggestion[] {
  const groups = new Map<string, AnalyticsSessionRecord[]>();
  for (const s of sessions) {
    if (!live(s) || s.projectId !== 0 || s.cwd === "/" || (s.lastActivity ?? s.createdAt ?? 0) < now - windowDays * DAY || owner(s, projects)) continue;
    const key = `${s.worker}\u0000${s.cwd}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: NewSuggestion[] = [];
  for (const [key, list] of groups) {
    if (list.length < minSessions) continue;
    const [worker, cwd] = key.split("\u0000") as [string, string];
    out.push({ kind: "new_project", fingerprint: `new_project:${worker}:${cwd}`, source: "detector",
      title: `Create a project for ${basename(cwd) || cwd}`, body: `${list.length} sessions in the last ${windowDays} days worked in ${cwd}, and no project owns it.`,
      evidence: list.slice(0, 5).map(s => ({ sessionId: s.id, note: label(s) })),
      payload: { name: basename(cwd) || "project", cwd, worker, sessionIds: list.map(s => s.id) } });
  }
  return out;
}
