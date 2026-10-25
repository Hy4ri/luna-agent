import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { posix } from 'node:path';
import { parseRemote } from './github.js';

export class GitError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 | 500 | 502 | 503 | 504 = 422) { super(message); }
}
export type Workspace = { env: ExecutionEnv; machine: string; commandEnv?: Record<string, string> };
export type ChangeFile = { path: string; original?: string; index: string; worktree: string; staged: boolean; untracked: boolean; conflict: boolean };
export type Changes = { cwd: string; machine: string; branch: string; upstream: string | null; ahead: number; behind: number; headOid: string | null; detached: boolean; unborn: boolean; files: ChangeFile[]; untrackedCollapsed: boolean; repo: string | null; busy: boolean };
export type Branches = { current: string; local: { name: string; upstream: string; ahead: number; behind: number }[]; remote: string[] };
const active = new Set<string>();
const UNTRACKED_LIMIT = 5000;
function countUntracked(out: string) { let n = 0; for (const record of out.split('\0')) if (record.startsWith('? ')) n++; return n; }
export function redact(text: string) { return text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]'); }

export function createGitControl() {
  async function run(w: Workspace, args: string[], options: { cwd?: string; network?: boolean; read?: boolean; limit?: number; truncate?: boolean } = {}) {
    const source = w.commandEnv ?? process.env;
    const safe: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) if (source[key] !== undefined) safe[key] = source[key]!;
    let out = '', error = '', overflow = false;
    const limit = options.limit ?? (4 << 20);
    const result = await w.env.exec(['git', ...(options.read ? ['--no-optional-locks'] : []), ...args], {
      cwd: options.cwd ?? w.env.cwd, inheritEnv: false, timeout: options.network ? 120 : 15,
      env: { ...safe, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', SSH_ASKPASS: '/bin/false', GIT_ASKPASS: '/bin/false', GCM_INTERACTIVE: 'Never', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
      onOutput: (text, _c, info) => { const room = limit - out.length - error.length; if (text.length > room) overflow = true; const part = text.slice(0, Math.max(0, room)); if (info.stream === 'stderr') error += part; else out += part; },
    }, ctx);
    if (!result.ok) throw new GitError(redact(`Git execution failed; refresh to check the result: ${result.error.message}`), /time.?out|timed out/i.test(result.error.message) ? 504 : 503);
    if (overflow && !options.truncate) throw new GitError('Git output exceeds the size limit', 422);
    return { out, error: redact(error), code: result.value.exitCode, truncated: overflow };
  }
  function check(r: { code: number; error: string }) {
    if (r.code !== 0) throw new GitError(r.error.trim().slice(0, 2000) || 'Git command failed', /would be overwritten|diverg|not possible to fast-forward|index.lock|conflict/i.test(r.error) ? 409 : /timed? ?out/i.test(r.error) ? 504 : 422);
  }
  async function root(w: Workspace) {
    const r = await run(w, ['rev-parse', '--show-toplevel'], { read: true });
    if (r.code !== 0) throw new GitError('Not a Git repository', 400);
    return r.out.trim();
  }
  async function changes(w: Workspace): Promise<Changes> {
    const cwd = await root(w);
    const status = (mode: string) => run(w, ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${mode}`], { cwd, read: true, truncate: true });
    let r = await status('all'), untrackedCollapsed = false;
    // Thousands of untracked files (an unignored build folder) would flood the list or
    // exceed the output limit; list untracked folders as single entries instead.
    if (r.truncated || (r.code === 0 && countUntracked(r.out) > UNTRACKED_LIMIT)) { r = await status('normal'); untrackedCollapsed = true; }
    if (r.truncated) throw new GitError('Git output exceeds the size limit', 422);
    check(r);
    let headOid: string | null = null;
    let branch = '', upstream: string | null = null, ahead = 0, behind = 0, unborn = false;
    const files: ChangeFile[] = [], records = r.out.split('\0');
    for (let i = 0; i < records.length; i++) {
      const line = records[i]!;
      if (line.startsWith('# branch.head ')) branch = line.slice(14);
      else if (line.startsWith('# branch.oid ')) { unborn = line.slice(13) === '(initial)'; headOid = unborn ? null : line.slice(13); }
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { ahead = Number(m[1]); behind = Number(m[2]); } }
      else if (line.startsWith('? ')) files.push({ path: line.slice(2), index: '?', worktree: '?', staged: false, untracked: true, conflict: false });
      else if (/^[12u] /.test(line)) {
        const path = line.split(' ').slice(line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10).join(' ');
        const x = line[2]!, y = line[3]!;
        files.push({ path, ...(line[0] === '2' ? { original: records[++i]! } : {}), index: x, worktree: y, staged: x !== '.', untracked: false, conflict: line[0] === 'u' });
      }
    }
    const remote = await run(w, ['remote', 'get-url', 'origin'], { cwd, read: true });
    return { cwd, machine: w.machine, branch, upstream, ahead, behind, headOid, detached: branch === '(detached)', unborn, files, untrackedCollapsed, repo: remote.code ? null : parseRemote(remote.out.trim()), busy: active.has(`${w.machine}:${cwd}`) };
  }
  async function paths(w: Workspace, s: Changes, requested: string[], expandRename = false) {
    const allowed = new Set(s.files.flatMap(f => [f.path, ...(f.original ? [f.original] : [])]));
    for (const path of requested) {
      if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0') || !allowed.has(path)) throw new GitError('Path is not a current repository change', 400);
      // Git records symlinks themselves, but a directory symlink must not escape the repository.
      let directory = posix.join(s.cwd, posix.dirname(path));
      let parent = await w.env.canonicalPath(directory, ctx);
      while (!parent.ok && directory !== s.cwd && directory.startsWith(s.cwd + '/')) { directory = posix.dirname(directory); parent = await w.env.canonicalPath(directory, ctx); }
      if (!parent.ok || (parent.value !== s.cwd && !parent.value.startsWith(s.cwd + '/'))) throw new GitError('Path parent is outside the repository or missing', 400);
    }
    return [...new Set(requested.flatMap(path => { const f = s.files.find(f => f.path === path); return expandRename && f?.original ? [path, f.original] : [path]; }))];
  }
  async function diff(w: Workspace, path: string, staged: boolean) {
    const s = await changes(w); await paths(w, s, [path]);
    const file = s.files.find(f => f.path === path); if (!file) throw new GitError('File not found', 404);
    if (file.untracked && path.endsWith('/')) return { path, binary: false, directory: true, text: '', truncated: false };
    let args: string[];
    if (file.untracked) args = ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path];
    else args = ['diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--', path];
    const r = await run(w, args, { cwd: s.cwd, read: true, limit: 512 << 10, truncate: true });
    if (!(file.untracked && r.code === 1)) check(r);
    return { path, binary: /(?:Binary files|GIT binary patch)/.test(r.out), directory: false, text: redact(r.out), truncated: r.truncated };
  }
  async function branches(w: Workspace): Promise<Branches> {
    const cwd = await root(w);
    const r = await run(w, ['for-each-ref', '--format=%(HEAD)%00%(refname)%00%(upstream:short)%00%(upstream:track)', 'refs/heads', 'refs/remotes/origin'], { cwd, read: true }); check(r);
    const local: Branches['local'] = [], remote: string[] = [];
    let current = '';
    for (const line of r.out.trim().split('\n').filter(Boolean)) {
      const [head = '', ref = '', upstream = '', track = ''] = line.split('\0');
      if (ref.startsWith('refs/remotes/')) { const name = ref.slice(13); if (name !== 'origin/HEAD') remote.push(name); continue; }
      const name = ref.slice(11);
      if (head === '*') current = name;
      local.push({ name, upstream, ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0) });
    }
    // A remote branch that already has a local branch of the same name is listed once, as the local branch.
    const names = new Set(local.map(l => l.name));
    return { current, local, remote: remote.filter(name => !names.has(name.slice(7))) };
  }
  async function mutate(w: Workspace, action: string, body: Record<string, unknown>) {
    const s = await changes(w), key = `${w.machine}:${s.cwd}`;
    if (active.has(key)) throw new GitError('Another Git action is running', 409);
    active.add(key);
    let summary = '';
    try {
      let args: string[] = [], network = false;
      if (action === 'stage' || action === 'unstage') {
        const selected = await paths(w, s, body.paths as string[], action === 'unstage');
        args = action === 'stage' ? ['add', '--', ...selected] : s.unborn ? ['rm', '--cached', '-r', '-f', '--', ...selected] : ['restore', '--staged', '--', ...selected];
      } else if (action === 'commit') {
        if (s.files.some(f => f.conflict)) throw new GitError('Resolve conflicts before committing', 409);
        if (!s.files.some(f => f.staged)) throw new GitError('Nothing is staged', 400);
        args = ['commit', '-m', body.message as string];
      } else if (action === 'switch') {
        const branch = body.branch as string, create = body.create === true;
        const name = branch.startsWith('origin/') && !create ? branch.slice(7) : branch;
        if (name.startsWith('-') || name.includes('@{-') || !name) throw new GitError('Invalid branch name', 400);
        check(await run(w, ['check-ref-format', '--branch', name], { cwd: s.cwd, read: true }));
        if (create) {
          args = ['switch', '-c', name];
          if (body.from) { const from = body.from as string; const b = await branches(w); if (from !== 'HEAD' && ![...b.local.map(l => l.name), ...b.remote].includes(from)) throw new GitError('Unknown source branch', 400); args.push(from); }
        } else {
          const b = await branches(w);
          if (b.local.some(l => l.name === branch)) args = ['switch', branch];
          else if (branch.startsWith('origin/') && b.local.some(l => l.name === name)) args = ['switch', name];
          else if (b.remote.includes(branch)) args = ['switch', '--track', branch];
          else throw new GitError('Unknown branch', 400);
        }
      } else if (action === 'fetch') { args = ['fetch', '--prune', 'origin']; network = true; }
      else if (action === 'pull') { if (!s.upstream) throw new GitError('Publish this branch before pulling', 400); args = ['pull', '--ff-only']; network = true; }
      else if (action === 'push') {
        if (s.detached || s.unborn) throw new GitError('Select a branch with commits before pushing', 400);
        if (body.expectedBranch !== s.branch || body.expectedHead !== s.headOid) throw new GitError('Branch or head changed. Refresh before pushing.', 409);
        // Always discover the actual origin default; origin/HEAD is often absent or stale.
        const defaultRef = await run(w, ['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: s.cwd, network: true, read: true }); check(defaultRef);
        const defaultBranch = /^ref: refs\/heads\/([^\t]+)\tHEAD/m.exec(defaultRef.out)?.[1];
        const remoteBranch = s.upstream?.startsWith('origin/') ? s.upstream.slice(7) : s.branch;
        if ((!defaultBranch || remoteBranch === defaultBranch) && body.confirmDefault !== true) throw new GitError(`confirm-default: ${defaultBranch ? `origin/${remoteBranch} is the default branch.` : `Could not read the default branch of origin.`} Push ${s.branch} to origin/${remoteBranch}?`, 409);
        if (s.upstream && !s.upstream.startsWith('origin/')) throw new GitError('Only origin upstreams are supported', 400);
        if (!s.upstream && body.setUpstream !== true) throw new GitError('Publish branch with setUpstream first', 400);
        args = ['push', 'origin', `${s.headOid}:refs/heads/${remoteBranch}`]; network = true;
      } else throw new GitError('Unknown Git action', 400);
      const r = await run(w, args, { cwd: s.cwd, network }); check(r);
      if (action === 'push' && !s.upstream) check(await run(w, ['branch', '--set-upstream-to', `origin/${s.branch}`, s.branch], { cwd: s.cwd }));
      summary = redact((r.out + r.error).trim());
      const state = await changes(w);
      return { changes: state, summary, sha: state.headOid };
    } finally { active.delete(key); }
  }
  return { changes, diff, branches, mutate };
}
