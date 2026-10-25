import { json } from "@/lib/api";
import type { GhStatus, RepoInfo, ItemPage, Detail } from "../../../../src/github";

export async function fetchGhStatus(): Promise<GhStatus> {
  return json<GhStatus>("/v1/github/status");
}

export async function fetchRepos(): Promise<{ repos: { repo: string; projects: { id: number; name: string }[] }[] }> {
  return json("/v1/github/repos");
}

export async function fetchRepoInfo(owner: string, name: string): Promise<RepoInfo> {
  return json<RepoInfo>(`/v1/github/repos/${owner}/${name}`);
}

export async function fetchItems(
  owner: string,
  name: string,
  kind: "pr" | "issue",
  state: "open" | "closed" | "all",
  q: string,
  after?: string | null
): Promise<ItemPage> {
  const params = new URLSearchParams({ kind, state });
  if (q) params.set("q", q);
  if (after) params.set("after", after);
  return json<ItemPage>(`/v1/github/repos/${owner}/${name}/items?${params.toString()}`);
}

export async function fetchItemDetail(owner: string, name: string, number: number): Promise<Detail> {
  return json<Detail>(`/v1/github/repos/${owner}/${name}/items/${number}`);
}
