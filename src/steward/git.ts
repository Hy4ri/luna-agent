// Git helpers for the worktree detector. They only touch `luna/s<id>` branches in repos Steward is given.
import { existsSync } from "node:fs";

export interface RawWorktree { path: string; branch: string; merged: boolean; dirty: boolean }
const run = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdin: "ignore", env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
export const sessionOfBranch = (branch: string): number | null => { const m = /^luna\/s(\d+)(?:-|$)/.exec(branch); return m ? Number(m[1]) : null; };

/** Session worktrees of the given repos. Merged means merged into the repo's default branch. */
export function listSessionWorktrees(repos: string[]): RawWorktree[] {
  const out: RawWorktree[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    if (!repo || !existsSync(repo)) continue;
    const top = run(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!top.ok || seen.has(top.out)) continue;
    seen.add(top.out);
    const head = run(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    const base = head.ok ? head.out : ["main", "master"].find(b => run(repo, "show-ref", "--verify", "--quiet", `refs/heads/${b}`).ok);
    if (!base) continue;
    const merged = new Set(run(repo, "branch", "--format=%(refname:short)", "--merged", base).out.split("\n"));
    let path = "";
    for (const f of run(repo, "worktree", "list", "--porcelain", "-z").out.split("\0")) {
      if (f.startsWith("worktree ")) path = f.slice(9);
      else if (f.startsWith("branch refs/heads/")) {
        const branch = f.slice(18);
        if (sessionOfBranch(branch) === null || !path) continue;
        out.push({ path, branch, merged: merged.has(branch), dirty: run(path, "status", "--porcelain").out !== "" });
      }
    }
  }
  return out;
}

/** Remove a clean worktree and delete its branch. `branch -d` refuses an unmerged branch, so no work is lost. */
export function removeSessionWorktree(path: string, branch: string): void {
  if (sessionOfBranch(branch) === null) throw new Error("not a session worktree");
  if (run(path, "status", "--porcelain").out !== "") throw new Error("the worktree has uncommitted changes");
  const common = run(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const rm = run(path, "worktree", "remove", path);
  if (!rm.ok) throw new Error(rm.err || "git worktree remove failed");
  const repo = common.out.replace(/\/\.git\/?$/, "");
  const del = run(repo, "branch", "-d", branch);
  if (!del.ok) throw new Error(`Removed the worktree, but the branch stays: ${del.err}`);
}
