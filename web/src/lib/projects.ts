import type { Project } from "./types";

/** Favourite projects first. The incoming order is kept inside each group (the sort is stable). */
export function sortProjects<T extends Pick<Project, "favorite">>(projects: readonly T[]): T[] {
  return [...projects.filter(p => p.favorite), ...projects.filter(p => !p.favorite)];
}
