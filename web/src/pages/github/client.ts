import { json } from "@/lib/api";
import type { GhStatus, RepoInfo, ItemPage, Detail, Comment, PullFile } from "../../../../src/github";
import { makeKey, fetchSWR } from './cache';
export { dropRepo } from './cache';

export function fetchGhStatus(fresh = false): Promise<GhStatus> {
  return fetchSWR(makeKey('status', {}), () => json<GhStatus>(`/v1/github/status${fresh ? '?fresh=1' : ''}`), fresh, value => value.state === 'ok');
}
export function fetchRepos(): Promise<{ repos: { repo: string; projects: { id: number; name: string }[] }[] }> {
  return fetchSWR(makeKey('repos', {}), () => json('/v1/github/repos'));
}
export function fetchRepoInfo(owner: string, name: string, fresh = false): Promise<RepoInfo> {
  return fetchSWR(makeKey('repo-info', { owner, name }), () => json<RepoInfo>(`/v1/github/repos/${owner}/${name}${fresh ? '?fresh=1' : ''}`), fresh);
}
export function fetchItems(owner: string, name: string, kind: 'pr' | 'issue', state: 'open' | 'closed' | 'all', q: string, after?: string | null, fresh = false): Promise<ItemPage> {
  const params = new URLSearchParams({ kind, state });
  if (q) params.set('q', q);
  if (after) params.set('after', after);
  if (fresh) params.set('fresh', '1');
  const load = () => json<ItemPage>(`/v1/github/repos/${owner}/${name}/items?${params}`);
  // Only first pages survive navigation; cursors belong to their query and page snapshot.
  return after ? load() : fetchSWR(makeKey('items', { owner, name, kind, state, q, after: '' }), load, fresh);
}
export function fetchItemDetail(owner: string, name: string, number: number, fresh = false, signal?: AbortSignal): Promise<Detail> {
  return fetchSWR(makeKey('item-detail', { owner, name, number }), () => json<Detail>(`/v1/github/repos/${owner}/${name}/items/${number}${fresh ? '?fresh=1' : ''}`, { signal }), fresh);
}
export function fetchComments(owner: string, name: string, number: number, before: string): Promise<{ comments: Comment[]; before: string | null }> {
  return json(`/v1/github/repos/${owner}/${name}/items/${number}/comments?${new URLSearchParams({ before })}`);
}
export function fetchPullFiles(owner: string, name: string, number: number, page: number, fresh = false): Promise<{ files: PullFile[]; more: boolean }> {
  return json(`/v1/github/repos/${owner}/${name}/pulls/${number}/files?${new URLSearchParams({ page: String(page), ...(fresh ? { fresh: '1' } : {}) })}`);
}
