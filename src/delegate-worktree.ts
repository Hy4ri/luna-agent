// Persist allocation identity before git creates a branch or worktree. Never adopt or delete unrelated work.
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";

type Allocation = { repo: string; commonGitDir: string; branch: string; path: string; baseRef: string; baseCommit: string };
const Worktrees = defineDoc<{ allocations: Record<string, Allocation> }>({
  checkpointWhen: () => false, kind: "luna.delegate.worktrees", version: 1,
  scope: "conversation", history: "latest", fork: "initial", initial: () => ({ allocations: {} }),
});
async function git(context: Context, repo: string, ...args: string[]): Promise<string> {
  context.abortSignal?.throwIfAborted();
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => { try { proc.kill(); } catch {} };
  context.abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    context.abortSignal?.throwIfAborted();
    if (code !== 0) {
      const err = new Error(stderr.trim() || `git ${args[0] ?? ""} exited with code ${code}`) as Error & { code?: number; stderr?: string };
      err.code = code;
      err.stderr = stderr;
      throw err;
    }
    return stdout.replace(/\r?\n$/, "");
  } finally {
    context.abortSignal?.removeEventListener("abort", onAbort);
  }
}
async function branchExists(context: Context, repo: string, branch: string) {
  try { await git(context, repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`); return true; }
  catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
}
async function worktrees(context: Context, repo: string) {
  const entries: { path: string; branch?: string }[] = [];
  // NUL framing preserves newlines and non-ASCII paths without Git's quoting rules.
  for (const field of (await git(context, repo, "worktree", "list", "--porcelain", "-z")).split("\0")) {
    if (field.startsWith("worktree ")) entries.push({ path: field.slice(9) });
    else if (field.startsWith("branch ") && entries.length) entries.at(-1)!.branch = field.slice(7);
  }
  return entries;
}

export async function prepareDelegateWorktree(
  api: Pick<ToolExecutionApi, "taskId" | "conversationId" | "commit">,
  context: Context,
  options: { repo: string; branch: string; base?: string },
): Promise<string> {
  const repo = realpathSync(await git(context, options.repo, "rev-parse", "--show-toplevel"));
  const commonGitDir = realpathSync(await git(context, repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const branch = options.branch, baseRef = options.base ?? "HEAD", key = String(api.taskId);
  if (!branch || (await git(context, repo, "check-ref-format", "--branch", branch)) !== branch) throw new Error("Use a literal valid new branch name.");
  let allocation = await api.commit(async tx => {
    const prior = (await tx.doc(Worktrees, api.conversationId)).allocations[key];
    return prior ? JSON.parse(JSON.stringify(prior)) as Allocation : undefined;
  }, context);
  if (!allocation) {
    if (await branchExists(context, repo, branch)) throw new Error(`Branch '${branch}' already exists; no worktree was allocated.`);
    const remote = baseRef.includes("/") ? baseRef.split("/")[0]! : "";
    if (remote && (await git(context, repo, "remote")).split("\n").includes(remote)) await git(context, repo, "fetch", "--quiet", "--", remote);
    const baseCommit = await git(context, repo, "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`);
    const root = join(dirname(repo), ".luna-worktrees");
    mkdirSync(root, { recursive: true });
    const path = join(realpathSync(root), `${basename(repo)}-${api.conversationId}-${key}-${crypto.randomUUID()}`);
    const proposed: Allocation = { repo, commonGitDir, branch, path, baseRef, baseCommit };
    allocation = await api.commit(async tx => {
      const doc = await tx.doc(Worktrees, api.conversationId);
      if (!doc.allocations[key]) doc.allocations[key] = proposed;
      return JSON.parse(JSON.stringify(doc.allocations[key])) as Allocation;
    }, context);
  }
  if (allocation.repo !== repo || allocation.commonGitDir !== commonGitDir || allocation.branch !== branch || allocation.baseRef !== baseRef)
    throw new Error("Worktree allocation does not match this repository, branch, or base. Preserving the recorded allocation.");
  const recorded = allocation;
  const match = (await worktrees(context, repo)).find(entry => entry.path === recorded.path);
  if (match) {
    if (!existsSync(recorded.path) || realpathSync(recorded.path) !== recorded.path || match.branch !== `refs/heads/${branch}`)
      throw new Error(`Recorded worktree '${recorded.path}' is missing, moved, or on another branch. Preserving it.`);
    const actualCommon = realpathSync(await git(context, recorded.path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    if (actualCommon !== commonGitDir || await git(context, recorded.path, "symbolic-ref", "HEAD") !== `refs/heads/${branch}`)
      throw new Error(`Recorded worktree '${recorded.path}' has a different repository or branch identity. Preserving it.`);
    return recorded.path;
  }
  if (existsSync(recorded.path) || await branchExists(context, repo, branch))
    throw new Error(`Partial or conflicting allocation: '${branch}' / '${recorded.path}'. Work was preserved; inspect it before retrying.`);
  await git(context, repo, "worktree", "add", "-b", branch, recorded.path, recorded.baseCommit);
  return recorded.path;
}
