import type { Hono, Context as HonoContext } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BoardError, MAX_ATTACHMENT_BYTES } from "../board.js";
import { answerEvent, cardEvents, deliverCardEvents, ownerSession, wakeEvents } from "../board-events.js";
import { ProjectError } from "../projects.js";
import type { ConversationStore } from "../conversations.js";
import { scanSkills } from "../skills.js";
import { context } from "../luna.js";
import type { RouteCtx } from "./context.js";

export function registerProjects(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err } = ctx;

  // ---- projects: a named working directory that new sessions inherit ----
  const projectId = (c: HonoContext) => {
    const n = Number(c.req.param("id"));
    return Number.isSafeInteger(n) && n >= 0 ? n : -1;
  };

  app.get("/v1/projects", (c) =>
    opts.conversations ? c.json({ projects: opts.conversations.projects.list() }) : err(c, 404, "projects disabled"),
  );

  app.post("/v1/projects", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      cwd?: unknown;
      worker?: unknown;
      workerCwd?: unknown;
    };
    const hasWorker = b.worker !== undefined || b.workerCwd !== undefined;
    if (hasWorker) {
      if (!Number.isSafeInteger(b.worker) || (b.worker as number) < 1) return err(c, 400, "invalid worker");
      const worker = b.worker as number;
      if (!opts.workers?.store.get(worker)) return err(c, 404, "no such worker");
      let hostCwd: unknown = b.cwd ?? "";
      let workerCwd: unknown = b.workerCwd;
      if (workerCwd === undefined && typeof hostCwd === "string" && hostCwd.trim() !== "") {
        workerCwd = hostCwd;
        hostCwd = "";
      }
      return c.json(opts.conversations.projects.create(b.name, hostCwd, { worker, workerCwd }), 201);
    }
    return c.json(opts.conversations.projects.create(b.name, b.cwd), 201);
  });

  app.patch("/v1/projects/:id", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown; cwd?: unknown; favorite?: unknown; color?: unknown; icon?: unknown; autoWorktree?: unknown; worktreeSetup?: unknown };
    return c.json(opts.conversations.projects.update(projectId(c), b));
  });

  // Link a project to a machine: one project, one board, a working directory per machine.
  const workerParam = (c: HonoContext) => {
    const n = Number(c.req.param("worker"));
    return Number.isSafeInteger(n) && n > 0 ? n : -1;
  };

  app.put("/v1/projects/:id/machines/:worker", async (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    const w = workerParam(c);
    if (!opts.workers?.store.get(w)) return err(c, 404, "no such worker");
    const b = (await c.req.json().catch(() => ({}))) as { cwd?: unknown };
    const project = opts.conversations.projects.setWorkerDir(projectId(c), w, b.cwd);
    opts.conversations.touch();
    return c.json(project);
  });

  app.delete("/v1/projects/:id/machines/:worker", (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    // "main" is the host. Removing a machine never touches the board; only deleting the project does.
    const project =
      c.req.param("worker") === "main"
        ? opts.conversations.projects.removeHostDir(projectId(c))
        : opts.conversations.projects.removeWorkerDir(projectId(c), workerParam(c));
    opts.conversations.touch();
    return c.json(project);
  });

  app.delete("/v1/projects/:id", (c) => {
    if (!opts.conversations) return err(c, 404, "projects disabled");
    opts.conversations.projects.delete(projectId(c));
    opts.conversations.touch();
    return c.json({ ok: true });
  });

  // ---- per-project skill overrides: on, off, or inherit the global setting ----
  const skillsOf = (c: HonoContext) => {
    if (!opts.conversations) throw new ProjectError(404, "projects disabled");
    if (!opts.skillDirs) throw new ProjectError(404, "skills disabled");
    const id = projectId(c);
    if (!opts.conversations.projects.get(id)) throw new ProjectError(404, "no such project");
    return { conv: opts.conversations, id, dirs: opts.skillDirs };
  };

  /** Each skill with its global state, project override, and effective state. */
  const projectSkillList = (conv: ConversationStore, id: number, dirs: readonly string[]) => {
    const off = opts.settings?.read().disabledSkills ?? [];
    const over = id === 0 ? new Map<string, boolean>() : conv.projectSkills.overrides(id);
    const only = id !== 0 && conv.projectSkills.onlyChosen(id);
    return scanSkills(dirs).map((s) => {
      const global = !off.includes(s.name), override = over.get(s.name) ?? null;
      return { name: s.name, description: s.description, global, override, effective: only ? override === true : override ?? global };
    });
  };

  app.get("/v1/projects/:id/skills", (c) => {
    const { conv, id, dirs } = skillsOf(c);
    return c.json(projectSkillList(conv, id, dirs));
  });

  app.get("/v1/projects/:id/skill-mode", (c) => {
    const { conv, id } = skillsOf(c);
    return c.json({ onlyChosen: id !== 0 && conv.projectSkills.onlyChosen(id) });
  });

  app.put("/v1/projects/:id/skill-mode", async (c) => {
    const { conv, id, dirs } = skillsOf(c);
    if (id === 0) throw new ProjectError(409, "The General project uses the global skill settings");
    const b = (await c.req.json().catch(() => null)) as { onlyChosen?: unknown } | null;
    if (!b || typeof b.onlyChosen !== "boolean") throw new ProjectError(400, "onlyChosen must be a boolean");
    if (b.onlyChosen !== conv.projectSkills.onlyChosen(id)) {
      // Keep the active set unchanged at the switch: only skills added later behave differently.
      const active = b.onlyChosen ? projectSkillList(conv, id, dirs).filter(s => s.effective).map(s => s.name) : [];
      conv.projectSkills.setOnlyChosen(id, b.onlyChosen, active);
      conv.touch();
    }
    return c.json({ ok: true });
  });

  app.put("/v1/projects/:id/skills/:name", async (c) => {
    const { conv, id, dirs } = skillsOf(c);
    if (id === 0) throw new ProjectError(409, "The General project uses the global skill settings");
    const name = c.req.param("name");
    if (!scanSkills(dirs).some((s) => s.name === name)) throw new ProjectError(404, "no such skill");
    const b = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!b || (b.enabled !== null && typeof b.enabled !== "boolean"))
      throw new ProjectError(400, "enabled must be true, false, or null");
    conv.projectSkills.set(id, name, b.enabled);
    conv.touch();
    return c.json({ ok: true });
  });

  // ---- project board: cards shared by the user and the project's sessions ----
  const boardOf = (c: HonoContext) => {
    const conv = opts.conversations;
    if (!conv) throw new ProjectError(404, "projects disabled");
    const id = projectId(c);
    if (!conv.projects.get(id)) throw new ProjectError(404, "no such project");
    return { conv, id };
  };

  const cardId = (c: HonoContext) => {
    const n = Number(c.req.param("cardId"));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };

  // Writes go through a harness commit, like other stored metadata, so they never interleave with another transaction.
  const write = async <T>(conv: NonNullable<typeof opts.conversations>, fn: () => T): Promise<T> => {
    const r = await harness.commit(async () => fn(), context);
    conv.touch();
    return r;
  };

  app.get("/v1/projects/:id/board", (c) => {
    const { conv, id } = boardOf(c);
    return c.json({ cards: conv.board.list(id, { archived: c.req.query("archived") === "1" }) });
  });

  app.post("/v1/projects/:id/cards", async (c) => {
    const { conv, id } = boardOf(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(await write(conv, () => conv.board.create(id, b)), 201);
  });

  app.patch("/v1/projects/:id/cards/:cardId", async (c) => {
    const { conv, id } = boardOf(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // A change through the HTTP API is a user change: the owner session gets an event (the model's board tool sends none for its own moves).
    const cid = cardId(c);
    const before = conv.board.get(id, cid);
    const answer = typeof b.answer === "string" && b.answer.trim() ? b.answer : undefined;
    if (b.answer !== undefined && typeof b.answer !== "string") throw new BoardError(400, "answer must be text");
    // `project` moves the card; the rest of the body applies as usual.
    const target = b.project;
    if (target !== undefined) {
      if (!Number.isSafeInteger(target) || (target as number) < 0)
        throw new BoardError(400, "project must be a project id");
      if (!conv.projects.get(target as number)) throw new BoardError(404, "no such project");
      delete b.project;
    }
    // Answering a blocked card unblocks it, unless the same request sets the reason.
    if (answer && before?.blocked && b.blocked === undefined) b.blocked = null;
    const card = await write(conv, () => {
      const updated = conv.board.update(id, cid, b);
      return target === undefined || target === id ? updated : conv.board.move(id, cid, target as number);
    });
    if (before) {
      const events = [
        ...cardEvents(before, card),
        ...wakeEvents(conv.board, target === undefined ? id : (target as number), before, card),
        ...(answer ? answerEvent({ ...card, blocked: before.blocked }, answer) : []),
      ];
      if (answer) conv.board.log(cid, "user", `answer: ${answer.trim().slice(0, 200)}`);
      const dead = await deliverCardEvents(harness, events);
      if (dead.length) {
        for (const o of new Set([before.owner, card.owner]))
          if (o && dead.includes(ownerSession(o) ?? -1)) conv.board.clearOwner(id, cid, o);
        conv.touch();
      }
    }
    return c.json(conv.board.get(id, cid) ?? card);
  });

  app.get("/v1/projects/:id/cards/:cardId/activity", (c) => {
    const { conv, id } = boardOf(c);
    return c.json({ activity: conv.board.activity(id, cardId(c)) });
  });

  // Attachments: raw body upload (`?name=`, Content-Type kept), download, remove. Stored with the card.
  const attachmentId = (c: HonoContext) => {
    const n = Number(c.req.param("attachmentId"));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };

  app.post("/v1/projects/:id/cards/:cardId/attachments", bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES, onError: (c) => err(c, 400, `file too large (${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB max)`) }), async (c) => {
      const { conv, id } = boardOf(c);
      const data = new Uint8Array(await c.req.arrayBuffer());
      const a = await write(conv, () =>
        conv.board.attach(id, cardId(c), {
          name: c.req.query("name"),
          type: c.req.header("content-type"),
          data,
        }),
      );
      return c.json(a, 201);
    },
  );

  app.get("/v1/projects/:id/cards/:cardId/attachments/:attachmentId", (c) => {
    const { conv, id } = boardOf(c);
    const f = conv.board.file(id, cardId(c), attachmentId(c));
    if (!f) throw new BoardError(404, "attachment not found");
    return new Response(f.data, {
      headers: {
        "content-type": f.type,
        "content-length": String(f.data.byteLength),
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      },
    });
  });

  app.delete("/v1/projects/:id/cards/:cardId/attachments/:attachmentId", async (c) => {
    const { conv, id } = boardOf(c);
    await write(conv, () => conv.board.detach(id, cardId(c), attachmentId(c)));
    return c.json({ ok: true });
  });

  app.delete("/v1/projects/:id/cards/:cardId", async (c) => {
    const { conv, id } = boardOf(c);
    await write(conv, () => conv.board.delete(id, cardId(c)));
    return c.json({ ok: true });
  });
}
