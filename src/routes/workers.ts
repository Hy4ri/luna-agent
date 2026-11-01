import type { Hono, Context as HonoContext } from "hono";
import { WorkerError } from "../workers.js";
import type { RouteCtx } from "./context.js";

export function registerWorkers(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;

  const workerErr = (c: HonoContext, e: unknown) => {
    if (e instanceof WorkerError) return err(c, e.status, e.message);
    throw e;
  };

  app.get("/v1/workers", (c) => c.json({ workers: opts.workers?.list() ?? [] }));

  app.post("/v1/workers", async (c) => {
    if (!opts.workers) return err(c, 404, "workers disabled");
    const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    try {
      return c.json(opts.workers.store.create(b.name), 201);
    } catch (e) {
      return workerErr(c, e);
    }
  });

  app.delete("/v1/workers/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!opts.workers || !Number.isSafeInteger(id) || !opts.workers.remove(id)) return err(c, 404, "no such worker");
    opts.conversations?.projects.forgetWorker(id);
    return c.json({ ok: true });
  });
}
