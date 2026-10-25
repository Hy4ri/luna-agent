import type { CardInput } from './board.js';
import type { Detail } from './github.js';

export const itemUrl = (repo: string, kind: 'pr' | 'issue', n: number) => `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`;
export const linked = (description: string, url: string) => description.split('\n').some(line => line.trim().toLowerCase() === url.toLowerCase());
export function cardInput(repo: string, d: Detail): CardInput {
  const header = [itemUrl(repo, d.kind, d.number), '', `Author: @${d.author ?? 'ghost'} · Opened ${d.createdAt.slice(0, 10)}`, ...(d.pr ? [`${d.pr.head} → ${d.pr.base}`] : []), '', ''].join('\n');
  const suffix = '\n\n[truncated: full text on GitHub]';
  const room = 8000 - header.length;
  const body = d.body.length > room ? d.body.slice(0, Math.max(0, room - suffix.length)) + suffix : d.body;
  return { subject: `${d.kind === 'pr' ? 'PR' : 'Issue'} #${d.number}: ${d.title}`.slice(0, 200), description: header + body, status: 'todo', priority: 'medium', labels: ['github', d.kind] };
}
