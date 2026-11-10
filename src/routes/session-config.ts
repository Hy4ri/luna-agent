import type { Hono } from "hono";
import { homedir } from "node:os";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AgentDoc, configure, type ConversationId } from "@earendil-works/pi-durable";
import { ExecTarget } from "../workers.js";
import { context, ProcessOwner } from "../luna.js";
import { isRunning } from "../session-status.js";
import { completeFiles } from "../file-mentions.js";
import { THINKING_LEVELS as SESSION_THINKING_LEVELS } from "../session-create.js";
import { DEFAULT_SESSION_TALK, XSESSION_APPROVED, extendSessionExchange, readSessionExchange } from "../session-talk.js";
import { z } from "zod";
import type { RouteCtx } from "./context.js";
import { resolveThinkingLevel } from "../thinking.js";
import type { ThinkingLevel } from "../session-create.js";
import { SPEEDS, SpeedDoc, type Speed } from "../speed.js";

const THINKING_LEVELS: readonly string[] = SESSION_THINKING_LEVELS;

export function registerSessionConfig(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err, getConv, serial } = ctx;

  const machineOf = async (id: ConversationId) => {
    const worker = (await harness.snapshot(ExecTarget, id, context).catch(() => undefined))?.worker ?? null;
    if (worker === null) return null;
    const w = opts.workers?.view(worker);
    return w ? { id: w.id, name: w.name, online: w.online } : { id: worker, name: null, online: false };
  };

  app.get("/v1/sessions/:id/machine", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json({ machine: await machineOf(conv.id), cwd: (await conv.agent(context)).cwd ?? null });
  });

  // Resolve a draft's execution directory without creating a session or listing files.
  app.get("/v1/session-defaults", (c) => {
    const rawWorker = c.req.query("worker");
    const worker = rawWorker ? Number(rawWorker) : null;
    if (worker !== null && (!Number.isSafeInteger(worker) || !opts.workers?.store.get(worker)))
      return err(c, 400, "unknown worker");
    const rawProject = c.req.query("project");
    if (rawProject !== undefined && (!/^\d+$/.test(rawProject) || !Number.isSafeInteger(Number(rawProject))))
      return err(c, 400, "invalid project");
    const project = rawProject === undefined ? undefined : opts.conversations?.projects.get(Number(rawProject));
    if (rawProject !== undefined && !project) return err(c, 400, "unknown project");
    const projectCwd = project ? opts.conversations?.projects.dirFor(project.id, worker) : undefined;
    if (project && !project.general && !projectCwd) return err(c, 400, "project is not linked to this machine");
    const cwd = c.req.query("cwd") || projectCwd || (worker === null
      ? ctx.baseAgent().cwd ?? opts.cwd ?? process.cwd() : opts.workers?.defaultCwd(worker));
    if (!cwd) return err(c, 409, "The machine's working directory is unavailable. Connect it before sending.");
    return c.json({ worker, cwd });
  });

  // `@file:` completion. Lists the working directory of the session's machine; a typed directory part (`~/x/`, `/etc/`,
  // `../`) lists that directory on the same machine. Without a session, `worker`/`project`/`cwd` describe a draft chat.
  app.get("/v1/files", async (c) => {
    const q = c.req.query("q") ?? "";
    const sid = c.req.query("session");
    let worker: number | null, cwd: string | undefined;
    if (sid) {
      const conv = await getConv(sid);
      if (!conv) return err(c, 404, "no such session");
      worker = (await harness.snapshot(ExecTarget, conv.id, context).catch(() => undefined))?.worker ?? null;
      cwd = (await conv.agent(context)).cwd ?? undefined;
    } else {
      const w = c.req.query("worker");
      worker = w ? Number(w) : null;
      if (worker !== null && (!Number.isSafeInteger(worker) || !opts.workers?.store.get(worker)))
        return err(c, 400, "unknown worker");
      const project = Number(c.req.query("project"));
      const selectedProject = Number.isSafeInteger(project) ? opts.conversations?.projects.get(project) : undefined;
      const projectCwd = selectedProject ? opts.conversations?.projects.dirFor(project, worker) : undefined;
      if (selectedProject && !selectedProject.general && !projectCwd)
        return err(c, 400, "project is not linked to this machine");
      cwd = c.req.query("cwd") || projectCwd;
    }
    let env,
      home: string | undefined;
    if (worker !== null) {
      if (!opts.workers) return err(c, 404, "workers disabled");
      env = opts.workers.env(worker, cwd);
      home = opts.workers.store.get(worker)?.capabilities?.home;
    } else {
      env = new NodeExecutionEnv({ cwd: cwd ?? opts.cwd ?? process.cwd() });
      home = homedir();
    }
    const { entries, error } = await completeFiles(env, home, q, context);
    return c.json({ cwd: env.cwd, entries, ...(error ? { error } : {}) });
  });

  // Move an idle session to another machine. `worker: null` is this host. The cwd is a path on the target machine;
  // omitted, it becomes the worker's default directory (or the project directory on this host).
  app.put("/v1/sessions/:id/machine", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = (await c.req.json().catch(() => null)) as { worker?: unknown; cwd?: unknown } | null;
    if (!b || !("worker" in b)) return err(c, 400, "worker required (a worker id, or null for this host)");
    if (b.worker !== null && typeof b.worker !== "number") return err(c, 400, "worker must be a numeric id or null");
    const worker = b.worker as number | null;
    if (worker !== null && (!Number.isSafeInteger(worker) || !opts.workers?.store.get(worker)))
      return err(c, 400, "unknown worker");
    if (b.cwd !== undefined && b.cwd !== null && (typeof b.cwd !== "string" || !b.cwd.trim()))
      return err(c, 400, "cwd must be a non-empty string");
    const project = opts.conversations?.projects.projectOf(Number(conv.id));
    const projectCwd =
      project === undefined ? undefined : opts.conversations?.projects.dirFor(project, worker) || undefined;
    if (project !== undefined && project !== 0 && !projectCwd)
      return err(c, 400, "project is not linked to this machine");
    const cwd = (b.cwd as string | undefined)?.trim() || projectCwd || null;
    const moved = await serial(String(conv.id), () =>
      harness.commit(async (tx) => {
        if (await isRunning(tx, conv.id)) return "busy";
        // Check retained OS work at the same boundary as task admission, not before this transaction.
        const owner = (await tx.doc(ProcessOwner, conv.id)).token;
        if (harness.busyTools?.sessionProcesses(conv.id, owner).some((p) => p.running)) return "processes";
        (await tx.doc(ExecTarget, conv.id)).worker = worker;
        await configure(tx, conv.id, { cwd });
        await tx.appendEntry(conv.id, { kind: "luna.execution", data: { worker, cwd } });
        return "moved";
      }, context),
    );
    if (moved === "busy") return err(c, 409, "Cannot move a session while it runs.");
    if (moved === "processes") return err(c, 409, "Stop or finish background processes before moving execution.");
    return c.json({ machine: await machineOf(conv.id), cwd });
  });

  // Change a session's model, thinking level or instructions. null resets a field to the default.
  // The stored thinking level is always the level the session's model supports (see resolveThinkingLevel).
  app.patch("/v1/sessions/:id", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const b = (await c.req.json().catch(() => ({}))) as {
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: string | null;
      instructions?: string | null;
      speed?: string | null;
    };
    // Thinking changes affect the next model request, not the in-flight request.
    // Keep model and instruction changes idle-only, including mixed patches.
    const requiresIdle = b.model !== undefined || b.instructions !== undefined;
    if (requiresIdle && await harness.commit((tx) => isRunning(tx, conv.id), context))
      return err(c, 409, "Cannot change the model or instructions while busy.");
    if (b.model && opts.models && !opts.models.getModel(b.model.provider, b.model.modelId))
      return err(c, 400, "unknown model");
    if (b.thinkingLevel !== undefined && b.thinkingLevel !== null && !THINKING_LEVELS.includes(b.thinkingLevel))
      return err(c, 400, "invalid thinkingLevel");
    if (b.speed !== undefined && b.speed !== null && !(SPEEDS as readonly string[]).includes(b.speed))
      return err(c, 400, "invalid speed");
    if (b.model !== undefined) {
      await opts.scheduledMessages?.cancelForConversation(Number(conv.id), "limit_recovery", "Session model changed.");
    }
    const changed = await serial(String(conv.id), () => harness.commit(async (tx) => {
      if (requiresIdle && await isRunning(tx, conv.id)) return false;
      const doc = await tx.doc(AgentDoc, conv.id);
      const previous = doc.model;
      const target = b.model === undefined ? previous : b.model ?? ctx.baseAgent().model;
      // An explicit level is clamped. A model switch keeps the current level unless the new model has its own default.
      // null resets to the default for the model.
      const thinkingLevel = b.thinkingLevel !== undefined || b.model !== undefined
        ? resolveThinkingLevel(opts.models, target, ctx.thinkingDefaults(), (b.thinkingLevel ?? undefined) as ThinkingLevel | undefined,
          b.thinkingLevel === null ? undefined : doc.thinkingLevel as ThinkingLevel | undefined)
        : undefined;
      await configure(tx, conv.id, {
        ...(b.model !== undefined && { model: b.model }),
        ...(thinkingLevel !== undefined && { thinkingLevel }),
        ...(b.instructions !== undefined && { instructions: b.instructions || null }),
      });
      // Speed, like thinking, applies from the next model request.
      if (b.speed !== undefined) (await tx.doc(SpeedDoc, conv.id)).speed = b.speed as Speed | null;
      const model = (await tx.doc(AgentDoc, conv.id)).model;
      if (b.model !== undefined && (previous?.provider !== model?.provider || previous?.modelId !== model?.modelId)) {
        const text = model ? `Model changed to ${model.provider}/${model.modelId}.` : "Session model cleared; no model is selected.";
        await tx.appendEntry(conv.id, {
          kind: "luna.model-changed",
          data: { previous: previous ?? null, model: model ?? null, text },
          model: [{ role: "system", content: `[Session event] ${text}`, timestamp: Date.now() }],
        });
      }
      return true;
    }, context));
    if (!changed) return err(c, 409, "Cannot change the model or instructions while busy.");
    // Return the effective level so the client shows what the model will run.
    return c.json({ ok: true, thinkingLevel: (await conv.agent(context)).thinkingLevel,
      speed: (await harness.snapshot(SpeedDoc, conv.id, context).catch(() => undefined))?.speed ?? null });
  });

  app.delete("/v1/sessions/:id/limit-wait", async (c) => {
    if (!opts.limitContinuer) return err(c, 404, "auto-continue disabled");
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    return c.json({ cancelled: await opts.limitContinuer.cancel(Number(conv.id)) });
  });

  const sessionTalkPolicy = () =>
    opts.sessionTalk?.() ?? opts.settings?.resolved().sessionTalk ?? DEFAULT_SESSION_TALK;
  const exchangeTarget = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

  app.get("/v1/sessions/:id/exchanges/:to", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const to = exchangeTarget.safeParse(c.req.param("to"));
    if (!to.success || to.data === Number(conv.id)) return err(c, 400, "invalid peer session");
    return c.json(
      await harness.commit((tx) => readSessionExchange(tx, conv.id, to.data, sessionTalkPolicy()), context),
    );
  });

  app.post("/v1/sessions/:id/exchanges/:to/extend", async (c) => {
    const conv = await getConv(c.req.param("id"));
    if (!conv) return err(c, 404, "no such session");
    const to = exchangeTarget.safeParse(c.req.param("to"));
    const body = z
      .strictObject({ anchor: z.string().min(1), maxHops: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
      .safeParse(await c.req.json().catch(() => null));
    if (!to.success || !body.success) return err(c, 400, "invalid exchange extension");
    const result = await harness.commit(
      (tx) => extendSessionExchange(tx, conv.id, to.data, body.data.anchor, body.data.maxHops, sessionTalkPolicy()),
      context,
    );
    if ("error" in result) return err(c, 409, result.error!);
    // A distinct input kind preserves the exchange. Ordinary human input would reset its hop count.
    // Stable submission identity also covers a retry after a committed grant but failed HTTP delivery.
    await conv.submit(
      {
        type: "input",
        whenBusy: "followUp",
        requestId: result.requestId,
        content: `m57 allowed up to ${result.maxHops} messages in the current exchange with session #${to.data}. Retry the blocked session_send if this exchange is still current. This approval does not grant merge, publish, or delete permission.`,
        entry: { kind: XSESSION_APPROVED, data: { to: to.data, anchor: body.data.anchor, maxHops: result.maxHops } },
      },
      context,
    );
    return c.json(result);
  });
}
