// Auto-worktree: a project with `autoWorktree` isolates a session's first write in its own git worktree.
// Questions never allocate one. The beforeTool hook refuses the first edit/write inside the main checkout and points the
// model at `session_worktree`; that tool creates the worktree through the session's own environment (host or worker),
// switches the session directory into it, and later removes it once its branch has merged.
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, ToolTask, defineDoc, defineExtension, defineTool, hook, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { ProjectStore } from "./projects.js";
import { WorkspaceSwitch, switchWorkspace } from "./session-workspace.js";
import { ExecTarget } from "./workers.js";
import { StringEnum } from "./string-enum.js";

type Active = { root: string; path: string; branch: string; baseRef: string };
// Forks start with the initial value, so a fork never shares its parent's working tree.
const SessionWorktree = defineDoc<{ active: Active | null }>({
  kind: "luna.session-worktree", version: 1, scope: "conversation", history: "latest", fork: "initial",
  checkpointWhen: () => false, initial: () => ({ active: null }),
});

const WRITE_TOOLS = new Set(["edit", "write"]);
const WORKTREE_DIR = ".luna-worktrees";
const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** Branch name for a session: `luna/s<id>-<title-slug>`, or `luna/s<id>` while it has no usable title. */
export function sessionBranchName(id: number, title: string | null | undefined): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug ? `luna/s${id}-${slug}` : `luna/s${id}`;
}

const GIT_ENV = { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
async function run(env: ExecutionEnv, context: Context, cwd: string, command: readonly string[], timeout = 120) {
  let out = "", err = "";
  const result = await env.exec(command, {
    cwd, timeout, env: GIT_ENV,
    onOutput: (text, _c, info) => { if (info.stream === "stderr") err += text; else out += text; },
  }, context);
  if (!result.ok) throw new Error(`${command[0]} could not run: ${result.error.message}`);
  return { code: result.value.exitCode, out: out.trim(), err: err.trim() };
}
async function git(env: ExecutionEnv, context: Context, cwd: string, ...args: string[]) {
  const r = await run(env, context, cwd, ["git", ...args]);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).slice(0, 500)}`);
  return r.out;
}
async function gitOk(env: ExecutionEnv, context: Context, cwd: string, ...args: string[]) {
  return (await run(env, context, cwd, ["git", ...args])).code === 0;
}
async function registered(env: ExecutionEnv, context: Context, root: string, path: string) {
  const list = await git(env, context, root, "worktree", "list", "--porcelain", "-z");
  return list.split("\0").some(field => field === `worktree ${path}`);
}
/** origin's default branch, or the first of main/master that exists, or HEAD when the repository has no remote. */
async function baseRefFor(env: ExecutionEnv, context: Context, root: string) {
  const head = await run(env, context, root, ["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out) return head.out;
  for (const ref of ["origin/main", "origin/master"]) if (await gitOk(env, context, root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) return ref;
  return "HEAD";
}

type Deps = { projects: () => ProjectStore | undefined; title: (id: number) => string | null | undefined };

export function createSessionWorktreeExtension(deps: Deps) {
  // Host sessions only: the dirty-state guard reads the main checkout directly. The last seen state keeps one warning per change.
  const seen = new Map<number, string>();

  /** The project's main checkout for this session, when auto-worktree applies. */
  async function scope(api: { snapshot: ToolExecutionApi["snapshot"] }, id: ConversationId, context: Context) {
    const store = deps.projects();
    const projectId = store?.projectOf(Number(id));
    const project = projectId === undefined ? undefined : store!.get(projectId);
    if (!project || project.general || !project.autoWorktree) return undefined;
    const worker = (await api.snapshot(ExecTarget, id, context))?.worker ?? null;
    const root = store!.dirFor(project.id, worker);
    if (!root || !posix.isAbsolute(root)) return undefined;
    const cwd = (await api.snapshot(AgentDoc, id, context))?.cwd ?? root;
    return { project, root: posix.normalize(root).replace(/\/$/, "") || "/", cwd: posix.normalize(cwd), worker };
  }

  /** Record the main checkout's state for a host session without a worktree; returns what changed since the last look. */
  async function snapshotMain(api: { conversationId: ConversationId; snapshot: ToolExecutionApi["snapshot"] }, context: Context) {
    const sc = await scope(api, api.conversationId, context);
    if (!sc || sc.worker !== null || !within(sc.cwd, sc.root)) return undefined;
    if ((await api.snapshot(SessionWorktree, api.conversationId, context))?.active) return undefined;
    let porcelain = "";
    try {
      const res = Bun.spawnSync(["git", "-C", sc.root, "--no-optional-locks", "status", "--porcelain"], {
        timeout: 10_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (res.exitCode === 0 && res.stdout) {
        porcelain = Buffer.from(res.stdout).toString("utf8");
      }
    } catch { return undefined; }
    const digest = new Bun.CryptoHasher("sha1").update(porcelain).digest("hex"), id = Number(api.conversationId), before = seen.get(id);
    seen.set(id, digest);
    return { sc, porcelain, digest, before };
  }

  const tool = defineTool({
    name: "session_worktree",
    description: "Manage where this session works. start (default): give this session its own git worktree and branch (luna/s<id>-<title>), cut from origin's default branch, and switch into it. Call it before your first edit when a project has auto-worktree on; edit/write refuse until then. switch: activate an existing directory (path) on this machine as the workspace for file and shell tools and the Git UI; running processes keep their directories. finish: remove the worktree and branch once the branch has merged and the tree is clean, and return to the main checkout.",
    parameters: Type.Object({
      action: Type.Optional(StringEnum(["start", "switch", "finish"], { default: "start" })),
      path: Type.Optional(Type.String({ minLength: 1, description: "switch: absolute directory path on this session's current machine." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    replay: "safe",
    execute: async ({ action, path: target }, api, context) => {
      if (!api.env) throw new Error("This session has no execution environment.");
      const env = api.env, id = api.conversationId;
      const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

      if (action === "switch") {
        const switched = (cwd: string) => reply(`Active workspace: ${cwd}. Subsequent file and shell tools and the Git UI use this directory. Existing processes keep their original directories.`);
        const previous = await api.snapshot(WorkspaceSwitch, api.taskId, context);
        if (previous?.cwd) return switched(previous.cwd);
        if (!target || !target.trim() || !posix.isAbsolute(target) || target.includes("\0")) throw new Error("switch needs path: an absolute directory path.");
        const absolute = await env.absolutePath(target, context);
        if (!absolute.ok) throw new Error(absolute.error.message);
        // Validate through the session environment, including worker routing. Never inspect a worker path on the host.
        const directory = await env.openDirReader(absolute.value, context);
        if (!directory.ok) throw new Error(`Cannot activate workspace: ${directory.error.message}`);
        await directory.value.close(context);
        return switched(await switchWorkspace(api, absolute.value, context));
      }
      if (target !== undefined) throw new Error(`path applies only to action 'switch'.`);
      const state = await api.snapshot(SessionWorktree, id, context);
      let active = state?.active ?? null;

      if (action === "finish") {
        if (!active) return reply("This session has no worktree. Nothing to finish.");
        const { root, path, branch } = active;
        const exists = await registered(env, context, root, path);
        if (exists) {
          if ((await git(env, context, path, "status", "--porcelain", "--untracked-files=all")))
            throw new Error(`Worktree ${path} has uncommitted changes. Commit or discard them first; nothing was removed.`);
          await run(env, context, root, ["git", "fetch", "--quiet", "origin"]);
          const base = await baseRefFor(env, context, root), tip = await git(env, context, path, "rev-parse", "HEAD");
          let merged = await gitOk(env, context, path, "merge-base", "--is-ancestor", tip, base);
          if (!merged) {
            // Squash and rebase merges leave the branch tip outside the default branch; ask GitHub about this exact tip.
            const gh = await run(env, context, path, ["gh", "pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--limit", "5"]).catch(() => undefined);
            try { merged = gh?.code === 0 && (JSON.parse(gh.out) as { headRefOid: string }[]).some(pr => pr.headRefOid === tip); } catch { merged = false; }
          }
          if (!merged) throw new Error(`Branch ${branch} is not merged into ${base} (checked ancestry and merged PRs for tip ${tip.slice(0, 8)}). Nothing was removed.`);
        }
        // Leave the directory before deleting it, then clear the record so the next write allocates a fresh worktree.
        const cwd = await switchWorkspace(api, root, context);
        if (exists) await git(env, context, root, "worktree", "remove", "--force", path);
        if (await gitOk(env, context, root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) await git(env, context, root, "branch", "-D", branch);
        await api.commit(async tx => { (await tx.doc(SessionWorktree, id)).active = null; }, context);
        return reply(`Removed worktree ${path} and branch ${branch}. Active workspace: ${cwd}. The next edit creates a new worktree from the updated default branch.`);
      }

      if (!active) {
        const sc = await scope({ snapshot: api.snapshot.bind(api) }, id, context);
        const agent = await api.agent(context);
        const start = sc?.root ?? agent.cwd;
        if (!start) throw new Error("No project directory or session directory to isolate.");
        const root = posix.normalize(await git(env, context, start, "rev-parse", "--show-toplevel"));
        if (await git(env, context, start, "rev-parse", "--is-inside-work-tree") !== "true") throw new Error("Not a git working tree.");
        await run(env, context, root, ["git", "fetch", "--quiet", "origin"]); // A failed fetch only means a staler base.
        const baseRef = await baseRefFor(env, context, root);
        let branch = sessionBranchName(Number(id), deps.title(Number(id))), n = 1;
        while (await gitOk(env, context, root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) branch = `${sessionBranchName(Number(id), deps.title(Number(id)))}-${++n}`;
        const path = posix.join(posix.dirname(root), WORKTREE_DIR, `${posix.basename(root)}-s${Number(id)}${n > 1 ? `-${n}` : ""}`);
        // Record the allocation before git runs, so a recovered call finishes this worktree and never makes a second.
        active = await api.commit(async tx => {
          const doc = await tx.doc(SessionWorktree, id);
          if (!doc.active) doc.active = { root, path, branch, baseRef };
          return JSON.parse(JSON.stringify(doc.active)) as Active;
        }, context);
      }

      let note = "";
      if (!(await registered(env, context, active.root, active.path))) {
        if (await gitOk(env, context, active.root, "show-ref", "--verify", "--quiet", `refs/heads/${active.branch}`) && !(await gitOk(env, context, active.root, "rev-parse", "--verify", "--quiet", `${active.branch}^{commit}`)))
          throw new Error(`Branch ${active.branch} is unusable.`);
        const created = await run(env, context, active.root, ["git", "worktree", "add", "-b", active.branch, active.path, active.baseRef]);
        // A recovered call may have created the branch already; attach the worktree to it.
        if (created.code !== 0) await git(env, context, active.root, "worktree", "add", active.path, active.branch);
        const setup = deps.projects()?.get(deps.projects()!.projectOf(Number(id)) ?? -1)?.worktreeSetup;
        if (setup) {
          const r = await run(env, context, active.path, ["sh", "-c", setup], 900);
          note = r.code === 0 ? ` Setup command succeeded.` : ` Setup command failed (exit ${r.code}): ${(r.err || r.out).slice(-400)}`;
        }
      }
      const cwd = await switchWorkspace(api, active.path, context);
      return reply(`Active workspace: ${cwd} (branch ${active.branch}, from ${active.baseRef}).${note} Paths under ${active.root} now map to this worktree for edit and write. Run 'session_worktree' with action 'finish' after the PR merges.`);
    },
  });

  return defineExtension({
    name: "session-worktree",
    tools: [tool],
    hooks: [hook(ToolTask, {
      async beforeTool(call, api, context) {
        if (call.parent) return undefined;
        if (call.name === "bash") { await snapshotMain(api, context); return undefined; }
        if (!WRITE_TOOLS.has(call.name)) return undefined;
        const path = (call.arguments as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string" || path.includes("\0")) return undefined;
        const sc = await scope(api, api.conversationId, context);
        if (!sc) return undefined;
        const active = (await api.snapshot(SessionWorktree, api.conversationId, context))?.active;
        const target = posix.isAbsolute(path) ? posix.normalize(path) : posix.join(sc.cwd, path);
        if (active) {
          // Map absolute paths into the main checkout onto the worktree, so a stale path cannot edit the main tree.
          if (posix.isAbsolute(path) && within(target, active.root) && !within(target, active.path) && !target.includes(`/${WORKTREE_DIR}/`))
            return { arguments: { ...call.arguments, path: posix.join(active.path, posix.relative(active.root, target)) } };
          return undefined;
        }
        if (within(sc.cwd, sc.root) && within(target, sc.root) && !target.includes(`/${WORKTREE_DIR}/`))
          return { block: `Auto-worktree is on for project "${sc.project.name}": call session_worktree first, then repeat this ${call.name}. It gives this session its own branch, and paths under ${sc.root} map to it automatically.` };
        return undefined;
      },
      async afterTool(call, result, api, context) {
        if (call.parent || call.name !== "bash") return undefined;
        const now = await snapshotMain(api, context);
        if (!now) return undefined;
        const { sc, porcelain, digest, before } = now;
        // beforeTool recorded the baseline, so a different state means this command changed the tree.
        if (before === undefined || before === digest || !porcelain.trim()) return undefined;
        return { ...result, diagnostics: [...(result.diagnostics ?? []), { severity: "warn" as const, code: "main_checkout_dirty",
          message: `This command changed the main checkout of "${sc.project.name}", which has auto-worktree on. Call session_worktree before further changes, then move or redo this work there.` }] };
      },
    })],
  });
}
