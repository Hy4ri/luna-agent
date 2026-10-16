// Self-improvement engine: inspect past run logs -> extract lessons -> draft/update skills -> verify with a
// benchmark before applying. Unverified or regressing drafts are never installed; every applied change keeps a
// backup so it can be rolled back. Skills are plain SKILL.md files, so the skills extension picks edits up live.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { parseFrontmatter, scanSkills } from "./skills.js";

export interface RunRecord { id: number; source: string; label: string; status: "ok" | "error" | "running"; startedAt: number; text: string }
/** Anything that can list past runs (cron.db, an app log, ...). */
export interface RunLogSource { name: string; recent(limit: number): RunRecord[] }

/** Reads the scheduler's cron.db runs table (read-only). */
export function cronRunSource(path: string): RunLogSource {
  return {
    name: "cron",
    recent(limit) {
      if (!existsSync(path)) return [];
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT r.id, r.status, r.started_at, r.output, r.error, j.name AS job FROM runs r JOIN jobs j ON j.id = r.job_id ORDER BY r.id DESC LIMIT ?",
        ).all(limit) as any[];
        return rows.map((r) => ({ id: r.id, source: "cron", label: r.job, status: r.status, startedAt: r.started_at, text: String(r.error ?? r.output ?? "") }));
      } finally { db.close(); }
    },
  };
}

export interface Lesson { signature: string; count: number; labels: string[]; example: string; runIds: number[] }

/** Collapse volatile parts (numbers, ids, paths, quoted strings) so repeats of one failure share a signature. */
export function signature(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first.replace(/(["'`]).*?\1/g, "<s>").replace(/\/[\w./-]+/g, "<path>").replace(/\b[0-9a-f]{8,}\b/gi, "<id>").replace(/\d+/g, "<n>").trim().slice(0, 160);
}

/** Group failed runs by signature; patterns seen `minCount`+ times are lessons worth acting on. */
export function extractLessons(runs: RunRecord[], minCount = 2): Lesson[] {
  const m = new Map<string, Lesson>();
  for (const r of runs) {
    if (r.status !== "error") continue;
    const sig = signature(r.text) || "(empty error)";
    const l = m.get(sig) ?? { signature: sig, count: 0, labels: [], example: r.text.slice(0, 400), runIds: [] };
    l.count++; l.runIds.push(r.id);
    if (!l.labels.includes(r.label)) l.labels.push(r.label);
    m.set(sig, l);
  }
  return [...m.values()].filter((l) => l.count >= minCount).sort((a, b) => b.count - a.count);
}

export interface BenchResult { score: number; detail: string }
/** A benchmark scores skill content in [0,1]. `path` is a temp copy of the candidate SKILL.md. */
export type Benchmark = (content: string, path: string) => BenchResult | Promise<BenchResult>;

/** Structural checks every skill must pass. Returns problems (empty = ok). */
export function lintSkill(content: string, expectedName: string): string[] {
  const { data, body } = parseFrontmatter(content);
  const p: string[] = [];
  if (data.name !== expectedName) p.push(`frontmatter name must be "${expectedName}"`);
  if (typeof data.description !== "string" || data.description.trim().length < 10) p.push("description missing or too short (<10 chars)");
  if (typeof data.description === "string" && data.description.length > 300) p.push("description too long (>300 chars); it is shown in every prompt");
  if (body.trim().length < 20) p.push("body is empty");
  if (content.length > 20_000) p.push("skill larger than 20k chars; move detail to linked files");
  return p;
}

/** Benchmark from a shell command: exit 0 = score 1, otherwise 0. SKILL_PATH points at the candidate. */
export function commandBenchmark(command: string, timeoutMs = 60_000): Benchmark {
  return (_c, path) => {
    const r = spawnSync("sh", ["-c", command], { env: { ...process.env, SKILL_PATH: path }, encoding: "utf8", timeout: timeoutMs });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-500);
    return { score: r.status === 0 ? 1 : 0, detail: `exit ${r.status ?? r.signal}${out ? `: ${out}` : ""}` };
  };
}

/** Benchmark that requires phrases in the skill (cheap regression guard for lessons that must be kept). */
export function containsBenchmark(phrases: string[]): Benchmark {
  return (content) => {
    const missing = phrases.filter((p) => !content.toLowerCase().includes(p.toLowerCase()));
    return { score: (phrases.length - missing.length) / (phrases.length || 1), detail: missing.length ? `missing: ${missing.join("; ")}` : "all phrases present" };
  };
}

export interface ProposalResult {
  applied: boolean;
  skill: string;
  created: boolean;
  lint: string[];
  baseline: BenchResult | null;
  candidate: BenchResult | null;
  reason: string;
  version: number | null;
}

export interface ImproverOptions {
  /** Directory where skills are written (must be one of the dirs the skills extension scans). */
  skillsDir: string;
  sources?: RunLogSource[];
  /** Backups of replaced skill versions; default <skillsDir>/.history (dot dirs are ignored by the scanner). */
  historyDir?: string;
  /** Named benchmarks the model may reference by name. */
  benchmarks?: Record<string, Benchmark>;
  /** Allow the model to supply a shell command as benchmark. Default true. */
  allowCommandBenchmarks?: boolean;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SkillImprover {
  readonly skillsDir: string;
  readonly historyDir: string;
  constructor(private o: ImproverOptions) {
    this.skillsDir = resolve(o.skillsDir);
    this.historyDir = resolve(o.historyDir ?? join(this.skillsDir, ".history"));
  }

  inspectRuns(opts: { limit?: number; status?: "ok" | "error" } = {}): RunRecord[] {
    const out = (this.o.sources ?? []).flatMap((s) => s.recent(opts.limit ?? 50));
    return out.filter((r) => !opts.status || r.status === opts.status).sort((a, b) => b.startedAt - a.startedAt).slice(0, opts.limit ?? 50);
  }

  lessons(opts: { limit?: number; minCount?: number } = {}): Lesson[] {
    return extractLessons(this.inspectRuns({ limit: opts.limit ?? 200 }), opts.minCount ?? 2);
  }

  private skillPath(name: string) {
    if (!NAME.test(name)) throw new Error(`invalid skill name "${name}" (lowercase letters, digits, - _)`);
    return join(this.skillsDir, name, "SKILL.md");
  }

  versions(name: string): number[] {
    const d = join(this.historyDir, name);
    if (!existsSync(d)) return [];
    return readdirSync(d).map((f) => /^v(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  }

  /**
   * Verify a new/updated skill and install it only if it lints and does not regress against the current version.
   * With no benchmark only lint gates (reported in `reason`). `dryRun` verifies without writing.
   */
  async propose(name: string, content: string, bench?: Benchmark, dryRun = false): Promise<ProposalResult> {
    const target = this.skillPath(name);
    const created = !existsSync(target);
    const res: ProposalResult = { applied: false, skill: name, created, lint: [], baseline: null, candidate: null, reason: "", version: null };
    res.lint = lintSkill(content, name);
    if (res.lint.length) { res.reason = "lint failed"; return res; }

    const tmp = join(this.historyDir, ".tmp", `${name}-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      if (bench) {
        const cand = join(tmp, "candidate.md");
        writeFileSync(cand, content);
        res.candidate = await bench(content, cand);
        if (!created) {
          const old = readFileSync(target, "utf8");
          const oldp = join(tmp, "baseline.md");
          writeFileSync(oldp, old);
          res.baseline = await bench(old, oldp);
        }
        const base = res.baseline?.score ?? 0;
        if (res.candidate.score < base) { res.reason = `regression: ${res.candidate.score} < baseline ${base}`; return res; }
        if (res.candidate.score <= 0) { res.reason = `candidate failed benchmark: ${res.candidate.detail}`; return res; }
      }
      if (!created && readFileSync(target, "utf8") === content) { res.reason = "no change"; return res; }
      if (dryRun) { res.reason = "verified (dry run, not written)"; return res; }
      if (!created) {
        const v = (this.versions(name).at(-1) ?? 0) + 1;
        mkdirSync(join(this.historyDir, name), { recursive: true });
        cpSync(target, join(this.historyDir, name, `v${v}.md`));
        res.version = v;
      }
      mkdirSync(join(this.skillsDir, name), { recursive: true });
      writeFileSync(target, content);
      res.applied = true;
      res.reason = bench ? "verified and applied" : "applied (lint only, no benchmark supplied)";
      return res;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  /** Restore a backed-up version (default: the latest). The current content is itself backed up first. */
  rollback(name: string, version?: number): number {
    const vs = this.versions(name);
    const v = version ?? vs.at(-1);
    if (v === undefined || !vs.includes(v)) throw new Error(`no such version for ${name}`);
    const target = this.skillPath(name);
    const next = (vs.at(-1) ?? 0) + 1;
    if (existsSync(target)) cpSync(target, join(this.historyDir, name, `v${next}.md`));
    cpSync(join(this.historyDir, name, `v${v}.md`), target);
    return v;
  }
}

const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** Tools: inspect_runs, extract_lessons, skill_propose, skill_rollback. */
export function createImproveExtension(imp: SkillImprover, o: Pick<ImproverOptions, "benchmarks" | "allowCommandBenchmarks"> = {}) {
  const named = o.benchmarks ?? {};
  const allowCmd = o.allowCommandBenchmarks ?? true;
  const inspect = defineTool({
    name: "inspect_runs",
    description: "List recent past runs (scheduled jobs etc.) with status and error/output text, newest first.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max runs (default 20)." })),
      status: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("error")])),
    }),
    replay: "safe",
    async execute({ limit, status }) {
      const runs = imp.inspectRuns({ limit: limit ?? 20, ...(status ? { status } : {}) });
      return text(runs.length ? runs.map((r) => `#${r.id} [${r.source}/${r.label}] ${r.status}: ${r.text.slice(0, 200).replace(/\s+/g, " ")}`).join("\n") : "No runs recorded.");
    },
  });
  const lessons = defineTool({
    name: "extract_lessons",
    description: "Group recent failed runs by normalized error signature and return recurring patterns (count, affected jobs, example). Use these to decide which skill to draft or update.",
    parameters: Type.Object({ min_count: Type.Optional(Type.Number({ description: "Minimum occurrences (default 2)." })) }),
    replay: "safe",
    async execute({ min_count }) {
      const ls = imp.lessons({ minCount: min_count ?? 2 });
      return text(ls.length ? ls.map((l, i) => `${i + 1}. x${l.count} ${l.signature}\n   jobs: ${l.labels.join(", ")}\n   example: ${l.example.replace(/\s+/g, " ")}`).join("\n") : "No recurring failure patterns.");
    },
  });
  const propose = defineTool({
    name: "skill_propose",
    description:
      "Create or update a skill (full SKILL.md text with name/description frontmatter). It is linted and verified against a benchmark and only installed if it does not regress; " +
      "the previous version is backed up. Benchmark: `benchmark` (named: " + (Object.keys(named).join(", ") || "none registered") + "), `benchmark_command` (shell, exit 0 = pass, $SKILL_PATH = candidate), or `must_contain` phrases.",
    parameters: Type.Object({
      name: Type.String(),
      content: Type.String({ description: "Complete SKILL.md including frontmatter." }),
      benchmark: Type.Optional(Type.String()),
      benchmark_command: Type.Optional(Type.String()),
      must_contain: Type.Optional(Type.Array(Type.String())),
      dry_run: Type.Optional(Type.Boolean()),
    }),
    replay: "unsafe",
    async execute(a) {
      let bench: Benchmark | undefined;
      if (a.benchmark) {
        bench = named[a.benchmark];
        if (!bench) return text(`Unknown benchmark "${a.benchmark}". Registered: ${Object.keys(named).join(", ") || "none"}`, true);
      } else if (a.benchmark_command) {
        if (!allowCmd) return text("benchmark_command is disabled", true);
        bench = commandBenchmark(a.benchmark_command);
      } else if (a.must_contain?.length) bench = containsBenchmark(a.must_contain);
      try {
        const r = await imp.propose(a.name, a.content, bench, a.dry_run ?? false);
        return { ...text(JSON.stringify(r, null, 2), !r.applied && r.reason !== "no change" && !r.reason.startsWith("verified (dry")), details: r as unknown as undefined };
      } catch (e) { return text(String((e as Error).message), true); }
    },
  });
  const rollback = defineTool({
    name: "skill_rollback",
    description: "Restore a previous version of a skill (default: latest backup). Lists available versions on failure.",
    parameters: Type.Object({ name: Type.String(), version: Type.Optional(Type.Number()) }),
    replay: "unsafe",
    async execute({ name, version }) {
      try { return text(`Restored ${name} to v${imp.rollback(name, version)}`); }
      catch (e) { return text(`${(e as Error).message}. Versions: ${imp.versions(name).join(", ") || "none"}`, true); }
    },
  });
  return defineExtension({ name: "improve", tools: [inspect, lessons, propose, rollback] });
}

export { scanSkills };
