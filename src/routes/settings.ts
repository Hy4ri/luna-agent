import type { Hono, Context as HonoContext } from "hono";
import type { RouteCtx } from "./context.js";

export function registerSettings(app: Hono, ctx: RouteCtx): void {
  const { opts, err } = ctx;

  app.get("/v1/settings", (c) =>
    opts.settings ? c.json(opts.settings.view()) : err(c, 404, "settings disabled"),
  );

  app.get("/v1/models/pins", (c) =>
    opts.settings ? c.json({ pins: opts.settings.read().pinnedModels }) : err(c, 404, "settings disabled"),
  );

  app.post("/v1/models/pins", async (c) => {
    if (!opts.settings) return err(c, 404, "settings disabled");
    const body = await c.req.json().catch(() => null);
    if (!body || !["import", "toggle", "move"].includes(body.action)) return err(c, 400, "Invalid pin action");
    if (
      body.action === "import"
        ? !Array.isArray(body.pins) || !body.pins.every((p: unknown) => typeof p === "string" && p.length > 0)
        : typeof body.key !== "string" ||
          !body.key.length ||
          (body.action === "move" && body.direction !== -1 && body.direction !== 1)
    )
      return err(c, 400, "Invalid pins");
    opts.settings.update((settings) => {
      const pins = settings.pinnedModels;
      if (body.action === "import") settings.pinnedModels = [...new Set([...pins, ...body.pins])];
      else {
        const index = pins.indexOf(body.key);
        if (body.action === "toggle") {
          if (index < 0) pins.push(body.key);
          else pins.splice(index, 1);
        } else {
          const target = index + body.direction;
          if (index >= 0 && target >= 0 && target < pins.length)
            [pins[index], pins[target]] = [pins[target]!, pins[index]!];
        }
      }
    });
    return c.json({ pins: opts.settings.read().pinnedModels });
  });

  app.put("/v1/settings", async (c) => {
    if (!opts.settings) return err(c, 404, "settings disabled");
    try {
      const b = await c.req.json();
      if (!b || typeof b !== "object" || !b.config || typeof b.revision !== "string")
        return err(c, 400, "config and revision required");
      // Main and child defaults must name an available model when changed.
      const old = opts.settings.read();
      const roles = b.config.subagents?.profiles ?? {};
      const defaults = [
        [b.config, old],
        [b.config.subagents ?? {}, old.subagents],
        ...Object.entries(roles).map(([name, profile]) => [profile, old.subagents.profiles[name] ?? {}]),
      ];
      for (const [next, prev] of defaults as [Record<string, any>, Record<string, any>][]) {
        if (old.providers.some((p) => p.id === next.provider) && !b.config.providers?.some((p: { id: string }) => p.id === next.provider))
          return err(c, 400, "Select another default before removing its provider");
        if (
          next.provider &&
          next.model &&
          (next.provider !== prev.provider || next.model !== prev.model) &&
          !opts.models?.getModel(next.provider, next.model)
        ) {
          const custom = b.config.providers?.find((p: { id: string }) => p.id === next.provider);
          if (!custom?.models?.some((m: { id: string }) => m.id === next.model))
            return err(c, 400, "unknown default model");
        }
      }
      opts.settings.replace(b.config, b.revision);
      const warnings = await opts.settings.apply(old);
      return c.json({ ...opts.settings.view(), warnings });
    } catch (e) {
      return err(c, (e as Error).message.includes("Reload before") ? 409 : 400, (e as Error).message);
    }
  });

  // ---- models ----
  // Models of connected providers only (plus the default, so a session never shows an unknown value).
  app.get("/v1/models", async (c) => {
    if (!opts.models) return err(c, 404, "disabled");
    const cur = (opts.providers?.defaultModel() ?? opts.agent?.model) ?? null;
    const avail = opts.providers
      ? [...(await opts.models.getAvailable())]
      : [...opts.models.getModels(cur?.provider)];
    if (cur && !avail.some((m) => m.provider === cur.provider && m.id === cur.modelId)) {
      const m = opts.models.getModel(cur.provider, cur.modelId);
      if (m) avail.unshift(m);
    }
    const list = avail.map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      contextWindow: m.contextWindow,
    }));
    return c.json({ default: cur, models: list, refresh: opts.providers?.catalogStatus() ?? null });
  });

  app.post("/v1/models/refresh", async (c) => {
    if (!opts.providers) return err(c, 404, "providers disabled");
    return c.json({ refresh: await opts.providers.refreshCatalog() });
  });

  app.put("/v1/models/default", async (c) => {
    if (!opts.providers) return err(c, 404, "disabled");
    const b = (await c.req.json().catch(() => ({}))) as { provider?: string; modelId?: string };
    try {
      opts.providers.setDefaultModel({ provider: String(b.provider ?? ""), modelId: String(b.modelId ?? "") });
      return c.json({ ok: true, default: opts.providers.defaultModel() });
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });

  // ---- providers: API keys, subscription (OAuth) logins, custom OpenAI/Anthropic-compatible endpoints ----
  const prov = (c: HonoContext) => (opts.providers ? undefined : err(c, 404, "providers disabled"));
  const attempt = async (c: HonoContext, fn: () => Promise<unknown>, status: 200 | 201 = 200) => {
    try {
      return c.json((await fn()) ?? { ok: true }, status);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  };

  app.get("/v1/providers", async (c) =>
    prov(c) ?? c.json({ providers: await opts.providers!.list(), default: opts.providers!.defaultModel() }),
  );

  app.put("/v1/providers/:id/key", async (c) => {
    const no = prov(c);
    if (no) return no;
    const b = (await c.req.json().catch(() => ({}))) as { key?: string };
    return attempt(c, () => opts.providers!.setApiKey(c.req.param("id"), String(b.key ?? "")));
  });

  app.delete("/v1/providers/:id/credential", async (c) =>
    prov(c) ?? attempt(c, () => opts.providers!.logout(c.req.param("id"))),
  );

  app.post("/v1/providers/custom", async (c) => {
    const no = prov(c);
    if (no) return no;
    const b = await c.req.json().catch(() => ({}));
    return attempt(c, () => opts.providers!.addCustom(b as never), 201);
  });

  app.delete("/v1/providers/custom/:id", async (c) =>
    prov(c) ?? attempt(c, () => opts.providers!.removeCustom(c.req.param("id"))),
  );

  app.post("/v1/providers/:id/login", async (c) => {
    const no = prov(c);
    if (no) return no;
    const b = (await c.req.json().catch(() => ({}))) as { type?: string };
    const type = b.type === "api_key" ? "api_key" : "oauth";
    try {
      return c.json(opts.providers!.startLogin(c.req.param("id"), type), 201);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }
  });

  app.get("/v1/logins/:id", (c) => {
    const no = prov(c);
    if (no) return no;
    const l = opts.providers!.getLogin(c.req.param("id"));
    return l ? c.json(l) : err(c, 404, "no such login");
  });

  app.post("/v1/logins/:id/answer", async (c) => {
    const no = prov(c);
    if (no) return no;
    const b = (await c.req.json().catch(() => ({}))) as { seq?: number; value?: string };
    try {
      opts.providers!.answerLogin(c.req.param("id"), Number(b.seq), String(b.value ?? ""));
      return c.json({ ok: true });
    } catch (e) {
      return err(c, 409, (e as Error).message);
    }
  });

  app.delete("/v1/logins/:id", (c) => {
    const no = prov(c);
    if (no) return no;
    opts.providers!.cancelLogin(c.req.param("id"));
    return c.json({ ok: true });
  });
}
