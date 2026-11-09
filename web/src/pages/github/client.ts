import { json, post } from "@/lib/api";
import type { GhStatus, RepoInfo, ItemPage, Detail, Comment, PullFile } from "../../../../src/github";
import { makeKey, fetchSWR } from './cache';
export { dropRepo } from './cache';

export function fetchGhStatus(fresh = false, signal?: AbortSignal): Promise<GhStatus> {
  return fetchSWR(makeKey('status', {}), requestSignal => json<GhStatus>(`/v1/github/status${fresh ? '?fresh=1' : ''}`, { signal: requestSignal }), fresh, value => value.state === 'ok', signal);
}
export function fetchRepos(signal?: AbortSignal): Promise<{ repos: { repo: string; projects: { id: number; name: string }[] }[] }> {
  return fetchSWR(makeKey('repos', {}), requestSignal => json('/v1/github/repos', { signal: requestSignal }), false, undefined, signal);
}
export function fetchRepoInfo(owner: string, name: string, fresh = false, signal?: AbortSignal): Promise<RepoInfo> {
  return fetchSWR(makeKey('repo-info', { owner, name }), requestSignal => json<RepoInfo>(`/v1/github/repos/${owner}/${name}${fresh ? '?fresh=1' : ''}`, { signal: requestSignal }), fresh, undefined, signal);
}
export type ItemFilters = { author?: string; label?: string; draft?: string; review?: string };
export function fetchItems(owner: string, name: string, kind: 'pr' | 'issue', state: 'open' | 'closed' | 'all', q: string, after?: string | null, fresh = false, signal?: AbortSignal, filters: ItemFilters = {}): Promise<ItemPage> {
  const params = new URLSearchParams({ kind, state });
  if (q) params.set('q', q);
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  if (after) params.set('after', after);
  if (fresh) params.set('fresh', '1');
  const load = (signal?: AbortSignal) => json<ItemPage>(`/v1/github/repos/${owner}/${name}/items?${params}`, { signal });
  // Only first pages survive navigation; cursors belong to their query and page snapshot.
  return after ? load(signal) : fetchSWR(makeKey('items', { owner, name, kind, state, q, after: '', ...filters }), load, fresh, undefined, signal);
}
export function fetchItemDetail(owner: string, name: string, number: number, fresh = false, signal?: AbortSignal): Promise<Detail> {
  return fetchSWR(makeKey('item-detail', { owner, name, number }), requestSignal => json<Detail>(`/v1/github/repos/${owner}/${name}/items/${number}${fresh ? '?fresh=1' : ''}`, { signal: requestSignal }), fresh, undefined, signal);
}
export function fetchComments(owner: string, name: string, number: number, before: string): Promise<{ comments: Comment[]; before: string | null }> {
  return json(`/v1/github/repos/${owner}/${name}/items/${number}/comments?${new URLSearchParams({ before })}`);
}
export function fetchPullFiles(owner: string, name: string, number: number, page: number, fresh = false): Promise<{ files: PullFile[]; more: boolean }> {
  return json(`/v1/github/repos/${owner}/${name}/pulls/${number}/files?${new URLSearchParams({ page: String(page), ...(fresh ? { fresh: '1' } : {}) })}`);
}

const repoPath = (repo: string) => `/v1/github/repos/${repo}`;
export type Created = { number: number; url: string };
export function fetchLabels(repo: string): Promise<{ labels: { name: string; color: string }[] }> { return json(`${repoPath(repo)}/labels`); }
export function fetchAssignees(repo: string): Promise<{ assignees: string[] }> { return json(`${repoPath(repo)}/assignees`); }
export function createIssue(repo: string, body: { title: string; body?: string; labels?: string[]; assignees?: string[] }) { return post<Created>(`${repoPath(repo)}/issues`, body); }
export function createPull(repo: string, body: { title: string; head: string; base: string; body?: string; draft?: boolean }) { return post<Created>(`${repoPath(repo)}/pulls`, body); }
export function editItem(repo: string, number: number, body: { kind: 'pr' | 'issue'; title?: string; body?: string; labels?: string[]; assignees?: string[] }) { return post<Detail>(`${repoPath(repo)}/items/${number}`, body, 'PATCH'); }
