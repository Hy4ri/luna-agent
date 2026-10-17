// Projects: a named working directory. A session created in a project starts with that directory as its cwd.
// Sessions outside any project are unaffected. A project's directory is copied into the session at creation,
// so editing or deleting a project never changes sessions that already exist.
import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type Project = { id: number; name: string; cwd: string };
export class ProjectError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export class ProjectStore {
  constructor(private readonly db: DatabaseSync, private readonly onDelete?: (id: number) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS luna_session_projects (
        conversation_id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL
      ) STRICT;`);
  }
  list(): Project[] {
    return this.db.prepare("SELECT id, name, cwd FROM luna_projects ORDER BY name COLLATE NOCASE").all() as Project[];
  }
  get(id: number): Project | undefined {
    return this.db.prepare("SELECT id, name, cwd FROM luna_projects WHERE id=?").get(id) as Project | undefined;
  }
  private clean(name: unknown, cwd: unknown): { name: string; cwd: string } {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new ProjectError(400, "name must contain 1 to 100 characters");
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new ProjectError(400, "cwd must be an absolute path");
    const dir = resolve(cwd);
    let ok = false;
    try { ok = statSync(dir).isDirectory(); } catch {}
    if (!ok) throw new ProjectError(400, "cwd is not an existing directory");
    return { name: name.trim(), cwd: dir };
  }
  private taken(name: string, except?: number) {
    const row = this.db.prepare("SELECT id FROM luna_projects WHERE name=? COLLATE NOCASE").get(name) as { id: number } | undefined;
    if (row && row.id !== except) throw new ProjectError(409, "a project with that name exists");
  }
  create(name: unknown, cwd: unknown): Project {
    const v = this.clean(name, cwd); this.taken(v.name);
    const r = this.db.prepare("INSERT INTO luna_projects(name, cwd) VALUES (?,?)").run(v.name, v.cwd);
    return { id: Number(r.lastInsertRowid), ...v };
  }
  update(id: number, changes: { name?: unknown; cwd?: unknown }): Project {
    const cur = this.get(id); if (!cur) throw new ProjectError(404, "no such project");
    const v = this.clean(changes.name ?? cur.name, changes.cwd ?? cur.cwd); this.taken(v.name, id);
    this.db.prepare("UPDATE luna_projects SET name=?, cwd=? WHERE id=?").run(v.name, v.cwd, id);
    return { id, ...v };
  }
  /** Existing sessions keep their directory; only the project link is removed. */
  delete(id: number) {
    if (!this.get(id)) throw new ProjectError(404, "no such project");
    this.db.prepare("DELETE FROM luna_session_projects WHERE project_id=?").run(id);
    this.db.prepare("DELETE FROM luna_projects WHERE id=?").run(id);
    this.onDelete?.(id);
  }
  link(conversationId: number, projectId: number) {
    this.db.prepare("INSERT OR REPLACE INTO luna_session_projects(conversation_id, project_id) VALUES (?,?)").run(conversationId, projectId);
  }
  projectOf(conversationId: number): number | undefined {
    const r = this.db.prepare("SELECT project_id FROM luna_session_projects WHERE conversation_id=?").get(conversationId) as { project_id: number } | undefined;
    return r?.project_id;
  }
  /** conversation id -> project id, for the session list. */
  links(): Map<number, number> {
    const rows = this.db.prepare("SELECT conversation_id, project_id FROM luna_session_projects").all() as { conversation_id: number; project_id: number }[];
    return new Map(rows.map(r => [r.conversation_id, r.project_id]));
  }
}
