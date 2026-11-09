import type { Hono, Context as HonoContext } from "hono";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createGitControl, GitError, type Workspace } from "../git-control.js";
import { createGitStatusReader } from "../git-status.js";
import { resolveProjectTarget } from "../git-target.js";
import { draftCommitMessage } from "../commit-message.js";
import { ExecTarget } from "../workers.js";
import { context } from "../luna.js";
import { z } from "zod";
import type { RouteCtx } from "./context.js";

export function registerGit(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv } = ctx;

  const readGitStatus = createGitStatusReader();
  const gitControl = createGitControl();

  const sessionEnv = async (id: string): Promise<Workspace> => {
    const conv = await getConv(id);
    if (!conv) throw new GitError("No such session", 404);
    const worker = (await harness.snapshot(ExecTarget, conv.id, context))?.worker ?? null;
    const cwd = (await conv.agent(context)).cwd ?? undefined;
    if (worker !== null && !opts.workers?.view(worker)?.online) throw new GitError("Machine unavailable", 503);
    return {
      machine: worker === null ? "main" : String(worker),
      env: worker === null ? new NodeExecutionEnv({ cwd: cwd ?? opts.cwd ?? process.cwd() }) : opts.workers!.env(worker, cwd),
      commandEnv: worker === null ? undefined : opts.workers!.reviewEnvironment(worker),
    };
  };

  app.get("/v1/sessions/:id/git", async (c) => {
    try {
      const w = await sessionEnv(c.req.param("id"));
      return c.json(await readGitStatus(`${w.machine}:${w.env.cwd}`, w.env, w.commandEnv));
    } catch (e) {
      if (e instanceof GitError && e.status === 404) return err(c, 404, e.message);
      return c.json({ state: "unavailable", message: "Machine unavailable" });
    }
  });

  const gitWorkspace = async (c: HonoContext): Promise<Workspace> => {
    const session = c.req.query("session"),
      project = c.req.query("project");
    if (session && (project || c.req.query("machine"))) throw new GitError("Select either a session or a project", 400);
    if (session) return sessionEnv(session);
    if (!project || !/^\d+$/.test(project)) throw new GitError("Select a session or a project", 400);
    const projects = opts.conversations?.projects;
    if (!projects) throw new GitError("Select a session or a project", 400);
    const t = resolveProjectTarget(Number(project), c.req.query("machine"), {
      project: id => projects.get(id),
      online: id => opts.workers?.view(id)?.online === true,
    });
    if (t.worker === null) return { machine: "main", env: new NodeExecutionEnv({ cwd: t.cwd }) };
    return { machine: String(t.worker), env: opts.workers!.env(t.worker, t.cwd), commandEnv: opts.workers!.reviewEnvironment(t.worker) };
  };

  const gitFail = (c: HonoContext, e: unknown) =>
    e instanceof GitError ? err(c, e.status, e.message) : err(c, 500, "Git operation failed");

  app.get('/v1/git/changes', async c => { try { return c.json(await gitControl.changes(await gitWorkspace(c))); } catch (e) { return gitFail(c, e); } });
  app.get('/v1/git/branches', async c => { try { return c.json(await gitControl.branches(await gitWorkspace(c))); } catch (e) { return gitFail(c, e); } });
  app.get('/v1/git/diff', async c => {
    try {
      const path = c.req.query("path"),
        staged = c.req.query("staged") ?? "0";
      if (!path || !["0", "1"].includes(staged)) throw new GitError("Invalid diff selection", 400);
      return c.json(await gitControl.diff(await gitWorkspace(c), path, staged === "1"));
    } catch (e) {
      return gitFail(c, e);
    }
  });

  app.get('/v1/git/log', async c => {
    try {
      const scope = c.req.query('scope') ?? 'head', skip = Number(c.req.query('skip') ?? 0), limit = Number(c.req.query('limit') ?? 100);
      if (!['head', 'all'].includes(scope) || !Number.isSafeInteger(skip) || skip < 0 || skip > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new GitError('Invalid history selection', 400);
      return c.json(await gitControl.log(await gitWorkspace(c), { all: scope === 'all', skip, limit }));
    } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/commit', async c => {
    try { return c.json(await gitControl.commit(await gitWorkspace(c), c.req.query('oid') ?? '')); } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/compare', async c => {
    try { return c.json(await gitControl.compare(await gitWorkspace(c), c.req.query('base') ?? '', c.req.query('head') ?? '')); } catch (e) { return gitFail(c, e); }
  });
  app.get('/v1/git/range-diff', async c => {
    try {
      const q = (k: string) => c.req.query(k) ?? "";
      if (q("path").length > 4096 || q("original").length > 4096) throw new GitError("Invalid diff path", 400);
      return c.json(
        await gitControl.rangeDiff(
          await gitWorkspace(c),
          q("base"),
          q("head"),
          q("path"),
          q("original") || undefined,
        ),
      );
    } catch (e) {
      return gitFail(c, e);
    }
  });

  app.get('/v1/git/commit-message', c => c.json({ available: !!opts.titler?.available() }));
  // A draft only: the model sees the staged diff and the reply fills the commit box. One paid call per request.
  app.post('/v1/git/commit-message', async c => {
    try {
      const titler = opts.titler;
      if (!titler?.available()) throw new GitError('No auxiliary model is configured', 400);
      const staged = await gitControl.stagedDiff(await gitWorkspace(c));
      const session = c.req.query('session');
      const id = session && opts.conversations ? Number(session) : undefined;
      return c.json({ message: await draftCommitMessage(staged, (system, input) => titler.draft(system, input, Number.isInteger(id) ? id : undefined)) });
    } catch (e) { return gitFail(c, e); }
  });

  const gitPaths = z.strictObject({ paths: z.array(z.string().min(1).max(4096)).min(1).max(500) });
  const gitAll = z.strictObject({ all: z.literal(true) });
  const gitSchemas = {
    stage: z.union([gitPaths, gitAll]),
    unstage: z.union([gitPaths, gitAll]),
    commit: z.strictObject({ message: z.string().trim().min(1).max(10000), amend: z.boolean().optional(), force: z.boolean().optional() }),
    switch: z.strictObject({
      branch: z.string().min(1).max(255),
      create: z.boolean().optional(),
      from: z.string().min(1).max(255).optional(),
    }),
    fetch: z.strictObject({}),
    pull: z.strictObject({}),
    push: z.strictObject({
      expectedBranch: z.string().min(1).max(255),
      expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
      setUpstream: z.boolean().optional(),
      confirmDefault: z.boolean().optional(),
    }),
  };

  for (const action of Object.keys(gitSchemas) as (keyof typeof gitSchemas)[]) app.post(`/v1/git/${action}`, async c => {
      try {
        const b = gitSchemas[action].safeParse(await c.req.json().catch(() => null));
        if (!b.success)
          throw new GitError(b.error.issues.map((i) => i.message).join("; ").slice(0, 300), 400);
        const w = await gitWorkspace(c);
        try {
          const r = await gitControl.mutate(w, action, b.data);
          r.changes.busy = false;
          return c.json(r);
        } finally {
          readGitStatus.invalidate();
        }
      } catch (e) {
        return gitFail(c, e);
      }
    });
}
