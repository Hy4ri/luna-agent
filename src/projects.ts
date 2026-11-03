// Projects: a named working directory. A session created in a project starts with that directory as its cwd.
// General is built in for unlinked sessions and does not change their working directories.
// A named project's directory is copied into the session at creation,
// so editing or deleting a project never changes sessions that already exist.
import { isValidProjectIcon, type ProjectAppearance } from "./project-appearance.js";
import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** A project's working directory on one execution worker. `cwd` on the project itself is the directory on the main host. */
export type WorkerDir = { worker: number; cwd: string };
export type Project = ProjectAppearance & { id: number; name: string; cwd: string; general?: boolean; favorite?: boolean; workerDirs?: WorkerDir[] };
// ID zero is reserved; persisted project IDs start at one. No migration or session rewrites are needed.
export const GENERAL_PROJECT: Readonly<Project> = Object.freeze({ id: 0, name: "General", cwd: "", general: true });

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
      ) STRICT;
      CREATE TABLE IF NOT EXISTS luna_project_worker_dirs (
        project_id INTEGER NOT NULL, worker_id INTEGER NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY (project_id, worker_id)
      ) STRICT;`);
    // Older databases lack the favourite flag.
    if (!(db.prepare("PRAGMA table_info(luna_projects)").all() as { name: string }[]).some(c => c.name === "favorite"))
      db.exec("ALTER TABLE luna_projects ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
    const columns = new Set((db.prepare("PRAGMA table_info(luna_projects)").all() as { name: string }[]).map(c => c.name));
    for (const column of ["color", "icon"]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE luna_projects ADD COLUMN ${column} TEXT`);
    }
  }
  /** One board serves every machine of a project, so linking machines only records a directory per worker. */
  private dirs(): Map<number, WorkerDir[]> {
    const out = new Map<number, WorkerDir[]>();
    for (const r of this.db.prepare("SELECT project_id, worker_id, cwd FROM luna_project_worker_dirs ORDER BY worker_id").all() as { project_id: number; worker_id: number; cwd: string }[])
      out.set(r.project_id, [...(out.get(r.project_id) ?? []), { worker: r.worker_id, cwd: r.cwd }]);
    return out;
  }
  list(): Project[] {
    const dirs = this.dirs();
    const rows = this.db.prepare("SELECT id, name, cwd, favorite, color, icon FROM luna_projects ORDER BY name COLLATE NOCASE").all() as (Omit<Project, "general" | "workerDirs" | "favorite"> & { favorite: number })[];
    return [{ ...GENERAL_PROJECT }, ...rows.map(r => ({ ...r, favorite: !!r.favorite, workerDirs: dirs.get(r.id) ?? [] }))];
  }
  get(id: number): Project | undefined {
    if (id === GENERAL_PROJECT.id) return { ...GENERAL_PROJECT };
    const r = this.db.prepare("SELECT id, name, cwd, favorite, color, icon FROM luna_projects WHERE id=?").get(id) as (Omit<Project, "workerDirs" | "favorite"> & { favorite: number }) | undefined;
    return r && { ...r, favorite: !!r.favorite, workerDirs: this.dirs().get(id) ?? [] };
  }
  /** Directory for a new session on a machine: `null` is the main host. */
  dirFor(id: number, worker: number | null): string | undefined {
    const p = this.get(id); if (!p || p.general) return undefined;
    return worker === null ? p.cwd : p.workerDirs?.find(d => d.worker === worker)?.cwd;
  }
  /** Link a project to a worker by recording its directory there. The path is checked by the worker when a session uses it. */
  setWorkerDir(id: number, worker: number, cwd: unknown): Project {
    if (id === GENERAL_PROJECT.id) throw new ProjectError(409, "The General project cannot be changed");
    if (!this.get(id)) throw new ProjectError(404, "no such project");
    if (!Number.isSafeInteger(worker) || worker < 1) throw new ProjectError(400, "invalid worker");
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 4096 || cwd.includes("\0")) throw new ProjectError(400, "cwd must be an absolute path");
    this.db.prepare("INSERT OR REPLACE INTO luna_project_worker_dirs(project_id, worker_id, cwd) VALUES (?,?,?)").run(id, worker, cwd.trim());
    return this.get(id)!;
  }
  removeWorkerDir(id: number, worker: number): Project {
    const cur = this.get(id); if (!cur) throw new ProjectError(404, "no such project");
    const here = cur.workerDirs?.some(d => d.worker === worker);
    if (here && !cur.cwd && cur.workerDirs!.length === 1) throw new ProjectError(409, "This is the last machine of the project. Delete the project to remove its board.");
    this.db.prepare("DELETE FROM luna_project_worker_dirs WHERE project_id=? AND worker_id=?").run(id, worker);
    return this.get(id)!;
  }
  /** Take the project off the main host. Other machines keep it and its board. An empty `cwd` means not on this host. */
  removeHostDir(id: number): Project {
    if (id === GENERAL_PROJECT.id) throw new ProjectError(409, "The General project cannot be changed");
    const cur = this.get(id); if (!cur) throw new ProjectError(404, "no such project");
    if (!cur.cwd) return cur;
    if (!cur.workerDirs?.length) throw new ProjectError(409, "This is the last machine of the project. Delete the project to remove its board.");
    this.db.prepare("UPDATE luna_projects SET cwd='' WHERE id=?").run(id);
    return this.get(id)!;
  }
  /** A removed worker leaves no stale links. */
  forgetWorker(worker: number) { this.db.prepare("DELETE FROM luna_project_worker_dirs WHERE worker_id=?").run(worker); }
  private cleanName(name: unknown): string {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new ProjectError(400, "name must contain 1 to 100 characters");
    return name.trim();
  }
  private clean(name: unknown, cwd: unknown): { name: string; cwd: string } {
    const clean = this.cleanName(name);
    if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new ProjectError(400, "cwd must be an absolute path");
    const dir = resolve(cwd);
    let ok = false;
    try { ok = statSync(dir).isDirectory(); } catch {}
    if (!ok) throw new ProjectError(400, "cwd is not an existing directory");
    return { name: clean, cwd: dir };
  }
  private taken(name: string, except?: number) {
    if (name.toLowerCase() === GENERAL_PROJECT.name.toLowerCase() && this.get(except ?? -1)?.name.toLowerCase() !== name.toLowerCase()) throw new ProjectError(409, "General is reserved for chats outside named projects");
    const row = this.db.prepare("SELECT id FROM luna_projects WHERE name=? COLLATE NOCASE").get(name) as { id: number } | undefined;
    if (row && row.id !== except) throw new ProjectError(409, "a project with that name exists");
  }
  private cleanWorkerCwd(cwd: unknown): string {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.length > 4096 || cwd.includes("\0")) throw new ProjectError(400, "cwd must be an absolute path");
    const t = cwd.trim(); if (!t || !isAbsolute(t)) throw new ProjectError(400, "cwd must be an absolute path"); return t;
  }
  create(name: unknown, cwd: unknown, opts?: { worker?: unknown; workerCwd?: unknown }): Project {
    const hasWorker = opts !== undefined && (opts.worker !== undefined || opts.workerCwd !== undefined);
    if (hasWorker) {
      const cleanName = this.cleanName(name); this.taken(cleanName);
      if (opts!.worker === undefined || opts!.workerCwd === undefined) throw new ProjectError(400, "worker and workerCwd required together");
      if (!Number.isSafeInteger(opts!.worker) || (opts!.worker as number) < 1) throw new ProjectError(400, "invalid worker");
      const workerCwd = this.cleanWorkerCwd(opts!.workerCwd);
      if (cwd !== undefined && typeof cwd !== "string") throw new ProjectError(400, "cwd must be an absolute path");
      let hostCwd = "";
      if (typeof cwd === "string" && cwd.trim() !== "") hostCwd = this.clean(cleanName, cwd).cwd;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const r = this.db.prepare("INSERT INTO luna_projects(name, cwd) VALUES (?,?)").run(cleanName, hostCwd);
        const id = Number(r.lastInsertRowid);
        this.db.prepare("INSERT INTO luna_project_worker_dirs(project_id, worker_id, cwd) VALUES (?,?,?)").run(id, opts!.worker as number, workerCwd);
        this.db.exec("COMMIT");
        return this.get(id)!;
      } catch (e) { try { this.db.exec("ROLLBACK"); } catch {} throw e; }
    }
    const v = this.clean(name, cwd); this.taken(v.name);
    const r = this.db.prepare("INSERT INTO luna_projects(name, cwd) VALUES (?,?)").run(v.name, v.cwd);
    return this.get(Number(r.lastInsertRowid))!;
  }
  update(id: number, changes: { name?: unknown; cwd?: unknown; favorite?: unknown; color?: unknown; icon?: unknown }): Project {
    if (id === GENERAL_PROJECT.id) throw new ProjectError(409, "The General project cannot be changed");
    const cur = this.get(id); if (!cur) throw new ProjectError(404, "no such project");
    if (changes.favorite !== undefined && typeof changes.favorite !== "boolean") throw new ProjectError(400, "favorite must be a boolean");
    const favorite = changes.favorite ?? cur.favorite ?? false;
    if (changes.color !== undefined && changes.color !== null && (typeof changes.color !== "string" || !/^#[0-9a-f]{6}$/i.test(changes.color)))
      throw new ProjectError(400, "color must be a six-digit hex color or null");
    if (changes.icon !== undefined && changes.icon !== null && !isValidProjectIcon(changes.icon))
      throw new ProjectError(400, "icon must be a supported project icon or a single visible character, or null");
    const color = changes.color === undefined ? cur.color ?? null : (changes.color as string | null)?.toLowerCase() ?? null;
    const icon = changes.icon === undefined ? cur.icon ?? null : changes.icon as string | null;
    // Metadata-only changes work even when the directory is gone.
    if (changes.name === undefined && changes.cwd === undefined) {
      this.db.prepare("UPDATE luna_projects SET favorite=?, color=?, icon=? WHERE id=?").run(favorite ? 1 : 0, color, icon, id);
      return this.get(id)!;
    }
    const next = changes.cwd ?? cur.cwd;
    if (next === "" && !cur.workerDirs?.length) throw new ProjectError(400, "cwd must be an absolute path");
    // A project that is only on other machines keeps an empty host directory.
    const v = next === "" ? { name: this.cleanName(changes.name ?? cur.name), cwd: "" } : this.clean(changes.name ?? cur.name, next);
    this.taken(v.name, id);
    this.db.prepare("UPDATE luna_projects SET name=?, cwd=?, favorite=?, color=?, icon=? WHERE id=?").run(v.name, v.cwd, favorite ? 1 : 0, color, icon, id);
    return this.get(id)!;
  }
  /** Existing sessions keep their directory and fall back to General. */
  delete(id: number) {
    if (id === GENERAL_PROJECT.id) throw new ProjectError(409, "The General project cannot be deleted");
    if (!this.get(id)) throw new ProjectError(404, "no such project");
    this.db.prepare("DELETE FROM luna_session_projects WHERE project_id=?").run(id);
    this.db.prepare("DELETE FROM luna_project_worker_dirs WHERE project_id=?").run(id);
    this.db.prepare("DELETE FROM luna_projects WHERE id=?").run(id);
    this.onDelete?.(id);
  }
  link(conversationId: number, projectId: number) {
    this.db.prepare("INSERT OR REPLACE INTO luna_session_projects(conversation_id, project_id) VALUES (?,?)").run(conversationId, projectId);
  }
  projectOf(conversationId: number): number | undefined {
    const r = this.db.prepare("SELECT project_id FROM luna_session_projects WHERE conversation_id=?").get(conversationId) as { project_id: number } | undefined;
    return r && this.get(r.project_id) ? r.project_id : GENERAL_PROJECT.id;
  }
  /** conversation id -> project id, for the session list. */
  links(): Map<number, number> {
    const rows = this.db.prepare("SELECT conversation_id, project_id FROM luna_session_projects").all() as { conversation_id: number; project_id: number }[];
    return new Map(rows.map(r => [r.conversation_id, r.project_id]));
  }
}
