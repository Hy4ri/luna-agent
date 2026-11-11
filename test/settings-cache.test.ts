import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "../src/settings.js";
import { registerSettings } from "../src/routes/settings.js";
import { Hono } from "hono";
import type { RouteCtx } from "../src/routes/context.js";

describe("SettingsStore caching and invalidation", () => {
  test("caches view and invalidates on update and replace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-settings-test-"));
    const configPath = join(dir, "luna.config.json");
    try {
      writeFileSync(configPath, JSON.stringify({ model: "openai/gpt-4o" }, null, 2));
      const store = new SettingsStore(configPath, dir);

      const v1 = store.view();
      const j1 = store.viewJson();
      expect(JSON.parse(j1.json)).toEqual(v1);
      expect(v1.config.model).toBe("openai/gpt-4o");

      // Reading again should return equivalent content from cache
      const v2 = store.view();
      const j2 = store.viewJson();
      expect(j2.json).toBe(j1.json);
      expect(j2.revision).toBe(j1.revision);
      expect(v2).toEqual(v1);

      // Mutating store via update
      store.update((s) => {
        s.model = "anthropic/claude-3-5-sonnet";
      });

      const v3 = store.view();
      const j3 = store.viewJson();
      expect(v3.config.model).toBe("anthropic/claude-3-5-sonnet");
      expect(j3.json).not.toBe(j1.json);
      expect(j3.revision).not.toBe(j1.revision);

      // Replacing store via replace
      const rev = store.revision();
      store.replace({ model: "openai/gpt-5" }, rev);
      const v4 = store.view();
      const j4 = store.viewJson();
      expect(v4.config.model).toBe("openai/gpt-5");
      expect(j4.revision).not.toBe(j3.revision);

      // Route-level HTTP test for ETag and 304 handling (including W/ prefix)
      const app = new Hono();
      const ctx: Partial<RouteCtx> = {
        opts: {
          settings: store as any,
        } as any,
        err: ((c: any, status: any, msg: any) => c.json({ error: msg }, status)) as any,
        baseAgent: () => ({ thinkingLevel: "low" }) as any,
        thinkingDefaults: () => ({ thinkingLevel: "low" }) as any,
      };
      registerSettings(app, ctx as RouteCtx);

      const res1 = await app.request("/v1/settings");
      expect(res1.status).toBe(200);
      const etag = res1.headers.get("etag")!;
      expect(etag).toBeDefined();

      const res2 = await app.request("/v1/settings", {
        headers: { "if-none-match": etag },
      });
      expect(res2.status).toBe(304);

      const res2w = await app.request("/v1/settings", {
        headers: { "if-none-match": `W/${etag}` },
      });
      expect(res2w.status).toBe(304);

      const res2l = await app.request("/v1/settings", { headers: { "if-none-match": `"other", ${etag}` } });
      expect(res2l.status).toBe(304);

      // A tag from before a change gets the new body, never a 304.
      store.update((s) => { s.model = "openai/gpt-5.1"; });
      const res3 = await app.request("/v1/settings", { headers: { "if-none-match": etag } });
      expect(res3.status).toBe(200);
      expect(res3.headers.get("etag")).not.toBe(etag);
      expect(((await res3.json()) as { config: { model: string } }).config.model).toBe("openai/gpt-5.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
