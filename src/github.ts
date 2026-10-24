import { execFile, type ExecException } from "node:child_process";

const PASS = ["PATH", "HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_TOKEN", "GH_HOST"] as const;

export class GhError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function env(): Record<string, string> {
  const out: Record<string, string> = {
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    LC_ALL: "C",
  };
  for (const k of PASS) {
    if (process.env[k] !== undefined) {
      out[k] = process.env[k]!;
    }
  }
  return out;
}

function failure(error: ExecException & { killed?: boolean }, stderr: string): GhError {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new GhError("gh is not installed", 503);
  }
  if (error.killed) {
    return new GhError("GitHub request timed out", 504);
  }
  const line = stderr.split("\n").find((l) => l.trim()) ?? "GitHub request failed";
  const codeMatch = /\(HTTP (\d{3})\)/.exec(stderr);
  const code = codeMatch ? Number(codeMatch[1]) : NaN;
  // Fix runner mapping HTTP 401 to 502 (existing code incorrectly mapped to 401; web api always logs out on ANY 401)
  let status = 502;
  if ([403, 404, 409, 422].includes(code)) {
    status = code;
  }
  const cleanMessage = line.replace(/^gh:\s*/, "").slice(0, 300);
  return new GhError(cleanMessage, status);
}

/** Runs `gh <args>`. `input` is sent as JSON on stdin (use with `--input -`). No shell is involved. */
export function gh<T>(args: string[], input?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { env: env(), timeout: 20_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      if (error) {
        return reject(failure(error, stderr));
      }
      if (!stdout.trim()) {
        return resolve(null as T);
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new GhError("GitHub returned invalid JSON", 502));
      }
    });
    // Add stdin error listener preventing unhandled EPIPE
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") {
        // ignore EPIPE, but let other errors be handled if needed
      }
    });
    child.stdin?.end(input === undefined ? "" : JSON.stringify(input));
  });
}

export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await gh<{ data?: T; errors?: { message: string; type?: string }[] }>(
    ["api", "graphql", "--input", "-"],
    { query, variables }
  );
  if (r?.errors?.length) {
    const errObj = r.errors[0]!;
    const status = errObj.type === "NOT_FOUND" ? 404 : 422;
    throw new GhError(errObj.message.slice(0, 300), status);
  }
  if (!r?.data) {
    throw new GhError("GitHub GraphQL returned no data", 502);
  }
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
    const user = await gh<{ login: string }>(["api", "user"]);
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

// Simple in-memory cache for project repos mapped from remotes
let cachedProjectReposKey = "";
let cachedProjectReposResult: { repo: string; projects: { id: number; name: string }[] }[] = [];
let cachedProjectReposTime = 0;

export async function projectRepos(
  projects: { id: number; name: string; cwd: string }[]
): Promise<{ repo: string; projects: { id: number; name: string }[] }[]> {
  // Cache key based on project ids, names, and cwd to invalidate mapping changes; skip id <= 0 or no cwd
  const validProjects = projects.filter((p) => p.id > 0 && p.cwd && p.cwd.trim() !== "");
  const cacheKey = validProjects.map((p) => `${p.id}:${p.name}:${p.cwd}`).sort().join("|");
  const now = Date.now();
  if (cacheKey === cachedProjectReposKey && now - cachedProjectReposTime < 30_000) {
    return cachedProjectReposResult;
  }

  const map = new Map<string, { id: number; name: string }[]>();

  for (const p of validProjects) {
    try {
      const url = await new Promise<string>((resolve) => {
        const child = execFile(
          "git",
          ["-C", p.cwd, "remote", "get-url", "origin"],
          { env: env(), timeout: 5000 },
          (error, stdout) => {
            if (error) return resolve("");
            resolve(stdout.trim());
          }
        );
        child.on("error", () => resolve(""));
      });
      const parsed = parseRemote(url);
      if (parsed) {
        let list = map.get(parsed);
        if (!list) {
          list = [];
          map.set(parsed, list);
        }
        if (!list.some((item) => item.id === p.id)) {
          list.push({ id: p.id, name: p.name });
        }
      }
    } catch {
      // ignore git errors for individual projects
    }
  }

  const result: { repo: string; projects: { id: number; name: string }[] }[] = [];
  for (const [repo, projs] of map.entries()) {
    result.push({ repo, projects: projs });
  }

  cachedProjectReposKey = cacheKey;
  cachedProjectReposResult = result;
  cachedProjectReposTime = now;

  return result;
}
