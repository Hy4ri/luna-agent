// Self-improvement engine: inspect past run logs -> extract lessons -> draft/update skills -> verify with a
// benchmark before applying. Unverified or regressing drafts are never installed; every applied change keeps a
// backup so it can be rolled back. Skills are plain SKILL.md files, so the skills extension picks edits up live.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
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
      const db = new Database(path, { readonly: true });
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
    const r = Bun.spawnSync(["sh", "-c", command], {
      env: { ...process.env, SKILL_PATH: path },
      timeout: timeoutMs,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = r.stdout ? Buffer.from(r.stdout).toString("utf8") : "";
    const stderr = r.stderr ? Buffer.from(r.stderr).toString("utf8") : "";
    const out = `${stdout}${stderr}`.trim().slice(-500);
    const status = r.exitCode;
    const signal = r.signalCode;
    return { score: status === 0 ? 1 : 0, detail: `exit ${status ?? signal}${out ? `: ${out}` : ""}` };
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
  /** Allow the model to supply a shell command as benchmark. Default false: it runs arbitrary shell. */
  allowCommandBenchmarks?: boolean | (() => boolean);
  /** All skill dirs in scan order (default: skillsDir only), so `read` sees the skill that is actually active. */
  readDirs?: string[];
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

  /** True when `dir` is a skill directory inside the managed skills dir (never the managed root itself). */
  isManaged(dir: string) {
    return resolve(dir).startsWith(this.skillsDir + sep);
  }

  /**
   * SKILL.md path written for `name`: the active managed skill's own file (it may be nested, e.g. design/slides),
   * otherwise <skillsDir>/<name>/SKILL.md (a new skill, or a managed override of an external one).
   */
  skillPath(name: string) {
    if (!NAME.test(name)) throw new Error(`invalid skill name "${name}" (lowercase letters, digits, - _)`);
    const active = scanSkills(this.o.readDirs ?? [this.skillsDir]).find((x) => x.name === name);
    if (active && this.isManaged(active.dir)) return active.path;
    return join(this.skillsDir, name, "SKILL.md");
  }

  /** Current text of the active skill with this name (first match in scan order), or undefined. */
  read(name: string): string | undefined {
    const s = scanSkills(this.o.readDirs ?? [this.skillsDir]).find((x) => x.name === name);
    return s ? readFileSync(s.path, "utf8") : undefined;
  }

  description(content: string): string {
    const d = parseFrontmatter(content).data.description;
    return typeof d === "string" ? d.trim() : "";
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
      mkdirSync(dirname(target), { recursive: true });
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

/** Benchmark options for benchmark-gated skill changes (skill_manage action=propose). */
export type ProposeOptions = Pick<ImproverOptions, "benchmarks" | "allowCommandBenchmarks">;

/** Pick the benchmark a propose call asked for: a named one, a shell command (when allowed), or must_contain phrases. */
export function proposeBenchmark(o: ProposeOptions, a: { benchmark?: string; benchmark_command?: string; must_contain?: string[] }): Benchmark | undefined {
  const named = o.benchmarks ?? {};
  const allowCmd = typeof o.allowCommandBenchmarks === "function" ? o.allowCommandBenchmarks() : (o.allowCommandBenchmarks ?? false);
  if (a.benchmark) {
    const bench = named[a.benchmark];
    if (!bench) throw new Error(`Unknown benchmark "${a.benchmark}". Registered: ${Object.keys(named).join(", ") || "none"}`);
    return bench;
  }
  if (a.benchmark_command) {
    if (!allowCmd) throw new Error("benchmark_command is disabled");
    return commandBenchmark(a.benchmark_command);
  }
  return a.must_contain?.length ? containsBenchmark(a.must_contain) : undefined;
}

export { scanSkills };
