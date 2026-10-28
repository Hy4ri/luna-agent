// Per-project skill overrides: a skill can be forced on or off for one project, or inherit the global setting.
// The General project (id 0) always uses the global setting.
import type { DatabaseSync } from "node:sqlite";

export class ProjectSkills {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_project_skills (
        project_id INTEGER NOT NULL, skill TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (project_id, skill)
      ) STRICT;`);
  }
  overrides(project: number): Map<string, boolean> {
    const rows = this.db.prepare("SELECT skill, enabled FROM luna_project_skills WHERE project_id=?").all(project) as { skill: string; enabled: number }[];
    return new Map(rows.map(r => [r.skill, r.enabled === 1]));
  }
  /** `null` resets the skill to the global setting. */
  set(project: number, skill: string, enabled: boolean | null) {
    if (enabled === null) this.db.prepare("DELETE FROM luna_project_skills WHERE project_id=? AND skill=?").run(project, skill);
    else this.db.prepare("INSERT OR REPLACE INTO luna_project_skills(project_id, skill, enabled) VALUES (?,?,?)").run(project, skill, enabled ? 1 : 0);
  }
  clear(project: number) { this.db.prepare("DELETE FROM luna_project_skills WHERE project_id=?").run(project); }
  /** Global disabled list adjusted by this project's overrides. */
  disabled(project: number, global: readonly string[]): string[] {
    const off = new Set(global);
    for (const [skill, on] of this.overrides(project)) on ? off.delete(skill) : off.add(skill);
    return [...off];
  }
}
