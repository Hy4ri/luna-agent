// Per-project skill overrides: a skill can be forced on or off for one project, or inherit the global setting.
// A project in "only chosen" mode ignores the global setting: only skills switched on for it are active,
// so skills added later stay off there until someone switches them on.
// The General project (id 0) always uses the global setting.
import type { DatabaseSync } from "node:sqlite";

export class ProjectSkills {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_project_skills (
        project_id INTEGER NOT NULL, skill TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (project_id, skill)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS luna_project_skill_modes (project_id INTEGER PRIMARY KEY) STRICT;`);
  }
  overrides(project: number): Map<string, boolean> {
    const rows = this.db.prepare("SELECT skill, enabled FROM luna_project_skills WHERE project_id=?").all(project) as { skill: string; enabled: number }[];
    return new Map(rows.map(r => [r.skill, r.enabled === 1]));
  }
  /** True when only the skills switched on for this project are active. */
  onlyChosen(project: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM luna_project_skill_modes WHERE project_id=?").get(project);
  }
  /**
   * Switch "only chosen" mode. Turning it on keeps the active set unchanged: `active` (the skills on right now)
   * become explicit "on" entries and "off" entries are dropped, because every skill not chosen is off.
   * Turning it off keeps the chosen skills as "on" overrides; the rest follow the global setting again.
   */
  setOnlyChosen(project: number, on: boolean, active: readonly string[] = []) {
    this.db.exec("BEGIN");
    try {
      if (on) {
        this.db.prepare("INSERT OR IGNORE INTO luna_project_skill_modes(project_id) VALUES (?)").run(project);
        this.db.prepare("DELETE FROM luna_project_skills WHERE project_id=?").run(project);
        const add = this.db.prepare("INSERT INTO luna_project_skills(project_id, skill, enabled) VALUES (?,?,1)");
        for (const skill of new Set(active)) add.run(project, skill);
      } else {
        this.db.prepare("DELETE FROM luna_project_skill_modes WHERE project_id=?").run(project);
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  /** `null` resets the skill to the global setting. In "only chosen" mode, off and reset both mean not chosen. */
  set(project: number, skill: string, enabled: boolean | null) {
    if (enabled === null || (enabled === false && this.onlyChosen(project))) this.db.prepare("DELETE FROM luna_project_skills WHERE project_id=? AND skill=?").run(project, skill);
    else this.db.prepare("INSERT OR REPLACE INTO luna_project_skills(project_id, skill, enabled) VALUES (?,?,?)").run(project, skill, enabled ? 1 : 0);
  }
  clear(project: number) {
    this.db.prepare("DELETE FROM luna_project_skills WHERE project_id=?").run(project);
    this.db.prepare("DELETE FROM luna_project_skill_modes WHERE project_id=?").run(project);
  }
  /** Disabled skills for this project: the global list adjusted by overrides, or every unchosen skill in "only chosen" mode. */
  disabled(project: number, global: readonly string[], all: () => readonly string[]): string[] {
    const over = this.overrides(project);
    if (this.onlyChosen(project)) return all().filter(s => over.get(s) !== true);
    const off = new Set(global);
    for (const [skill, on] of over) on ? off.delete(skill) : off.add(skill);
    return [...off];
  }
}
