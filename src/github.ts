import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

const PASS = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
export class GhError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function env(): Record<string, string> {
  const out: Record<string, string> = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', LC_ALL: 'C' };
  for (const key of PASS) if (process.env[key] !== undefined) out[key] = process.env[key]!;
  return out;
}
let tokenPromise: Promise<string> | undefined;
function resetToken() { tokenPromise = undefined; }
function token(): Promise<string> {
  // gh auth token reads stored credentials, not GH_TOKEN/GITHUB_TOKEN overrides.
  const supplied = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (supplied) return Promise.resolve(supplied);
  if (!tokenPromise) {
    const pending = (async (): Promise<string> => {
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn(['gh', 'auth', 'token', '--hostname', 'github.com'], {
          env: env(),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (error) {
        const enoent = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
        throw new GhError(enoent ? 'gh is not installed' : 'Not logged in to GitHub; run gh auth login', enoent ? 503 : 502);
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch {}
      }, 10_000);
      try {
        const [stdout, code] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        if (timedOut) throw new GhError('GitHub login check timed out', 504);
        if (code !== 0 || !stdout.trim()) throw new GhError('Not logged in to GitHub; run gh auth login', 502);
        return stdout.trim();
      } finally {
        clearTimeout(timer);
      }
    })();
    tokenPromise = pending;
    void pending.catch(() => { if (tokenPromise === pending) resetToken(); });
  }
  return tokenPromise;
}
const MAX_RESPONSE = 8 << 20;
async function responseText(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) {
        await reader.cancel();
        throw new GhError('GitHub response exceeds the size limit', 502);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { reader.releaseLock(); }
}
/** Fixed-origin API transport. Only reads may refresh credentials and retry once. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; read?: boolean } = {}): Promise<T> {
  const url = new URL(path, 'https://api.github.com/');
  if (url.origin !== 'https://api.github.com') throw new GhError('Invalid GitHub API path', 400);
  const signal = AbortSignal.timeout(20_000);
  const read = init.read ?? (!init.method || init.method === 'GET');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: init.method ?? 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'luna-pi', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await responseText(res);
      if (res.status === 401) {
        resetToken();
        if (read && attempt === 0) continue;
        throw new GhError('Bad credentials; run gh auth login', 502);
      }
      if (!res.ok) {
        let message = `GitHub request failed (HTTP ${res.status})`;
        try { const parsed = JSON.parse(text); if (typeof parsed.message === 'string') message = parsed.message; } catch {}
        throw new GhError(message.slice(0, 300), [403, 404, 409, 422].includes(res.status) ? res.status : 502);
      }
      if (!text.trim()) return null as T;
      try { return JSON.parse(text) as T; } catch { throw new GhError('GitHub returned invalid JSON', 502); }
    }
  } catch (e) {
    if (e instanceof GhError) throw e;
    throw new GhError(signal.aborted ? 'GitHub request timed out' : 'GitHub request failed', signal.aborted ? 504 : 502);
  }
  throw new GhError('GitHub request failed', 502);
}
export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await api<{ data?: T; errors?: { message: string; type?: string }[] }>('graphql', { method: 'POST', body: { query, variables }, read: /^\s*(?:query\b|\{)/.test(query) });
  if (r?.errors?.length) {
    const error = r.errors[0]!;
    throw new GhError(error.message.slice(0, 300), error.type === 'NOT_FOUND' ? 404 : 422);
  }
  if (!r?.data) throw new GhError('GitHub GraphQL returned no data', 502);
  return r.data;
}

export const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export type Kind = "pr" | "issue";

export type GhStatus =
  | { state: "ok"; login: string }
  | { state: "missing" | "logged-out" | "error"; message: string };

export type RepoInfo = {
  repo: string;
  url: string;
  defaultBranch: string;
  permission: "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" | null;
  merge: { merge: boolean; squash: boolean; rebase: boolean };
  deleteBranchOnMerge: boolean;
};

export type ListItem = {
  kind: Kind;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  author: string | null;
  updatedAt: string;
  comments: number;
  labels: { name: string; color: string }[];
  checks: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
  review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
};

export type ItemPage = {
  total: number;
  items: ListItem[];
  next: string | null;
};

export type Comment = {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  url: string;
};

export type Check = {
  name: string;
  state: string;
  url: string | null;
};

export type Detail = {
  kind: Kind;
  id: string;
  number: number;
  title: string;
  state: ListItem["state"];
  url: string;
  author: string | null;
  createdAt: string;
  body: string;
  comments: Comment[];
  labels: { name: string; color: string }[];
  assignees: string[];
  commentTotal: number;
  commentsBefore: string | null;
  can: {
    comment: boolean;
    close: boolean;
    merge: boolean;
    deleteBranch: boolean;
    delete: boolean;
  };
  pr?: {
    draft: boolean;
    merged: boolean;
    base: string;
    head: string;
    headOid: string;
    headRepo: string | null;
    crossRepo: boolean;
    mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
    mergeState: string;
    review: ListItem["review"];
    checks: Check[];
    checkState: ListItem["checks"];
    reviews: { author: string | null; state: string; body: string; at: string }[];
    additions: number;
    deletions: number;
    files: number;
    branchExists: boolean;
  };
};

export async function ghStatus(): Promise<GhStatus> {
  try {
    const user = await api<{ login: string }>("user");
    if (user && user.login) {
      return { state: "ok", login: user.login };
    }
    return { state: "logged-out", message: "Not logged in to GitHub" };
  } catch (err) {
    if (err instanceof GhError) {
      if (err.status === 503) {
        return { state: "missing", message: err.message };
      }
      const msg = err.message.toLowerCase();
      if (err.status === 401 || msg.includes("bad credentials") || msg.includes("auth login") || msg.includes("unauthorized")) {
        return { state: "logged-out", message: err.message };
      }
      return { state: "error", message: err.message };
    }
    return { state: "error", message: String(err) };
  }
}

export function parseRemote(url: string | undefined | null): string | null {
  if (!url) return null;
  // Match https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), or ssh://git@github.com/owner/repo(.git)
  const httpsMatch = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (httpsMatch) return httpsMatch[1]!;
  const sshMatch = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (sshMatch) return sshMatch[1]!;
  return null;
}

type ProjectRepo = { repo: string; projects: { id: number; name: string }[] };
type DiscoveryProject = { id: number; name: string; cwd: string; workerDirs?: { worker: number; cwd: string }[] };
/** Reads a project directory's `origin` remote. `null` is the main host; a number is an execution machine. */
export type RemoteReader = (machine: number | null, cwd: string) => Promise<string | null>;

/** Read `origin` on the main host. */
export async function localOrigin(cwd: string): Promise<string | null> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(['git', '-C', cwd, 'remote', 'get-url', 'origin'], {
      env: env(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, 5000);
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (timedOut || code !== 0) return null;
    return parseRemote(stdout.trim());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The machine side of repository discovery. A real `WorkerHub` satisfies it. */
export interface OriginMachines {
  view(id: number): { online: boolean } | undefined;
  env(id: number, cwd: string | undefined): ExecutionEnv;
  reviewEnvironment(id: number): Record<string, string>;
}

/** Read `origin` on the main host or on the execution machine that holds the directory. */
export function createRemoteOrigin(hub?: OriginMachines): RemoteReader {
  return async (machine, cwd) => {
    if (machine === null) return localOrigin(cwd);
    if (!hub?.view(machine)?.online) return null;
    let commandEnv: Record<string, string>;
    try { commandEnv = hub.reviewEnvironment(machine); } catch { return null; }
    let out = "";
    const result = await hub.env(machine, cwd).exec(["git", "remote", "get-url", "origin"], {
      cwd, inheritEnv: false, timeout: 5,
      env: { ...commandEnv, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
      onOutput: (text, _c, info) => { if (info.stream === "stdout" && out.length < 4096) out += text.slice(0, 4096 - out.length); },
    }, BACKGROUND_CONTEXT);
    return result.ok && result.value.exitCode === 0 ? parseRemote(out.trim()) : null;
  };
}

let projectCache: { key: string; until: number; result: Promise<ProjectRepo[]> } | undefined;
/**
 * Map GitHub repositories to the projects that use them. A project is found through its main-host directory and through
 * every machine directory, so a project linked only to an execution machine still reaches its repository.
 * `key` must describe anything outside the project list that changes the answer, such as which machines are online.
 */
export function projectRepos(
  projects: DiscoveryProject[],
  options: { resolveRemote?: RemoteReader; key?: string } = {},
): Promise<ProjectRepo[]> {
  const resolveRemote = options.resolveRemote ?? ((_machine, cwd) => localOrigin(cwd));
  const valid = projects.map(p => ({
    project: p,
    dirs: [
      ...(p.cwd?.trim() ? [{ machine: null as number | null, cwd: p.cwd }] : []),
      ...(p.workerDirs ?? []).flatMap(d => d.cwd?.trim() ? [{ machine: d.worker as number | null, cwd: d.cwd }] : []),
    ],
  })).filter(e => e.dirs.length).sort((a, b) => a.project.id - b.project.id);
  const key = `${options.key ?? ''}|${JSON.stringify(valid)}`;
  if (projectCache?.key === key && projectCache.until > Date.now()) return projectCache.result;
  const entry = { key, until: Infinity, result: Promise.resolve<ProjectRepo[]>([]) };
  entry.result = (async () => {
    const remotes = new Array<string | null>(valid.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, valid.length) }, async () => {
      while (next < valid.length) {
        const i = next++, dirs = valid[i]!.dirs;
        for (const d of dirs) {
          const repo = await resolveRemote(d.machine, d.cwd).catch(() => null);
          if (repo) { remotes[i] = repo; break; }
        }
      }
    }));
    const grouped = new Map<string, ProjectRepo>();
    for (let i = 0; i < valid.length; i++) {
      const repo = remotes[i], p = valid[i]!.project;
      if (!repo) continue;
      const group = grouped.get(repo.toLowerCase()) ?? { repo, projects: [] };
      if (!group.projects.some(project => project.id === p.id)) group.projects.push({ id: p.id, name: p.name });
      grouped.set(repo.toLowerCase(), group);
    }
    return [...grouped.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  })().then(result => { entry.until = Date.now() + 30_000; return result; }, error => { if (projectCache === entry) projectCache = undefined; throw error; });
  projectCache = entry;
  return entry.result;
}

export type PullFile = { path: string; original?: string; status: string; additions: number; deletions: number; patch: string | null };
const PULL_FILE_STATUS: Record<string, string> = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'T', unchanged: 'M' };
/** One page (100) of a pull request's changed files. GitHub omits the patch of very large and binary files. */
export async function pullFiles(repo: string, number: number, page: number): Promise<{ files: PullFile[]; more: boolean }> {
  const rows = await api<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }[]>(
    `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
  return {
    files: rows.map(f => ({ path: f.filename, ...(f.previous_filename ? { original: f.previous_filename } : {}), status: PULL_FILE_STATUS[f.status] ?? 'M', additions: f.additions, deletions: f.deletions, patch: f.patch ?? null })),
    more: rows.length === 100 && page < 30,
  };
}
