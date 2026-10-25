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
  local: { name: string; upstream: string; ahead: number; behind: number }[];
  remote: string[];
};

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
};

function queryParams(selector: SelectorParams): string {
  const params = new URLSearchParams();
  if (selector.session) params.set("session", selector.session);
  if (selector.project !== undefined) params.set("project", String(selector.project));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchChanges(selector: SelectorParams): Promise<Changes> {
  const res = await json<Changes>(`/v1/git/changes${queryParams(selector)}`);
  return res;
}

export async function fetchBranches(selector: SelectorParams): Promise<Branches> {
  const res = await json<Branches>(`/v1/git/branches${queryParams(selector)}`);
  return res;
}

export async function fetchDiff(selector: SelectorParams, path: string, staged: boolean): Promise<DiffResult> {
  const params = new URLSearchParams();
  if (selector.session) params.set("session", selector.session);
  if (selector.project !== undefined) params.set("project", String(selector.project));
  params.set("path", path);
  params.set("staged", staged ? "1" : "0");
  const res = await json<DiffResult>(`/v1/git/diff?${params.toString()}`);
  return res;
}

export async function mutateGit(
  selector: SelectorParams,
  action: string,
  body: Record<string, unknown>
): Promise<GitMutationResult> {
  return post<GitMutationResult>(`/v1/git/${action}${queryParams(selector)}`, body);
}
