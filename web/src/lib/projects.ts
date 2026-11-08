import type { Project } from "./types";
import type { WorkerRow } from "@/stores/workers";

/** Favourite projects first. The incoming order is kept inside each group (the sort is stable). */
export function sortProjects<T extends Pick<Project, "favorite">>(projects: readonly T[]): T[] {
  return [...projects.filter(p => p.favorite), ...projects.filter(p => !p.favorite)];
}

export interface QuickSessionTarget {
  worker: number | null;
  disabledReason?: string;
}

/**
 * Default execution target for starting a session directly from a Level 1 project row:
 * main host when general, unscoped, or linked to a main-host directory; otherwise the first
 * online linked worker, or disabled with a clear reason if every linked worker is offline.
 */
export function resolveQuickSessionTarget(
  projectId: number | null,
  projectName: string,
  projects: readonly Pick<Project, "id" | "general" | "cwd" | "workerDirs">[],
  workers: readonly Pick<WorkerRow, "id" | "name" | "online">[],
): QuickSessionTarget {
  if (projectId === null) return { worker: null };
  const p = projects.find(proj => proj.id === projectId);
  if (!p || p.general || p.cwd) return { worker: null };
  const dirs = p.workerDirs ?? [];
  if (!dirs.length) return { worker: null, disabledReason: `${projectName} is not linked to a machine` };
  const onlineDir = dirs.find(d => workers.find(w => w.id === d.worker)?.online);
  if (onlineDir) return { worker: onlineDir.worker };
  const first = dirs[0]!;
  const name = workers.find(w => w.id === first.worker)?.name ?? "Worker";
  return { worker: first.worker, disabledReason: `${name} is offline` };
}
