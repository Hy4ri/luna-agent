import type { Hono, Context as HonoContext } from "hono";
import { GhError, REPO_PART, createRemoteOrigin, ghStatus, projectRepos, pullFiles } from "../github.js";
import { repoInfo, listItems, type ListFilters } from "../github-list.js";
import { detail, commentsPage } from "../github-detail.js";
import { createGithubCache } from "../github-cache.js";
import * as ghActions from "../github-actions.js";
import * as ghWrite from "../github-write.js";
import { cardInput, itemUrl, linked } from "../github-board.js";
import { context } from "../luna.js";
import { z } from "zod";
import type { RouteCtx } from "./context.js";

export function registerGithub(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err } = ctx;

  const githubCache = createGithubCache();
  const freshGithub = (c: HonoContext) => c.req.query("fresh") === "1";

  /** Resolve a project directory's `origin` remote on the main host or on the execution machine that holds it. */
  const remoteOrigin = createRemoteOrigin(opts.workers);
  // A machine going offline or online changes discovery, so it is part of the cache key.
  const discoverRepos = () => projectRepos(opts.conversations?.projects.list() ?? [], {
    resolveRemote: remoteOrigin,
    key: (opts.workers?.list() ?? []).filter(w => w.online).map(w => w.id).join(","),
  });

  const readDetail = (repo: string, n: number, fresh = false) => {
    const [owner, name] = repo.split("/");
    return githubCache.read(`${repo.toLowerCase()}|detail|${n}`, 15_000, () => detail(owner!, name!, n), fresh);
  };

  const ghFail = (c: HonoContext, e: unknown) =>
    e instanceof GhError
      ? err(c, (e.status === 401 ? 502 : e.status) as 400 | 403 | 404 | 409 | 422 | 500 | 502 | 503 | 504, e.message)
      : err(c, 500, "GitHub request failed");

  const repoOfParam = (c: HonoContext) => {
    const o = c.req.param("owner") ?? "";
    const n = c.req.param("name") ?? "";
    return REPO_PART.test(o) && REPO_PART.test(n) && ![".", ".."].includes(o) && ![".", ".."].includes(n)
      ? `${o}/${n}`
      : null;
  };

  app.get("/v1/github/status", async (c) => {
    try {
      return c.json(await githubCache.read("status", 300_000, ghStatus, freshGithub(c), (value) => value.state === "ok"));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos", async (c) => {
    try {
      return c.json({ repos: await discoverRepos() });
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos/:owner/:name", async (c) => {
    const repo = repoOfParam(c);
    if (!repo) return err(c, 400, "invalid repository name");
    const [owner, name] = repo.split("/");
    try {
      return c.json(
        await githubCache.read(`${repo.toLowerCase()}|info`, 600_000, () => repoInfo(owner!, name!), freshGithub(c)),
      );
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos/:owner/:name/items", async (c) => {
    const repo = repoOfParam(c);
    if (!repo) return err(c, 400, "invalid repository name");
    const kind = c.req.query("kind");
    if (kind !== "pr" && kind !== "issue") return err(c, 400, "kind must be pr or issue");
    const state = c.req.query("state") ?? "open";
    if (!["open", "closed", "all"].includes(state)) return err(c, 400, "invalid state");
    const q = c.req.query("q") ?? "";
    if (q.length > 256) return err(c, 400, "query too long (max 256 chars)");
    const after = c.req.query("after");
    if (after && after.length > 1000) return err(c, 400, "invalid cursor");

    const filters: ListFilters = {};
    for (const key of ["author", "label", "draft", "review"] as const) {
      const v = c.req.query(key);
      if (v) (filters as Record<string, string>)[key] = v;
    }
    try {
      return c.json(
        await githubCache.read(
          `${repo.toLowerCase()}|list|${JSON.stringify([kind, state, q, after ?? null, filters])}`,
          30_000,
          () => listItems(repo, kind, state as "open" | "closed" | "all", q, after, filters),
          freshGithub(c),
        ),
      );
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.get("/v1/github/repos/:owner/:name/items/:number", async (c) => {
    const repo = repoOfParam(c);
    if (!repo) return err(c, 400, "invalid repository name");
    const numStr = c.req.param("number");
    const n = Number(numStr);
    if (!Number.isSafeInteger(n) || n < 1) return err(c, 400, "invalid item number");
    try {
      return c.json(await readDetail(repo, n, freshGithub(c)));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  const ghNumber = (c: HonoContext) => {
    const raw = c.req.param("number") ?? "";
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new GhError("invalid item number", 400);
    return n;
  };
  const ghRepo = (c: HonoContext) => {
    const repo = repoOfParam(c);
    if (!repo) throw new GhError("invalid repository name", 400);
    return repo;
  };

  app.get("/v1/github/repos/:owner/:name/pulls/:number/files", async (c) => {
    try {
      const repo = ghRepo(c),
        n = ghNumber(c),
        page = Number(c.req.query("page") ?? 1);
      // GitHub lists at most 3000 files: 30 pages of 100.
      if (!Number.isSafeInteger(page) || page < 1 || page > 30) throw new GhError("Invalid page", 400);
      return c.json(
        await githubCache.read(
          `${repo.toLowerCase()}|files|${n}|${page}`,
          15_000,
          () => pullFiles(repo, n, page),
          freshGithub(c),
        ),
      );
    } catch (e) {
      return ghFail(c, e);
    }
  });

  const ghBody = async <T>(c: HonoContext, schema: z.ZodType<T>): Promise<T> => {
    const result = schema.safeParse(await c.req.json().catch(() => null));
    if (!result.success)
      throw new GhError(result.error.issues.map((i) => i.message).join("; ").slice(0, 300), 400);
    return result.data;
  };

  app.get("/v1/github/repos/:owner/:name/items/:number/comments", async (c) => {
    try {
      const repo = ghRepo(c),
        n = ghNumber(c),
        before = c.req.query("before");
      if (!before || before.length > 1000) throw new GhError("Invalid comments cursor", 400);
      const [owner, name] = repo.split("/");
      return c.json(await commentsPage(owner!, name!, n, before));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  const githubWrite = async <T>(c: HonoContext, action: () => Promise<T>): Promise<T> => {
    const repo = ghRepo(c);
    try {
      return await action();
    } finally {
      githubCache.invalidateRepo(repo);
    }
  };

  const commentBody = z.strictObject({ body: z.string().trim().min(1).max(65536) });
  const stateBody = z.strictObject({
    kind: z.enum(["pr", "issue"]),
    state: z.enum(["open", "closed"]),
    reason: z.enum(["completed", "not_planned"]).optional(),
  });
  const shaBody = z.strictObject({ sha: z.string().regex(/^[0-9a-f]{40}$/) });
  const mergeBody = shaBody.extend({ method: z.enum(["merge", "squash", "rebase"]) });

  app.post("/v1/github/repos/:owner/:name/items/:number/comments", async (c) => {
    try {
      const b = await ghBody(c, commentBody);
      return await githubWrite(c, async () => c.json(await ghActions.comment(ghRepo(c), ghNumber(c), b.body)));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.post("/v1/github/repos/:owner/:name/items/:number/state", async (c) => {
    try {
      const b = await ghBody(c, stateBody);
      return await githubWrite(c, async () =>
        c.json(await ghActions.setState(ghRepo(c), b.kind, ghNumber(c), b.state, b.reason)),
      );
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.post("/v1/github/repos/:owner/:name/pulls/:number/merge", async (c) => {
    try {
      const b = await ghBody(c, mergeBody);
      return await githubWrite(c, async () =>
        c.json(await ghActions.merge(ghRepo(c), ghNumber(c), b.method, b.sha)),
      );
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.post("/v1/github/repos/:owner/:name/pulls/:number/delete-branch", async (c) => {
    try {
      const b = await ghBody(c, shaBody);
      return await githubWrite(c, async () => c.json(await ghActions.deleteBranch(ghRepo(c), ghNumber(c), b.sha)));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  const text = (max: number) => z.string().max(max);
  const names = z.array(z.string().min(1).max(100)).max(30);
  const sha40 = z.string().regex(/^[0-9a-f]{40}$/);

  app.get("/v1/github/repos/:owner/:name/labels", async (c) => {
    try { return c.json({ labels: await githubCache.read(`${ghRepo(c).toLowerCase()}|labels`, 120_000, () => ghWrite.repoLabels(ghRepo(c)), freshGithub(c)) }); } catch (e) { return ghFail(c, e); }
  });
  app.get("/v1/github/repos/:owner/:name/assignees", async (c) => {
    try { return c.json({ assignees: await githubCache.read(`${ghRepo(c).toLowerCase()}|assignees`, 120_000, () => ghWrite.repoAssignees(ghRepo(c)), freshGithub(c)) }); } catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/issues", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ title: z.string().trim().min(1).max(256), body: text(65536).optional(), labels: names.optional(), assignees: names.optional() }));
      return await githubWrite(c, async () => c.json(await ghWrite.createIssue(ghRepo(c), b)));
    } catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/pulls", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ title: z.string().trim().min(1).max(256), head: z.string().min(1).max(255), base: z.string().min(1).max(255), body: text(65536).optional(), draft: z.boolean().optional() }));
      return await githubWrite(c, async () => c.json(await ghWrite.createPull(ghRepo(c), b)));
    } catch (e) { return ghFail(c, e); }
  });
  app.patch("/v1/github/repos/:owner/:name/items/:number", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ kind: z.enum(["pr", "issue"]), title: z.string().trim().min(1).max(256).optional(), body: text(65536).optional(), labels: names.optional(), assignees: names.optional() }));
      const { kind, ...patch } = b;
      return await githubWrite(c, async () => c.json(await ghWrite.editItem(ghRepo(c), kind, ghNumber(c), patch)));
    } catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/pulls/:number/review", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: text(65536).optional(), sha: sha40 }));
      return await githubWrite(c, async () => c.json(await ghWrite.review(ghRepo(c), ghNumber(c), b)));
    } catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/pulls/:number/draft", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ draft: z.boolean() }));
      return await githubWrite(c, async () => c.json(await ghWrite.setDraft(ghRepo(c), ghNumber(c), b.draft)));
    } catch (e) { return ghFail(c, e); }
  });
  app.post("/v1/github/repos/:owner/:name/pulls/:number/update-branch", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ sha: sha40 }));
      return await githubWrite(c, async () => c.json(await ghWrite.updatePullBranch(ghRepo(c), ghNumber(c), b.sha)));
    } catch (e) { return ghFail(c, e); }
  });

  app.delete("/v1/github/repos/:owner/:name/issues/:number", async (c) => {
    try {
      const b = await ghBody(c, z.strictObject({ confirm: z.number().int().positive() }));
      return await githubWrite(c, async () => c.json(await ghActions.deleteIssue(ghRepo(c), ghNumber(c), b.confirm)));
    } catch (e) {
      return ghFail(c, e);
    }
  });

  const ghProjects = async (repo: string) => {
    if (!opts.conversations) throw new GhError("projects disabled", 404);
    const repos = await discoverRepos();
    return repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.projects ?? [];
  };

  app.get("/v1/github/repos/:owner/:name/items/:number/cards", async (c) => {
    try {
      const repo = ghRepo(c),
        n = ghNumber(c),
        kind = c.req.query("kind");
      if (kind !== "pr" && kind !== "issue") throw new GhError("kind must be pr or issue", 400);
      const projects = await ghProjects(repo),
        url = itemUrl(repo, kind, n);
      const cards = projects.flatMap((p) =>
        [false, true].flatMap((archived) =>
          opts
            .conversations!.board.list(p.id, { archived })
            .filter((card) => linked(card.description, url))
            .map((card) => ({ project: p.id, id: card.id, status: card.status, archived: card.archived })),
        ),
      );
      return c.json({ projects, cards });
    } catch (e) {
      return ghFail(c, e);
    }
  });

  app.post("/v1/github/repos/:owner/:name/items/:number/card", async (c) => {
    try {
      const repo = ghRepo(c),
        n = ghNumber(c),
        b = await ghBody(c, z.strictObject({ project: z.number().int().positive() }));
      return await githubWrite(c, () =>
        ghActions.withItemLock(repo, n, async () => {
          const projects = await ghProjects(repo);
          if (!projects.some((p) => p.id === b.project))
            throw new GhError("Project does not use this repository", 400);
          const d = await readDetail(repo, n),
            url = itemUrl(repo, d.kind, n),
            conv = opts.conversations!;
          // Deduplication and creation share the serialized harness transaction.
          const result = await harness.commit(async () => {
            const existing = [false, true]
              .flatMap((archived) => conv.board.list(b.project, { archived }))
              .find((card) => linked(card.description, url));
            return existing
              ? { card: existing, created: false }
              : { card: conv.board.create(b.project, cardInput(repo, d)), created: true };
          }, context);
          conv.touch();
          return c.json(result.card, result.created ? 201 : 200);
        }),
      );
    } catch (e) {
      return ghFail(c, e);
    }
  });
}
