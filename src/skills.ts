// Skills loader extension: scans SKILL.md files (frontmatter + instructions + linked files),
// advertises them in a system prompt section, and mounts one on demand via the `skill_view` tool.
// A skill's `tools:` frontmatter names deferred tools that get added to the model's tool registry on load.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export interface Skill {
  name: string;
  description: string;
  /** Tool names (deferred tools of other extensions) to mount when the skill is loaded. */
  tools: string[];
  body: string;
  /** Absolute path of SKILL.md. */
  path: string;
  dir: string;
  frontmatter: Record<string, string | string[]>;
}

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/s, "$2");

/** Parse `---` frontmatter (flat YAML subset: scalars, inline [a, b] lists, `- item` lists). */
export function parseFrontmatter(src: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  // Block scalar (`key: >` folded or `key: |` literal): indented lines that follow belong to it.
  let block: { key: string; fold: boolean; lines: string[] } | undefined;
  const endBlock = () => {
    if (!block) return;
    const ls = block.lines.map((l) => l.trim());
    data[block.key] = (block.fold ? ls.join(" ").replace(/\s+/g, " ") : ls.join("\n")).trim();
    block = undefined;
  };
  for (const line of m[1]!.split(/\r?\n/)) {
    if (block) {
      if (/^\s+\S/.test(line) || line.trim() === "") { block.lines.push(line); continue; }
      endBlock();
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    const val = raw!.trim();
    if (/^[>|][+-]?$/.test(val)) {
      block = { key: key!, fold: val.startsWith(">"), lines: [] };
      listKey = undefined;
    } else if (val === "") {
      data[key!] = [];
      listKey = key;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      data[key!] = val.slice(1, -1).split(",").map(unquote).filter(Boolean);
      listKey = undefined;
    } else {
      data[key!] = unquote(val);
      listKey = undefined;
    }
  }
  endBlock();
  return { data, body: m[2]! };
}

const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

function walk(dir: string, depth: number, out: string[]) {
  if (depth < 0) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out);
    else if (e.name === "SKILL.md") out.push(p);
  }
}

/** Scan directories for SKILL.md files. Earlier dirs win on duplicate names. Broken skills are skipped. */
export function scanSkills(dirs: readonly string[], maxDepth = 4): Skill[] {
  const found = new Map<string, Skill>();
  for (const root of dirs) {
    const files: string[] = [];
    walk(resolve(root), maxDepth, files);
    for (const path of files.sort()) {
      let src: string;
      try { src = readFileSync(path, "utf8"); } catch { continue; }
      const { data, body } = parseFrontmatter(src);
      const dir = dirname(path);
      const name = typeof data.name === "string" && data.name ? data.name : dir.split(sep).pop()!;
      const description = typeof data.description === "string" ? data.description : "";
      if (found.has(name)) continue;
      found.set(name, { name, description, tools: asList(data.tools), body: body.trim(), path, dir, frontmatter: data });
    }
  }
  return [...found.values()];
}

/** Files linked from a skill: everything under its directory except SKILL.md, relative paths. */
export function linkedFiles(skill: Skill, limit = 200): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (p !== skill.path) out.push(relative(skill.dir, p));
    }
  };
  try { rec(skill.dir); } catch { /* unreadable dir */ }
  return out.sort();
}

export interface SkillsOptions {
  /** Directories scanned (recursively) for SKILL.md. Rescanned on every use, so edits apply live. */
  dirs: readonly string[];
  /** Skill names to hide, read on every use. */
  disabled?: () => readonly string[];
  /** Max bytes of a linked file returned. Default 100k. */
  maxFileBytes?: number;
}

const catalog = (skills: Skill[]) =>
  skills.length === 0
    ? undefined
    : "Skills are reusable instructions. When a task matches one, load it with the `skill_view` tool " +
      "(name, optionally file_path for a linked file) before acting.\n" +
      skills.map((s) => `- ${s.name}: ${s.description}`.trimEnd()).join("\n");

export function createSkillsExtension(opts: SkillsOptions) {
  const max = opts.maxFileBytes ?? 100_000;
  const active = () => { const off = new Set(opts.disabled?.() ?? []); return scanSkills(opts.dirs).filter((s) => !off.has(s.name)); };
  const skillView = defineTool({
    name: "skill_view",
    description:
      "Load a skill by name: returns its instructions and the list of linked files. " +
      "Pass file_path (relative to the skill) to read a linked file instead. Loading a skill may also enable its tools within the conversation tool limits.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from the skills list." }),
      file_path: Type.Optional(Type.String({ description: "Linked file, relative to the skill directory." })),
    }),
    replay: "safe",
    async execute({ name, file_path }) {
      const skills = active();
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return {
          isError: true,
          output: [{ type: "text", text: `Unknown skill "${name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}` }],
        };
      }
      if (file_path !== undefined) {
        const abs = resolve(skill.dir, file_path);
        if (abs !== skill.dir && !abs.startsWith(skill.dir + sep)) {
          return { isError: true, output: [{ type: "text", text: "file_path escapes the skill directory" }] };
        }
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          return { isError: true, output: [{ type: "text", text: `No such linked file: ${file_path}` }] };
        }
        const buf = readFileSync(abs);
        const text = buf.subarray(0, max).toString("utf8") + (buf.length > max ? `\n[truncated at ${max} bytes]` : "");
        return { output: [{ type: "text", text }] };
      }
      const files = linkedFiles(skill);
      const text =
        `# Skill: ${skill.name}\n\n${skill.body}\n` +
        (files.length ? `\n## Linked files (read with skill_view file_path)\n${files.map((f) => `- ${f}`).join("\n")}\n` : "") +
        (skill.tools.length ? `\n## Tools requested (subject to conversation tool limits)\n${skill.tools.map((t) => `- ${t}`).join("\n")}\n` : "");
      return {
        output: [{ type: "text", text }],
        details: { skill: skill.name, files, tools: skill.tools },
        ...(skill.tools.length ? { control: { addTools: skill.tools } } : {}),
      };
    },
  });

  return defineExtension({
    name: "skills",
    tools: [skillView],
    sections: [section("skills", () => catalog(active()))],
  });
}
