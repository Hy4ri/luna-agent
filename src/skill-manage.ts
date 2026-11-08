// Skill management tool: skill_manage (list with write authority, create, edit, benchmark-gated propose, rollback,
// delete, linked files, restore). Write authority: only skills under the managed dir (<dataDir>/skills) change; skills from
// other configured skillDirs are read-only. SKILL.md writes go through SkillImprover.propose (lint + version backup,
// rollback with skill_manage action=rollback). Deletes and replaced linked files move to <historyDir>/.trash and can be restored.
// Everything is plain files rescanned on every use, so changes reach the catalog on the next model call.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { proposeBenchmark, type ProposalResult, type ProposeOptions, type SkillImprover } from "./improve.js";
import { linkedFiles, scanSkills, type Skill } from "./skills.js";

export interface TrashEntry {
  id: string;
  kind: "skill" | "file";
  skill: string;
  /** Linked file path relative to the skill directory (kind "file"). */
  file?: string;
  /** Absolute original location. */
  from: string;
  deletedAt: number;
  reason: "deleted" | "replaced";
}

export interface ListedSkill {
  name: string;
  description: string;
  path: string;
  managed: boolean;
  files: number;
  tools: string[];
}

const inside = (root: string, p: string) => p.startsWith(root + sep);

export class SkillManager {
  readonly trashDir: string;
  constructor(private imp: SkillImprover, private dirs: readonly string[]) {
    this.trashDir = join(imp.historyDir, ".trash");
  }

  list(): ListedSkill[] {
    return scanSkills(this.dirs).map((s) => ({
      name: s.name, description: s.description, path: s.path, managed: this.imp.isManaged(s.dir), files: linkedFiles(s).length, tools: s.tools,
    }));
  }

  private find(name: string): Skill | undefined {
    return scanSkills(this.dirs).find((s) => s.name === name);
  }

  /** The active skill, which must live in the managed dir. */
  private managed(name: string): Skill {
    const s = this.find(name);
    if (!s) throw new Error(`no such skill "${name}"`);
    if (!this.imp.isManaged(s.dir)) throw new Error(`skill "${name}" is read-only: it lives in ${s.dir}, outside the managed dir ${this.imp.skillsDir}`);
    return s;
  }

  async create(name: string, content: string): Promise<ProposalResult> {
    const s = this.find(name);
    if (s) throw new Error(`skill "${name}" already exists at ${s.path}; use edit`);
    return this.imp.propose(name, content);
  }

  async edit(name: string, change: { content?: string; old_text?: string; new_text?: string }): Promise<ProposalResult> {
    const s = this.managed(name);
    let next: string;
    if (change.content !== undefined) {
      if (change.old_text !== undefined || change.new_text !== undefined) throw new Error("give content, or old_text + new_text, not both");
      next = change.content;
    } else {
      if (!change.old_text || change.new_text === undefined) throw new Error("edit needs content, or old_text + new_text");
      const cur = readFileSync(s.path, "utf8");
      const n = cur.split(change.old_text).length - 1;
      if (n !== 1) throw new Error(`old_text must match exactly once in SKILL.md (matched ${n} times)`);
      next = cur.replace(change.old_text, () => change.new_text!);
    }
    return this.imp.propose(name, next);
  }

  deleteSkill(name: string): TrashEntry {
    const s = this.managed(name);
    const nested = linkedFiles(s, 10_000).filter((f) => basename(f) === "SKILL.md");
    if (nested.length) throw new Error(`skill "${name}" contains nested skills (${nested.join(", ")}); delete those first`);
    return this.toTrash({ kind: "skill", skill: name, from: s.dir, reason: "deleted" });
  }

  /** Absolute path of a linked file, confined to the skill's own directory. */
  private linked(s: Skill, file: string): string {
    if (!file || isAbsolute(file) || file.includes("\0")) throw new Error("file_path must be a non-empty relative path");
    const abs = resolve(s.dir, file);
    if (!inside(s.dir, abs)) throw new Error("file_path escapes the skill directory");
    const parts = relative(s.dir, abs).split(sep);
    if (parts.some((p) => p.startsWith("."))) throw new Error("file_path parts may not start with '.' (hidden files are not linked)");
    if (parts.at(-1)!.toLowerCase() === "skill.md") throw new Error("SKILL.md is not a linked file; use create/edit (or propose)");
    // No symlinks on the way, and no nested skill owning the path.
    let d = s.dir;
    for (const p of parts) {
      d = join(d, p);
      if (!existsSync(d)) break;
      if (lstatSync(d).isSymbolicLink()) throw new Error(`file_path goes through a symlink: ${relative(s.dir, d)}`);
      if (d !== abs && existsSync(join(d, "SKILL.md"))) throw new Error(`file_path is inside the nested skill at ${relative(s.dir, d)}`);
    }
    return abs;
  }

  writeFile(name: string, file: string, content: string): { path: string; replaced: TrashEntry | null } {
    const s = this.managed(name);
    const abs = this.linked(s, file);
    let replaced: TrashEntry | null = null;
    if (existsSync(abs)) {
      if (!statSync(abs).isFile()) throw new Error(`${file} is a directory`);
      if (readFileSync(abs, "utf8") === content) return { path: abs, replaced };
      replaced = this.toTrash({ kind: "file", skill: name, file: relative(s.dir, abs), from: abs, reason: "replaced" });
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { path: abs, replaced };
  }

  deleteFile(name: string, file: string): TrashEntry {
    const s = this.managed(name);
    const abs = this.linked(s, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`no such linked file: ${file}`);
    return this.toTrash({ kind: "file", skill: name, file: relative(s.dir, abs), from: abs, reason: "deleted" });
  }

  trash(): TrashEntry[] {
    if (!existsSync(this.trashDir)) return [];
    const out: TrashEntry[] = [];
    for (const id of readdirSync(this.trashDir)) {
      try { out.push(JSON.parse(readFileSync(join(this.trashDir, id, "meta.json"), "utf8"))); } catch { /* partial entry */ }
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Move a trashed skill or file back. Refuses to overwrite: delete what is there first (that is recoverable too). */
  restore(id: string): TrashEntry {
    const e = this.trash().find((x) => x.id === id);
    if (!e) throw new Error(`no trash entry "${id}"`);
    const from = resolve(e.from);
    if (!this.imp.isManaged(from)) throw new Error(`trash entry points outside the managed dir: ${from}`);
    if (existsSync(from)) throw new Error(`${from} exists; delete it first (it goes to the trash) or edit it`);
    if (e.kind === "skill") {
      const other = this.find(e.skill);
      if (other && this.imp.isManaged(other.dir)) throw new Error(`a managed skill "${e.skill}" exists at ${other.path}; delete it first`);
    } else {
      const s = this.find(e.skill);
      if (!s || !this.imp.isManaged(s.dir) || !inside(s.dir, from)) throw new Error(`skill "${e.skill}" no longer exists at the file's location; restore the skill first`);
    }
    mkdirSync(dirname(from), { recursive: true });
    move(join(this.trashDir, id, "payload"), from);
    rmSync(join(this.trashDir, id), { recursive: true, force: true });
    return e;
  }

  private toTrash(e: Omit<TrashEntry, "id" | "deletedAt">): TrashEntry {
    const entry: TrashEntry = { ...e, id: `${Date.now()}-${Buffer.from(crypto.getRandomValues(new Uint8Array(3))).toString("hex")}-${e.skill}`, deletedAt: Date.now() };
    const d = join(this.trashDir, entry.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "meta.json"), JSON.stringify(entry, null, 2));
    move(e.from, join(d, "payload"));
    return entry;
  }
}

function move(from: string, to: string) {
  try { renameSync(from, to); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
const trashLine = (e: TrashEntry) =>
  `- ${e.id}: ${e.kind} ${e.skill}${e.file ? `/${e.file}` : ""} (${e.reason} ${new Date(e.deletedAt).toISOString()})`;

/** Tool: skill_manage (list, create, edit, propose, rollback, delete, write_file, delete_file, restore). */
export function createSkillManageExtension(mgr: SkillManager, imp: SkillImprover, o: ProposeOptions = {}) {
  const named = Object.keys(o.benchmarks ?? {});
  const manage = defineTool({
    name: "skill_manage",
    description:
      "List and change skills. list: all skills with source and write authority (managed skills can change; external ones are read-only); include_deleted adds restorable trash entries. " +
      "create: new skill from full SKILL.md content. edit: replace SKILL.md (content) or one exact old_text with new_text. create/edit are linted only and back up the previous SKILL.md. " +
      "propose: create or update a skill (full SKILL.md) gated by a benchmark: it is linted, scored, and installed only if it does not regress; " +
      "benchmark (named: " + (named.join(", ") || "none registered") + "), benchmark_command (shell, exit 0 = pass, $SKILL_PATH = candidate), or must_contain phrases; dry_run checks without installing. " +
      "rollback: restore a backed-up SKILL.md version (default: latest). " +
      "delete: move the skill to the trash. write_file / delete_file: a linked file (file_path relative to the skill dir); a replaced or deleted file goes to the trash. " +
      "restore: bring a trash entry back by id (see list include_deleted).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("edit"), Type.Literal("propose"), Type.Literal("rollback"), Type.Literal("delete"), Type.Literal("write_file"), Type.Literal("delete_file"), Type.Literal("restore")]),
      name: Type.Optional(Type.String({ description: "Skill name (all actions except list and restore)." })),
      content: Type.Optional(Type.String({ description: "create/edit/propose: full SKILL.md including frontmatter. write_file: file content." })),
      old_text: Type.Optional(Type.String({ description: "edit: exact text in SKILL.md to replace (must match once)." })),
      new_text: Type.Optional(Type.String({ description: "edit: replacement for old_text." })),
      file_path: Type.Optional(Type.String({ description: "write_file/delete_file: path relative to the skill directory." })),
      id: Type.Optional(Type.String({ description: "restore: trash entry id." })),
      include_deleted: Type.Optional(Type.Boolean({ description: "list: also list restorable trash entries." })),
      benchmark: Type.Optional(Type.String({ description: "propose: named benchmark." })),
      benchmark_command: Type.Optional(Type.String({ description: "propose: shell benchmark, exit 0 = pass." })),
      must_contain: Type.Optional(Type.Array(Type.String(), { description: "propose: phrases the skill must keep." })),
      dry_run: Type.Optional(Type.Boolean({ description: "propose: check without installing." })),
      version: Type.Optional(Type.Number({ description: "rollback: version to restore (default: latest backup)." })),
    }),
    replay: "unsafe",
    async execute(a) {
      try {
        const need = (v: string | undefined, what: string): string => { if (v === undefined || v === "") throw new Error(`${a.action} needs ${what}`); return v; };
        const proposal = (r: ProposalResult) => ({ ...text(JSON.stringify(r, null, 2), !r.applied && r.reason !== "no change"), details: r as unknown as undefined });
        switch (a.action) {
          case "list": {
            const skills = mgr.list();
            let out = skills.length
              ? skills.map((s) => `- ${s.name} [${s.managed ? "managed" : "external, read-only"}] ${s.files} linked file(s): ${s.description}\n  ${s.path}`).join("\n")
              : "No skills.";
            const trash = a.include_deleted ? mgr.trash() : [];
            if (a.include_deleted) out += `\n\nDeleted (restorable):\n${trash.map(trashLine).join("\n") || "(none)"}`;
            return { ...text(out), details: { skills, ...(a.include_deleted ? { trash } : {}) } as unknown as undefined };
          }
          case "create": return proposal(await mgr.create(need(a.name, "name"), need(a.content, "content")));
          case "edit": return proposal(await mgr.edit(need(a.name, "name"), a));
          case "propose": {
            const r = await imp.propose(need(a.name, "name"), need(a.content, "content"), proposeBenchmark(o, a), a.dry_run ?? false);
            return { ...text(JSON.stringify(r, null, 2), !r.applied && r.reason !== "no change" && !r.reason.startsWith("verified (dry")), details: r as unknown as undefined };
          }
          case "rollback": {
            const name = need(a.name, "name");
            try { return text(`Restored ${name} to v${imp.rollback(name, a.version)}`); }
            catch (e) { return text(`${(e as Error).message}. Versions: ${imp.versions(name).join(", ") || "none"}`, true); }
          }
          case "delete": { const e = mgr.deleteSkill(need(a.name, "name")); return text(`Deleted skill ${e.skill}; restore with id ${e.id}`); }
          case "write_file": {
            const r = mgr.writeFile(need(a.name, "name"), need(a.file_path, "file_path"), a.content ?? need(a.content, "content"));
            return text(`Wrote ${r.path}` + (r.replaced ? `; previous version in trash as ${r.replaced.id}` : ""));
          }
          case "delete_file": { const e = mgr.deleteFile(need(a.name, "name"), need(a.file_path, "file_path")); return text(`Deleted ${e.skill}/${e.file}; restore with id ${e.id}`); }
          case "restore": { const e = mgr.restore(need(a.id, "id")); return text(`Restored ${e.kind} ${e.skill}${e.file ? `/${e.file}` : ""} to ${e.from}`); }
        }
      } catch (e) { return text((e as Error).message, true); }
    },
  });
  return defineExtension({ name: "skill-manage", tools: [manage] });
}
