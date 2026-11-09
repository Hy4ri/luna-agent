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
export type Branches = { current: string; local: { name: string; upstream: string; ahead: number; behind: number; date: string; subject: string }[]; remote: string[]; default: string | null };
export type LogCommit = { oid: string; parents: string[]; author: string; email: string; date: string; refs: string[]; subject: string };
export type FileStat = { path: string; original?: string; status: string; additions: number; deletions: number; binary: boolean };
export type CommitDetail = Omit<LogCommit, 'subject'> & { message: string; committer: string; committerDate: string; base: string; files: FileStat[]; filesTruncated: boolean };
export type Compare = { base: string; head: string; mergeBase: string; ahead: number; behind: number; commits: LogCommit[]; commitsTruncated: boolean; files: FileStat[]; filesTruncated: boolean };
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e';
/** Changed files listed per commit or comparison; a huge refactor would flood the page. */
const FILE_LIMIT = 3000;
/** `%D` with --decorate=full to typed names: head:main, local:x, remote:origin/x, tag:v1, HEAD (detached). */
function parseRefs(text: string) {
  return text ? text.split(', ').map(ref => ref.startsWith('HEAD -> refs/heads/') ? `head:${ref.slice(19)}`
    : ref.startsWith('tag: refs/tags/') ? `tag:${ref.slice(15)}`
    : ref.startsWith('refs/heads/') ? `local:${ref.slice(11)}`
    : ref.startsWith('refs/remotes/') ? `remote:${ref.slice(13)}` : ref).filter(ref => !/^remote:[^/]+\/HEAD$/.test(ref)) : [];
}
function parseLog(out: string): LogCommit[] {
  return out.split('\x1e').map(r => r.replace(/^\n/, '')).filter(Boolean).map(record => {
    const [oid = '', parents = '', author = '', email = '', date = '', refs = '', subject = ''] = record.split('\x1f');
    return { oid, parents: parents.split(' ').filter(Boolean), author, email, date, refs: parseRefs(refs), subject };
  });
}
/** Joins `--name-status -z` and `--numstat -z` output of the same diff. */
function parseFiles(nameStatus: string, numstat: string): FileStat[] {
  const files: FileStat[] = [], status = nameStatus.split('\0'), stats = numstat.split('\0');
  for (let i = 0; i < status.length - 1;) {
    const code = status[i++]!;
    if (/^[RC]/.test(code)) { const original = status[i++]!, path = status[i++]!; files.push({ path, original, status: code[0]!, additions: 0, deletions: 0, binary: false }); }
    else files.push({ path: status[i++]!, status: code[0]!, additions: 0, deletions: 0, binary: false });
  }
  let n = 0;
  for (let i = 0; i < stats.length - 1 && n < files.length; n++) {
    const [add = '', del = '', path = ''] = stats[i++]!.split('\t');
    if (!path) i += 2; // rename: the two paths follow as separate records
    Object.assign(files[n]!, add === '-' ? { binary: true } : { additions: Number(add), deletions: Number(del) });
  }
  return files;
}
const active = new Set<string>();
const UNTRACKED_LIMIT = 5000;
function countUntracked(out: string) { let n = 0; for (const record of out.split('\0')) if (record.startsWith('? ')) n++; return n; }
export function redact(text: string) { return text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@').replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]'); }

function parseStatus(out: string) {
  let headOid: string | null = null;
  let branch = '', upstream: string | null = null, ahead = 0, behind = 0, unborn = false;
  const files: ChangeFile[] = [], records = out.split('\0');
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
  return { headOid, branch, upstream, ahead, behind, unborn, files };
}

export function createGitControl() {
  const roots = new Map<string, { until: number; result: Promise<string> }>();
  const workspaceKey = (w: Workspace) => JSON.stringify([w.machine, w.env.cwd]);
  async function run(w: Workspace, args: string[], options: { cwd?: string; network?: boolean; read?: boolean; limit?: number; truncate?: boolean; globPathspecs?: boolean } = {}) {
    const source = w.commandEnv ?? process.env;
    const safe: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR']) if (source[key] !== undefined) safe[key] = source[key]!;
    let out = '', error = '', overflow = false;
    const limit = options.limit ?? (4 << 20);
    const result = await w.env.exec(['git', ...(options.read ? ['--no-optional-locks'] : []), ...args], {
      cwd: options.cwd ?? w.env.cwd, inheritEnv: false, timeout: options.network ? 120 : 15,
      env: { ...safe, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...(options.globPathspecs ? {} : { GIT_LITERAL_PATHSPECS: '1' }), SSH_ASKPASS: '/bin/false', GIT_ASKPASS: '/bin/false', GCM_INTERACTIVE: 'Never', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
      onOutput: (text, _c, info) => { const room = limit - out.length - error.length; if (text.length > room) overflow = true; const part = text.slice(0, Math.max(0, room)); if (info.stream === 'stderr') error += part; else out += part; },
    }, ctx);
    if (!result.ok) throw new GitError(redact(`Git execution failed; refresh to check the result: ${result.error.message}`), /time.?out|timed out/i.test(result.error.message) ? 504 : 503);
    if (overflow && !options.truncate) throw new GitError('Git output exceeds the size limit', 422);
    if (/not a git repository/i.test(error)) roots.delete(workspaceKey(w));
    return { out, error: redact(error), code: result.value.exitCode, truncated: overflow };
  }
  function check(r: { code: number; error: string }) {
    if (r.code !== 0) throw new GitError(r.error.trim().slice(0, 2000) || 'Git command failed', /would be overwritten|diverg|not possible to fast-forward|index.lock|conflict/i.test(r.error) ? 409 : /timed? ?out/i.test(r.error) ? 504 : 422);
  }
  async function root(w: Workspace) {
    const key = workspaceKey(w), cached = roots.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    const entry = { until: Infinity, result: Promise.resolve('') };
    entry.result = (async () => {
      const r = await run(w, ['rev-parse', '--show-toplevel'], { read: true });
      if (r.code !== 0) throw new GitError('Not a Git repository', 400);
      return r.out.trim();
    })().then(value => { entry.until = Date.now() + 60_000; return value; }, error => {
      if (roots.get(key) === entry) roots.delete(key);
      throw error;
    });
    roots.delete(key); roots.set(key, entry);
    while (roots.size > 200) roots.delete(roots.keys().next().value!);
    return entry.result;
  }
  async function changes(w: Workspace): Promise<Changes> {
    const cwd = await root(w);
    const status = (mode: string) => run(w, ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${mode}`], { cwd, read: true, truncate: true });
    const [initial, remote] = await Promise.all([status('all'), run(w, ['remote', 'get-url', 'origin'], { cwd, read: true })]);
    let r = initial, untrackedCollapsed = false;
    // Thousands of untracked files (an unignored build folder) would flood the list or
    // exceed the output limit; list untracked folders as single entries instead.
    if (r.truncated || (r.code === 0 && countUntracked(r.out) > UNTRACKED_LIMIT)) { r = await status('normal'); untrackedCollapsed = true; }
    if (r.truncated) throw new GitError('Git output exceeds the size limit', 422);
    check(r);
    const { headOid, branch, upstream, ahead, behind, unborn, files } = parseStatus(r.out);
    return { cwd, machine: w.machine, branch, upstream, ahead, behind, headOid, detached: branch === '(detached)', unborn, files, untrackedCollapsed, repo: remote.code ? null : parseRemote(remote.out.trim()), busy: active.has(`${w.machine}:${cwd}`) };
  }
  async function paths(w: Workspace, s: Pick<Changes, 'cwd' | 'files'>, requested: string[], expandRename = false) {
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
    if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) throw new GitError('Invalid diff path', 400);
    const cwd = await root(w);
    const status = await run(w, ['status', '--porcelain=v2', '-z', `--untracked-files=${path.endsWith('/') ? 'normal' : 'all'}`, '--', path], { cwd, read: true });
    check(status);
    const s = { cwd, files: parseStatus(status.out).files };
    await paths(w, s, [path]);
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
    const [r, defaultRef] = await Promise.all([
      run(w, ['for-each-ref', '--sort=refname', '--sort=-committerdate', '--format=%(HEAD)%00%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(contents:subject)', 'refs/heads', 'refs/remotes/origin'], { cwd, read: true }),
      run(w, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd, read: true }),
    ]);
    check(r);
    const local: Branches['local'] = [], remote: string[] = [];
    let current = '';
    for (const line of r.out.trim().split('\n').filter(Boolean)) {
      const [head = '', ref = '', upstream = '', track = '', date = '', subject = ''] = line.split('\0');
      if (ref.startsWith('refs/remotes/')) { const name = ref.slice(13); if (name !== 'origin/HEAD') remote.push(name); continue; }
      const name = ref.slice(11);
      if (head === '*') current = name;
      local.push({ name, upstream, ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), date, subject });
    }
    // A remote branch that already has a local branch of the same name is listed once, as the local branch.
    const names = new Set(local.map(l => l.name));
    // Prefer origin's recorded default. Repositories without it use the conventional local default.
    const defaultName = defaultRef.code === 0
      ? defaultRef.out.trim().replace(/^refs\/remotes\/origin\//, '')
      : ['main', 'master'].find(name => names.has(name));
    const defaultIndex = local.findIndex(branch => branch.name === defaultName);
    if (defaultIndex > 0) local.unshift(...local.splice(defaultIndex, 1));
    const remoteBranches = remote.filter(name => !names.has(name.slice(7)));
    const remoteDefaultIndex = remoteBranches.indexOf(`origin/${defaultName}`);
    if (remoteDefaultIndex > 0) remoteBranches.unshift(...remoteBranches.splice(remoteDefaultIndex, 1));
    return { current, local, remote: remoteBranches, default: defaultName ?? null };
  }
  /** Stash entries, newest first. */
  async function stashes(w: Workspace) {
    const cwd = await root(w);
    const r = await run(w, ['stash', 'list', '--format=%gd%x1f%cI%x1f%gs'], { cwd, read: true }); check(r);
    return r.out.split('\n').filter(Boolean).map(line => {
      const [ref = '', date = '', subject = ''] = line.split('\x1f');
      return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? -1), date, subject };
    }).filter(e => e.index >= 0);
  }
  async function mutate(w: Workspace, action: string, body: Record<string, unknown>) {
    const s = await changes(w), key = `${w.machine}:${s.cwd}`;
    if (active.has(key)) throw new GitError('Another Git action is running', 409);
    active.add(key);
    let summary = '';
    try {
      let args: string[] = [], network = false;
      if (action === 'stage' || action === 'unstage') {
        // `all` acts on the whole repository, so it needs no per-path validation.
        const selected = body.all === true ? ['.'] : await paths(w, s, body.paths as string[], action === 'unstage');
        args = action === 'stage' ? (body.all === true ? ['add', '-A'] : ['add', '--', ...selected]) : s.unborn ? ['rm', '--cached', '-r', '-f', '--', ...selected] : ['restore', '--staged', '--', ...selected];
      } else if (action === 'discard') {
        const selected = await paths(w, s, body.paths as string[], false);
        const byPath = new Map(s.files.map(f => [f.path, f]));
        // Discarding is permanent: a staged file must be unstaged first so that nothing is lost by accident.
        for (const path of selected) {
          const f = byPath.get(path);
          if (f?.staged) throw new GitError(`Unstage ${path} before discarding it`, 409);
          if (f?.conflict) throw new GitError(`Resolve ${path} before discarding it`, 409);
        }
        const untracked = selected.filter(p => byPath.get(p)?.untracked), tracked = selected.filter(p => !byPath.get(p)?.untracked);
        if (tracked.length) check(await run(w, ['restore', '--worktree', '--', ...tracked], { cwd: s.cwd }));
        if (untracked.length) check(await run(w, ['clean', '-f', '-d', '--', ...untracked], { cwd: s.cwd }));
        args = ['status', '--short'];
      } else if (action === 'stash') {
        if (s.unborn) throw new GitError('Commit once before stashing', 400);
        if (!s.files.length) throw new GitError('There are no changes to stash', 400);
        args = ['stash', 'push', ...(body.includeUntracked === true ? ['--include-untracked'] : []), ...(body.message ? ['-m', body.message as string] : [])];
      } else if (action === 'stash-pop' || action === 'stash-drop') {
        const index = body.index as number, list = await stashes(w);
        if (!list.some(e => e.index === index)) throw new GitError('That stash no longer exists. Refresh the list.', 409);
        if (action === 'stash-pop' && s.files.some(f => f.conflict)) throw new GitError('Resolve conflicts before applying a stash', 409);
        args = ['stash', action === 'stash-pop' ? 'pop' : 'drop', `stash@{${index}}`];
      } else if (action === 'commit') {
        const amend = body.amend === true;
        if (s.files.some(f => f.conflict)) throw new GitError('Resolve conflicts before committing', 409);
        if (amend) {
          if (s.unborn || !s.headOid) throw new GitError('There is no commit to amend', 400);
          // Rewriting a commit that origin already has would diverge from it.
          if (s.upstream && s.ahead === 0 && body.force !== true) throw new GitError('confirm-amend: this commit is already pushed. Amending rewrites history.', 409);
        } else if (!s.files.some(f => f.staged)) throw new GitError('Nothing is staged', 400);
        args = ['commit', ...(amend ? ['--amend'] : []), '-m', body.message as string];
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
      // `stash --include-untracked` builds its own pathspecs, which literal mode breaks. It passes no user paths.
      const r = await run(w, args, { cwd: s.cwd, network, globPathspecs: action === 'stash' }); check(r);
      if (action === 'push' && !s.upstream) check(await run(w, ['branch', '--set-upstream-to', `origin/${s.branch}`, s.branch], { cwd: s.cwd }));
      summary = redact((r.out + r.error).trim());
      const state = await changes(w);
      return { changes: state, summary, sha: state.headOid };
    } finally { active.delete(key); }
  }
  /** Resolves a branch, tag, or commit name to a commit oid. Never reads an option. */
  async function resolve(w: Workspace, cwd: string, ref: string) {
    if (!ref || ref.startsWith('-') || ref.length > 255 || /[\0\s]/.test(ref)) throw new GitError('Invalid revision', 400);
    const r = await run(w, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd, read: true });
    if (r.code !== 0 || !OID.test(r.out.trim())) throw new GitError(`Unknown revision: ${ref}`, 404);
    return r.out.trim();
  }
  async function fileStats(w: Workspace, cwd: string, base: string, head: string) {
    const common = ['diff', '--no-ext-diff', '--no-textconv', '-M', '-z', base, head, '--'];
    const [names, stats] = await Promise.all([
      run(w, [...common.slice(0, 5), '--name-status', ...common.slice(5)], { cwd, read: true }),
      run(w, [...common.slice(0, 5), '--numstat', ...common.slice(5)], { cwd, read: true }),
    ]);
    check(names); check(stats);
    const files = parseFiles(names.out, stats.out);
    return { files: files.slice(0, FILE_LIMIT), filesTruncated: files.length > FILE_LIMIT };
  }
  async function emptyTree(w: Workspace, cwd: string) {
    const r = await run(w, ['hash-object', '-t', 'tree', '/dev/null'], { cwd, read: true }); check(r);
    return r.out.trim();
  }
  /** Commit history in topological order. all: every branch, remote branch, and tag. */
  async function log(w: Workspace, options: { all: boolean; skip: number; limit: number }) {
    const cwd = await root(w);
    const head = await run(w, ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, read: true });
    if (head.code !== 0 && !options.all) return { commits: [], more: false };
    const r = await run(w, ['log', '--topo-order', '--decorate=full', `--format=${LOG_FORMAT}`, `--max-count=${options.limit + 1}`, `--skip=${options.skip}`,
      ...(options.all ? ['--branches', '--remotes', '--tags', ...(head.code === 0 ? ['HEAD'] : [])] : ['HEAD']), '--'], { cwd, read: true });
    // An empty repository has no refs for --all; git log then exits nonzero.
    if (r.code !== 0 && /does not have any commits|bad default revision/i.test(r.error)) return { commits: [], more: false };
    check(r);
    const commits = parseLog(r.out);
    return { commits: commits.slice(0, options.limit), more: commits.length > options.limit };
  }
  async function commit(w: Workspace, oid: string): Promise<CommitDetail> {
    if (!/^[0-9a-f]{4,64}$/.test(oid)) throw new GitError('Invalid commit', 400);
    const cwd = await root(w), full = await resolve(w, cwd, oid);
    const r = await run(w, ['show', '-s', '--decorate=full', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%cn%x1f%cI%x1f%B', full, '--'], { cwd, read: true }); check(r);
    const [hash = '', parents = '', author = '', email = '', date = '', refs = '', committer = '', committerDate = '', ...message] = r.out.split('\x1f');
    const parentList = parents.split(' ').filter(Boolean);
    // Merge commits show the changes against their first parent, the same as GitHub.
    const base = parentList[0] ?? await emptyTree(w, cwd);
    return { oid: hash, parents: parentList, author, email, date, refs: parseRefs(refs), committer, committerDate,
      message: redact(message.join('\x1f').trimEnd()), base, ...await fileStats(w, cwd, base, hash) };
  }
  /** Changes on head since it left base (three-dot, the same as a GitHub pull request). */
  async function compare(w: Workspace, baseRef: string, headRef: string): Promise<Compare> {
    const cwd = await root(w);
    const [base, head] = await Promise.all([resolve(w, cwd, baseRef), resolve(w, cwd, headRef)]);
    const mb = await run(w, ['merge-base', base, head], { cwd, read: true });
    if (mb.code !== 0) throw new GitError('The revisions have no common history', 422);
    const mergeBase = mb.out.trim();
    const [counts, list, stats] = await Promise.all([
      run(w, ['rev-list', '--left-right', '--count', `${base}...${head}`, '--'], { cwd, read: true }),
      run(w, ['log', '--topo-order', '--decorate=full', `--format=${LOG_FORMAT}`, '--max-count=251', `${mergeBase}..${head}`, '--'], { cwd, read: true }),
      fileStats(w, cwd, mergeBase, head),
    ]);
    check(counts); check(list);
    const [behind = 0, ahead = 0] = counts.out.trim().split(/\s+/).map(Number);
    const commits = parseLog(list.out);
    return { base, head, mergeBase, ahead, behind, commits: commits.slice(0, 250), commitsTruncated: commits.length > 250, ...stats };
  }
  /** Diff of one file between two commits (or the empty tree). Paths are literal pathspecs. */
  async function rangeDiff(w: Workspace, base: string, head: string, path: string, original?: string) {
    if (!OID.test(base) || !OID.test(head)) throw new GitError('Invalid revision', 400);
    for (const p of [path, ...(original ? [original] : [])]) if (!p || p.startsWith('/') || p.includes('\0')) throw new GitError('Invalid diff path', 400);
    const cwd = await root(w);
    const r = await run(w, ['diff', '--no-ext-diff', '--no-textconv', '-M', base, head, '--', path, ...(original && original !== path ? [original] : [])], { cwd, read: true, limit: 512 << 10, truncate: true });
    check(r);
    return { path, binary: /(?:Binary files|GIT binary patch)/.test(r.out), directory: false, text: redact(r.out), truncated: r.truncated };
  }
  /** The staged diff for drafting a commit message: a file summary plus the patch, cut at 64 KiB and redacted. */
  async function stagedDiff(w: Workspace) {
    const cwd = await root(w);
    const [stat, patch] = await Promise.all([
      run(w, ['diff', '--cached', '--stat', '--no-ext-diff', '--no-textconv'], { cwd, read: true, limit: 64 << 10, truncate: true }),
      run(w, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color'], { cwd, read: true, limit: 64 << 10, truncate: true }),
    ]);
    check(stat); check(patch);
    return { stat: redact(stat.out), patch: redact(patch.out), truncated: patch.truncated };
  }
  return { changes, diff, branches, mutate, log, commit, compare, rangeDiff, stagedDiff, stashes };
}
