import { GitError } from "./git-control.js";

type TargetProject = { general?: boolean; cwd: string; workerDirs?: { worker: number; cwd: string }[] };
export type TargetDeps = {
  project(id: number): TargetProject | undefined;
  online(worker: number): boolean;
};
/** `worker: null` is the main host. */
export type ProjectTarget = { worker: number | null; cwd: string };

/**
 * Picks the directory a project's Git requests run in. `machine` is `main`, a worker id, or absent.
 * Absent means the main host when the project has a directory there, else its first online machine.
 */
export function resolveProjectTarget(id: number, machine: string | undefined, deps: TargetDeps): ProjectTarget {
  const p = deps.project(id);
  if (!p || p.general) throw new GitError("Unknown project", 400);
  const dirs = p.workerDirs ?? [];
  const onWorker = (worker: number, cwd: string): ProjectTarget => {
    if (!deps.online(worker)) throw new GitError("Machine unavailable", 503);
    return { worker, cwd };
  };
  if (machine === "main") {
    if (!p.cwd) throw new GitError("Project has no main-host directory", 400);
    return { worker: null, cwd: p.cwd };
  }
  if (machine !== undefined) {
    if (!/^\d+$/.test(machine)) throw new GitError("Invalid machine", 400);
    const dir = dirs.find(d => d.worker === Number(machine));
    if (!dir?.cwd) throw new GitError("Project has no directory on this machine", 400);
    return onWorker(dir.worker, dir.cwd);
  }
  if (p.cwd) return { worker: null, cwd: p.cwd };
  const linked = dirs.filter(d => d.cwd);
  if (!linked.length) throw new GitError("Project has no directory", 400);
  const first = linked.find(d => deps.online(d.worker));
  if (!first) throw new GitError("Machine unavailable", 503);
  return { worker: first.worker, cwd: first.cwd };
}
