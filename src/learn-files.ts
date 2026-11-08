// File mutation boundary for approved learning proposals. No executable benchmarks or arbitrary path writes.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { SkillImprover } from "./improve.js";
import type { LessonRow } from "./learn.js";

export interface ChangeRow {
  id: number; lesson: number; target: string; before_text: string | null; after_text: string | null;
  metadata: string; state: string; created: number;
}
export interface EnrolledFile { path: string; domain: string }

/** Symlinks cannot redirect approved writes. Missing descendants are allowed for new managed skills. */
function noLinks(path: string) {
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink target refused: ${current}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}

export class LearnFiles {
  constructor(readonly dataDir: string, private enrolled: () => readonly EnrolledFile[]) {}

  target(l: LessonRow, imp: SkillImprover): string {
    let path: string;
    if (l.scope === "skill") {
      if (!l.skill) throw new Error("skill name required");
      path = imp.skillPath(l.skill);
      if (imp.read(l.skill) !== undefined && !existsSync(path)) throw new Error("external skill is read-only; propose a new managed skill name");
    } else if (l.scope === "project") {
      if (!l.target || !isAbsolute(l.target)) throw new Error("project target must be an absolute enrolled file path");
      path = resolve(l.target);
      if (!this.enrolled().some(f => resolve(f.path) === path && f.domain === l.domain)) throw new Error("file/domain not enrolled in learn.files by the user");
    } else throw new Error("unsupported file scope");
    path = resolve(path);
    if (path === resolve(this.dataDir, "SOUL.md")) throw new Error("SOUL.md is protected");
    noLinks(path);
    return path;
  }

  read(path: string): string | null {
    noLinks(path);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 100_000) throw new Error("learning targets must be regular text files of at most 100 KB");
      const content = readFileSync(path, "utf8");
      if (content.includes("\0")) throw new Error("binary file refused");
      return content;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }

  /** Serializes cooperating proposals and checks the exact reviewed version before an atomic replacement.
   * External editors do not share this lock. Their changes observed before rename cause a conflict.
   * A leftover lock after a process crash is deliberately not removed automatically.
   */
  write(path: string, expected: string | null, next: string | null) {
    if (next !== null && Buffer.byteLength(next) > 100_000) throw new Error("proposed file exceeds 100 KB");
    noLinks(path);
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.luna-learning-lock`;
    const fd = openSync(lock, "wx", 0o600);
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      if (this.read(path) !== expected) throw new Error("file changed since review; no overwrite performed");
      if (next === null) {
        // Rollback of a newly-created file only. Exact content was checked above.
        if (expected !== null) rmSync(path);
      } else {
        const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
        const out = openSync(tmp, "wx", mode);
        try { writeFileSync(out, next, "utf8"); fsyncSync(out); } finally { closeSync(out); }
        if (this.read(path) !== expected) throw new Error("concurrent file edit detected");
        noLinks(path);
        renameSync(tmp, path);
      }
      if (this.read(path) !== next) throw new Error("file write read-back mismatch");
    } finally { closeSync(fd); rmSync(tmp, { force: true }); rmSync(lock); }
  }
}
