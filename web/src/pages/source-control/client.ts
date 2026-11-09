import { json, post } from "@/lib/api";

export type ChangeFile = {
  path: string;
  original?: string;
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
  conflict: boolean;
};

export type Changes = {
  cwd: string;
  machine: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  headOid: string | null;
  detached: boolean;
  unborn: boolean;
  files: ChangeFile[];
  untrackedCollapsed: boolean;
  repo: string | null;
  busy: boolean;
};

export type Branches = {
  current: string;
  local: { name: string; upstream: string; ahead: number; behind: number; date: string; subject: string }[];
  remote: string[];
  default: string | null;
};

export type LogCommit = { oid: string; parents: string[]; author: string; email: string; date: string; refs: string[]; subject: string };
/** A changed file. patch: inline diff text (GitHub); null when GitHub omits it; absent when loaded on demand. */
export type FileStat = { path: string; original?: string; status: string; additions: number; deletions: number; binary?: boolean; patch?: string | null };
export type CommitDetail = Omit<LogCommit, "subject"> & { message: string; committer: string; committerDate: string; base: string; files: FileStat[]; filesTruncated: boolean };
export type Compare = { base: string; head: string; mergeBase: string; ahead: number; behind: number; commits: LogCommit[]; commitsTruncated: boolean; files: FileStat[]; filesTruncated: boolean };

export type DiffResult = {
  path: string;
  binary: boolean;
  directory: boolean;
  text: string;
  truncated: boolean;
};

export type GitMutationResult = {
  changes: Changes;
  summary: string;
  sha: string | null;
};

export type SelectorParams = {
  session?: string;
  project?: number;
  /** `main` or a worker id; only with `project`. Absent picks the main host, else the first online machine. */
  machine?: string;
};

function queryParams(selector: SelectorParams): string {
  const params = new URLSearchParams();
  if (selector.session) params.set("session", selector.session);
  if (selector.project !== undefined) params.set("project", String(selector.project));
  if (selector.machine) params.set("machine", selector.machine);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export async function fetchChanges(selector: SelectorParams, signal?: AbortSignal): Promise<Changes> {
  const res = await json<Changes>(`/v1/git/changes${queryParams(selector)}`, signal ? { signal } : undefined);
  return res;
}

export async function fetchBranches(selector: SelectorParams, signal?: AbortSignal): Promise<Branches> {
  const res = await json<Branches>(`/v1/git/branches${queryParams(selector)}`, signal ? { signal } : undefined);
  return res;
}

export async function fetchDiff(selector: SelectorParams, path: string, staged: boolean, signal?: AbortSignal): Promise<DiffResult> {
  const params = new URLSearchParams();
  if (selector.session) params.set("session", selector.session);
  if (selector.project !== undefined) params.set("project", String(selector.project));
  if (selector.machine) params.set("machine", selector.machine);
  params.set("path", path);
  params.set("staged", staged ? "1" : "0");
  const res = await json<DiffResult>(`/v1/git/diff?${params.toString()}`, signal ? { signal } : undefined);
  return res;
}

export async function mutateGit(
  selector: SelectorParams,
  action: string,
  body: Record<string, unknown>
): Promise<GitMutationResult> {
  return post<GitMutationResult>(`/v1/git/${action}${queryParams(selector)}`, body);
}

export type StashEntry = { index: number; date: string; subject: string };
export async function fetchStashes(selector: SelectorParams, signal?: AbortSignal): Promise<StashEntry[]> {
  return (await json<{ stashes: StashEntry[] }>(`/v1/git/stashes${queryParams(selector)}`, signal ? { signal } : undefined)).stashes;
}

/** One paid auxiliary-model call. Returns a draft only; nothing is committed. */
export async function draftCommitMessage(selector: SelectorParams): Promise<string> {
  return (await post<{ message: string }>(`/v1/git/commit-message${queryParams(selector)}`, {})).message;
}
export async function commitDraftAvailable(): Promise<boolean> {
  try { return (await json<{ available: boolean }>("/v1/git/commit-message")).available; } catch { return false; }
}

function withSelector(selector: SelectorParams, extra: Record<string, string>): string {
  const params = new URLSearchParams(queryParams(selector).slice(1));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

export function fetchLog(selector: SelectorParams, scope: "head" | "all", skip: number, limit = 100, signal?: AbortSignal): Promise<{ commits: LogCommit[]; more: boolean }> {
  return json(`/v1/git/log?${withSelector(selector, { scope, skip: String(skip), limit: String(limit) })}`, signal ? { signal } : undefined);
}

export function fetchCommit(selector: SelectorParams, oid: string, signal?: AbortSignal): Promise<CommitDetail> {
  return json(`/v1/git/commit?${withSelector(selector, { oid })}`, signal ? { signal } : undefined);
}

export function fetchCompare(selector: SelectorParams, base: string, head: string, signal?: AbortSignal): Promise<Compare> {
  return json(`/v1/git/compare?${withSelector(selector, { base, head })}`, signal ? { signal } : undefined);
}

export function fetchRangeDiff(selector: SelectorParams, base: string, head: string, file: FileStat, signal?: AbortSignal): Promise<DiffResult> {
  return json(`/v1/git/range-diff?${withSelector(selector, { base, head, path: file.path, ...(file.original ? { original: file.original } : {}) })}`, signal ? { signal } : undefined);
}
