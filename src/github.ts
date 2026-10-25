import { execFile } from "node:child_process";

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
    const pending = new Promise<string>((resolve, reject) => {
      execFile('gh', ['auth', 'token', '--hostname', 'github.com'], { env: env(), timeout: 10_000, maxBuffer: 64 << 10 }, (error, stdout) => {
        if (error) return reject(new GhError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh is not installed' : error.killed ? 'GitHub login check timed out' : 'Not logged in to GitHub; run gh auth login', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 503 : error.killed ? 504 : 502));
        if (!stdout.trim()) return reject(new GhError('Not logged in to GitHub; run gh auth login', 502));
        resolve(stdout.trim());
      });
    });
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
let projectCache: { key: string; until: number; result: Promise<ProjectRepo[]> } | undefined;
export function projectRepos(projects: { id: number; name: string; cwd: string }[]): Promise<ProjectRepo[]> {
  const valid = projects.filter(p => p.id > 0 && p.cwd?.trim()).sort((a, b) => a.id - b.id);
  const key = JSON.stringify(valid);
  if (projectCache?.key === key && projectCache.until > Date.now()) return projectCache.result;
  const entry = { key, until: Infinity, result: Promise.resolve<ProjectRepo[]>([]) };
  entry.result = (async () => {
    const remotes = new Array<string | null>(valid.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, valid.length) }, async () => {
      while (next < valid.length) {
        const i = next++, p = valid[i]!;
        remotes[i] = await new Promise<string | null>(resolve => {
          execFile('git', ['-C', p.cwd, 'remote', 'get-url', 'origin'], { env: env(), timeout: 5000 }, (error, stdout) => resolve(error ? null : parseRemote(stdout.trim())));
        });
      }
    }));
    const grouped = new Map<string, ProjectRepo>();
    for (let i = 0; i < valid.length; i++) {
      const repo = remotes[i], p = valid[i]!;
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
