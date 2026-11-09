// GitHub writes beyond comment/state/merge: create, edit, labels, assignees, review, draft, update branch.
// GitHub enforces permissions; these helpers validate input, take the per-item lock, and return fresh detail.
import { api, graphql, GhError } from "./github.js";
import { detail } from "./github-detail.js";
import { withItemLock } from "./github-actions.js";
import type { Detail, Kind } from "./github.js";

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GhError("Invalid repository", 400);
  return [owner, name] as const;
};
export type Created = { number: number; url: string };

export async function createIssue(repo: string, input: { title: string; body?: string; labels?: string[]; assignees?: string[] }): Promise<Created> {
  split(repo);
  const r = await api<{ number: number; html_url: string }>(`repos/${repo}/issues`, { method: "POST", body: input });
  return { number: r.number, url: r.html_url };
}

export async function createPull(repo: string, input: { title: string; head: string; base: string; body?: string; draft?: boolean }): Promise<Created> {
  split(repo);
  const r = await api<{ number: number; html_url: string }>(`repos/${repo}/pulls`, { method: "POST", body: input });
  return { number: r.number, url: r.html_url };
}

/** Title, body, labels, and assignees in one PATCH. Only the fields present are sent, so nothing else changes. */
export async function editItem(repo: string, kind: Kind, number: number, patch: { title?: string; body?: string; labels?: string[]; assignees?: string[] }): Promise<Detail> {
  return withItemLock(repo, number, async () => {
    const [owner, name] = split(repo);
    const current = await detail(owner, name, number);
    if (current.kind !== kind) throw new GhError("Item kind mismatch", 400);
    if (!Object.keys(patch).length) throw new GhError("Nothing to change", 400);
    // Labels and assignees live on the issue endpoint for both kinds; title and body too.
    await api(`repos/${repo}/issues/${number}`, { method: "PATCH", body: patch });
    return detail(owner, name, number);
  });
}

export async function review(repo: string, number: number, input: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string; sha: string }): Promise<Detail> {
  return withItemLock(repo, number, async () => {
    const [owner, name] = split(repo);
    const current = await detail(owner, name, number);
    if (current.kind !== "pr" || !current.pr) throw new GhError("Item is not a pull request", 400);
    if (current.state !== "OPEN") throw new GhError("Only open pull requests can be reviewed", 422);
    if (input.event !== "APPROVE" && !input.body?.trim()) throw new GhError("A comment is required for this review", 400);
    // Reviewing a commit the user has not seen would approve unseen code.
    if (current.pr.headOid !== input.sha) throw new GhError("The pull request changed. Reload before reviewing.", 409);
    await api(`repos/${repo}/pulls/${number}/reviews`, { method: "POST", body: { event: input.event, commit_id: input.sha, ...(input.body?.trim() ? { body: input.body } : {}) } });
    return detail(owner, name, number);
  });
}

export async function setDraft(repo: string, number: number, draft: boolean): Promise<Detail> {
  return withItemLock(repo, number, async () => {
    const [owner, name] = split(repo);
    const current = await detail(owner, name, number);
    if (current.kind !== "pr" || !current.pr) throw new GhError("Item is not a pull request", 400);
    if (current.state !== "OPEN") throw new GhError("Only open pull requests can change draft state", 422);
    if (current.pr.draft !== draft) {
      await graphql(draft
        ? `mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ clientMutationId } }`
        : `mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ clientMutationId } }`, { id: current.id });
    }
    return detail(owner, name, number);
  });
}

export async function updatePullBranch(repo: string, number: number, sha: string): Promise<Detail> {
  return withItemLock(repo, number, async () => {
    const [owner, name] = split(repo);
    const current = await detail(owner, name, number);
    if (current.kind !== "pr" || !current.pr) throw new GhError("Item is not a pull request", 400);
    if (current.state !== "OPEN") throw new GhError("Only open pull requests can be updated", 422);
    if (current.pr.headOid !== sha) throw new GhError("The pull request changed. Reload first.", 409);
    await api(`repos/${repo}/pulls/${number}/update-branch`, { method: "PUT", body: { expected_head_sha: sha } });
    return detail(owner, name, number);
  });
}

export async function repoLabels(repo: string): Promise<{ name: string; color: string }[]> {
  split(repo);
  const r = await api<{ name: string; color: string }[]>(`repos/${repo}/labels?per_page=100`);
  return (r ?? []).map(l => ({ name: l.name, color: l.color }));
}
export async function repoAssignees(repo: string): Promise<string[]> {
  split(repo);
  const r = await api<{ login: string }[]>(`repos/${repo}/assignees?per_page=100`);
  return (r ?? []).map(a => a.login);
}
