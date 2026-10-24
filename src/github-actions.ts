import { gh, graphql, GhError } from "./github.js";
import { repoInfo } from "./github-list.js";
import { detail } from "./github-detail.js";
import type { Kind, Detail, Comment } from "./github.js";

const activeLocks = new Set<string>();

export async function withItemLock<T>(repo: string, number: number, fn: () => Promise<T>): Promise<T> {
  const key = `${repo}#${number}`;
  if (activeLocks.has(key)) {
    throw new GhError("Another action on this item is running", 409);
  }
  activeLocks.add(key);
  try {
    return await fn();
  } finally {
    activeLocks.delete(key);
  }
}

export async function comment(repo: string, number: number, body: string): Promise<Comment> {
  return await withItemLock(repo, number, async () => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GhError("Invalid repository", 400);
    const itemDetail = await detail(owner, name, number);
    if (!itemDetail.can.comment) {
      throw new GhError("Permission denied to comment on this item", 403);
    }

    const res = await gh<{
      id: string;
      node_id: string;
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
    }>(["api", "--method", "POST", `repos/${repo}/issues/${number}/comments`, "--input", "-"], { body });

    return {
      id: res.node_id ?? String(res.id),
      author: res.user?.login ?? null,
      body: res.body,
      createdAt: res.created_at,
      url: res.html_url,
    };
  });
}

export async function setState(
  repo: string,
  kind: Kind,
  number: number,
  state: "open" | "closed",
  reason?: "completed" | "not_planned"
): Promise<Detail> {
  return await withItemLock(repo, number, async () => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GhError("Invalid repository", 400);
    const itemDetail = await detail(owner, name, number);

    if (itemDetail.kind !== kind) {
      throw new GhError("Item kind mismatch", 400);
    }
    if (!itemDetail.can.close) {
      throw new GhError("Permission denied to update item state", 403);
    }
    if (state === "open" && itemDetail.state === "MERGED") {
      throw new GhError("Forbidden: cannot reopen a merged pull request", 422);
    }

    const endpoint = kind === "pr" ? `repos/${repo}/pulls/${number}` : `repos/${repo}/issues/${number}`;
    const payload: Record<string, any> = { state };
    if (kind === "issue" && state === "closed" && reason) {
      payload.state_reason = reason;
    }

    await gh(["api", "--method", "PATCH", endpoint, "--input", "-"], payload);
    return await detail(owner, name, number);
  });
}

export async function merge(
  repo: string,
  number: number,
  method: "merge" | "squash" | "rebase",
  sha: string
): Promise<Detail> {
  return await withItemLock(repo, number, async () => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GhError("Invalid repository", 400);
    const itemDetail = await detail(owner, name, number);

    if (itemDetail.kind !== "pr" || !itemDetail.pr) {
      throw new GhError("Item is not a pull request", 400);
    }
    if (!itemDetail.can.merge) {
      throw new GhError("Permission denied or PR not mergeable", 403);
    }

    const info = await repoInfo(owner, name);
    if (!info.merge[method]) {
      throw new GhError(`Merge method '${method}' is not allowed for this repository`, 422);
    }

    const res = await gh<{ merged: boolean; message: string }>(
      ["api", "--method", "PUT", `repos/${repo}/pulls/${number}/merge`, "--input", "-"],
      { merge_method: method, sha }
    );

    if (!res.merged) {
      throw new GhError(res.message || "Merge failed", 422);
    }

    return await detail(owner, name, number);
  });
}

const refEncode = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

export async function deleteBranch(repo: string, number: number, sha: string): Promise<Detail> {
  return await withItemLock(repo, number, async () => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GhError("Invalid repository", 400);
    const itemDetail = await detail(owner, name, number);

    if (itemDetail.kind !== "pr" || !itemDetail.pr) {
      throw new GhError("Item is not a pull request", 400);
    }
    if (!itemDetail.can.deleteBranch || !itemDetail.pr.headRepo || !itemDetail.pr.branchExists) {
      throw new GhError("Branch deletion not allowed or branch does not exist", 403);
    }

    const headRef = itemDetail.pr.head;
    const headRepo = itemDetail.pr.headRepo;

    const refRes = await gh<{ object?: { sha: string } }>(["api", `repos/${headRepo}/git/ref/heads/${refEncode(headRef)}`]);
    const currentSha = refRes?.object?.sha;
    if (!currentSha || currentSha !== sha) {
      throw new GhError("Branch has new commits or SHA mismatch", 409);
    }

    await gh(["api", "--method", "DELETE", `repos/${headRepo}/git/refs/heads/${refEncode(headRef)}`]);

    return await detail(owner, name, number);
  });
}

export async function deleteIssue(repo: string, number: number, confirm: number): Promise<{ deleted: true }> {
  return await withItemLock(repo, number, async () => {
    if (confirm !== number) {
      throw new GhError("Confirmation number does not match issue number", 400);
    }

    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GhError("Invalid repository", 400);
    const itemDetail = await detail(owner, name, number);

    if (itemDetail.kind !== "issue") {
      throw new GhError("Item is not an issue", 400);
    }
    if (!itemDetail.can.delete) {
      throw new GhError("Permission denied to delete this issue", 403);
    }

    const issueId = itemDetail.id;
    await graphql(`mutation($id:ID!){ deleteIssue(input:{issueId:$id}){ clientMutationId } }`, { id: issueId });

    return { deleted: true };
  });
}
