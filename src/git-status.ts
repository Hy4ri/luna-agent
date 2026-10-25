import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

export type GitFile = { path: string; status: string; added: number; deleted: number; binary: boolean };
export type GitStatus = { state: 'ok'; branch: string; upstream: string | null; ahead: number; behind: number; added: number; deleted: number; untracked: number; conflicts: number; files: GitFile[] } | { state: 'not-repository' | 'unavailable' | 'error'; message: string };

// Cache pending reads too: sessions sharing a workspace must not start duplicate Git processes.
export function createGitStatusReader() {
  const cache = new Map<string, { until: number; value: Promise<GitStatus> }>();
  const read = (key: string, env: ExecutionEnv, commandEnv?: Record<string, string>): Promise<GitStatus> => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.until < now) cache.delete(k);
    const previous = cache.get(key);
    if (previous) return previous.value;
    const entry = { until: Infinity, value: Promise.resolve<GitStatus>({ state: 'error', message: 'Reading Git status' }) };
    entry.value = readGitStatus(env, commandEnv).finally(() => { entry.until = Date.now() + 4000; });
    cache.set(key, entry);
    return entry.value;
  };
  return Object.assign(read, { invalidate: () => cache.clear() });
}

async function readGitStatus(env: ExecutionEnv, supplied?: Record<string, string>): Promise<GitStatus> {
  const source = supplied ?? process.env;
  const safeEnv = Object.fromEntries(['PATH', 'HOME'].flatMap(k => source[k] === undefined ? [] : [[k, source[k]!]]));
  async function git(args: string[]) {
    let out = '', error = '', overflow = false;
    const r = await env.exec(['git', '--no-optional-locks', ...args], {
      cwd: env.cwd, inheritEnv: false, timeout: 10,
      env: { ...safeEnv, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
      onOutput: (text, _ctx, info) => {
        if (out.length + error.length + text.length > 4 * 1024 * 1024) { overflow = true; return; }
        if (info.stream === 'stderr') error += text; else out += text;
      },
    }, BACKGROUND_CONTEXT);
    if (!r.ok) throw new Error(r.error.message);
    if (overflow) throw new Error('Git status output is too large');
    return { out, error, code: r.value.exitCode };
  }
  try {
    const status = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    if (status.code !== 0) return status.error.includes('not a git repository')
      ? { state: 'not-repository', message: 'Not a Git repository' }
      : { state: 'error', message: 'Git status failed' };
    let branch = '', upstream: string | null = null, ahead = 0, behind = 0, untracked = 0, conflicts = 0, unborn = false;
    const files: GitFile[] = [];
    const originals = new Map<string, GitFile>();
    const records = status.out.split('\0');
    for (let i = 0; i < records.length; i++) {
      const line = records[i]!;
      if (line.startsWith('# branch.head ')) branch = line.slice(14);
      else if (line.startsWith('# branch.oid ')) { unborn = line.slice(13) === '(initial)'; if (branch === '(detached)') branch = `Detached ${line.slice(13, 20)}`; }
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { ahead = Number(m[1]); behind = Number(m[2]); } }
      else if (line.startsWith('? ')) { untracked++; files.push({ path: line.slice(2), status: '??', added: 0, deleted: 0, binary: false }); }
      else if (/^[12u] /.test(line)) {
        const count = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10;
        const path = line.split(' ').slice(count).join(' ');
        files.push({ path, status: line.slice(2, 4), added: 0, deleted: 0, binary: false });
        if (line[0] === 'u') conflicts++;
        if (line[0] === '2') { originals.set(records[++i]!, files[files.length - 1]!); }
      }
    }
    if (branch === '(detached)') {
      const oid = records.find(r => r.startsWith('# branch.oid '))?.slice(13, 20);
      branch = `Detached ${oid ?? 'HEAD'}`;
    }
    // Without HEAD, compare each tracked working file with an empty file, not just the index.
    let diff: { out: string; code: number };
    if (unborn) {
      let out = '';
      for (const file of files.filter(f => f.status !== '??' && !f.status.endsWith('D'))) {
        const part = await git(['diff', '--no-index', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file.path]);
        if (part.code > 1) throw new Error('Git change counts failed');
        // --no-index uses rename-style NUL paths; the final path is already known here.
        const count = /^(\d+|-)\t(\d+|-)\t/.exec(part.out);
        if (count) out += `${count[1]}\t${count[2]}\t${file.path}\0`;
      }
      diff = { out, code: 0 };
    } else diff = await git(['diff', 'HEAD', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--']);
    if (diff.code !== 0) return { state: 'error', message: 'Git change counts failed' };
    let added = 0, deleted = 0;
    for (const record of diff.out.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record);
      if (!m) continue;
      const a = m[1] === '-' ? 0 : Number(m[1]), d = m[2] === '-' ? 0 : Number(m[2]);
      added += a; deleted += d;
      const file = files.find(f => f.path === m[3]) ?? originals.get(m[3]!);
      if (file) { file.added += a; file.deleted += d; file.binary = m[1] === '-'; }
    }
    return { state: 'ok', branch, upstream, ahead, behind, added, deleted, untracked, conflicts, files };
  } catch (e) { return { state: 'error', message: `Git status failed: ${(e as Error).message}` }; }
}
