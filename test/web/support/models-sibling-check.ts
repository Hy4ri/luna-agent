// Exercises web/src/stores/models.ts sibling-model thinking level switching in happy-dom with a mocked fetch.
// Store state is Vue reactive proxies; toEqual compares values (toStrictEqual rejects the proxy type).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";

const webSrc = new URL("../../../web/src/", import.meta.url).pathname;
plugin({
  name: "web-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path }) => {
      const base = join(webSrc, path.slice(2));
      const hit = [".ts", ".vue", "/index.ts", ""].map(ext => base + ext).find(p => existsSync(p));
      if (!hit) throw new Error(`cannot resolve ${path}`);
      return { path: hit };
    });
  },
});

GlobalRegistrator.register({ url: "http://luna.test/" });

const catalog = [
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-low", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-medium", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-high", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-xhigh", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gpt-oss-120b-medium", thinkingLevels: ["off"] },
  { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevels: ["off", "low", "medium", "high"], defaultThinkingLevel: "medium" },
];

const patchCalls: { url: string; body: any }[] = [];
let patchDelayMs = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === "/v1/models/pins") {
    return Response.json({ pins: [] });
  }
  if (url.pathname === "/v1/models") {
    return Response.json({
      default: { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" },
      defaultThinkingLevel: "medium",
      models: catalog,
      refresh: null,
    });
  }
  if (url.pathname === "/v1/sessions/7" && init?.method === "PATCH") {
    const body = JSON.parse(String(init.body || "{}"));
    patchCalls.push({ url: url.pathname, body });
    if (patchDelayMs > 0) await new Promise(resolve => setTimeout(resolve, patchDelayMs));
    // Server clamps non-reasoning proxy models to "off".
    const thinkingLevel = body.model?.provider === "cli-proxy-api" ? "off" : (body.thinkingLevel ?? "medium");
    return Response.json({ ok: true, thinkingLevel, speed: null });
  }
  return new Response("Not found", { status: 404 });
}) as typeof fetch;

const { chat } = await import("../../../web/src/stores/chat.ts");
const {
  models,
  availableLevels,
  isSiblingModel,
  loadModels,
  chooseModel,
  setThinking,
  setSelectedModel,
} = await import("../../../web/src/stores/models.ts");

try {
  // 1. Draft mode loads sibling default model and displays its suffix level.
  expect(await loadModels()).toBe(true);
  expect(models.selected).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" });
  expect(models.thinking).toBe("high");
  expect(isSiblingModel.value).toBe(true);
  expect(availableLevels.value).toEqual(["low", "medium", "high", "xhigh"]);

  // 2. Draft mode setThinking switches sibling model without PATCH.
  expect(await setThinking("xhigh")).toBe(true);
  expect(models.selected).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-xhigh" });
  expect(models.draft.model).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-xhigh" });
  expect(models.thinking).toBe("xhigh");
  expect(patchCalls.length).toBe(0);

  // Choosing a sibling via model picker updates thinking to that sibling's suffix.
  expect(await chooseModel(catalog[0]!)).toBe(true);
  expect(models.selected).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-low" });
  expect(models.thinking).toBe("low");

  // 3. Open session race: loadModels syncs thinking when session selected a sibling before catalog loaded.
  chat.session = "7";
  setSelectedModel({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-medium" });
  models.thinking = "off";
  expect(await loadModels({ force: true })).toBe(true);
  expect(models.thinking).toBe("medium");

  // 4. Open session setThinking sends PATCH with { model } and preserves sibling suffix level over server "off".
  expect(await setThinking("xhigh")).toBe(true);
  expect(patchCalls.length).toBe(1);
  expect(patchCalls[0]!.body).toEqual({ model: { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-xhigh" } });
  expect(models.selected).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-xhigh" });
  expect(models.thinking).toBe("xhigh");

  // 5. Concurrent calls to the same sibling target coalesce into a single PATCH.
  patchCalls.length = 0;
  patchDelayMs = 20;
  const [r1, r2] = await Promise.all([setThinking("low"), setThinking("low")]);
  patchDelayMs = 0;
  expect(r1).toBe(true);
  expect(r2).toBe(true);
  expect(patchCalls.length).toBe(1);
  expect(models.selected).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-low" });
  expect(models.thinking).toBe("low");

  // 6. Busy session guard prevents sibling switching and records notice.
  patchCalls.length = 0;
  chat.runActive = true;
  chat.notices = [];
  expect(await setThinking("high")).toBe(false);
  expect(patchCalls.length).toBe(0);
  expect(models.selected).toEqual({ provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-low" });
  expect(models.thinking).toBe("low");
  expect(chat.notices.length).toBe(1);
  chat.runActive = false;

  // 7. Standalone -<level> model stays single-level and non-sibling.
  expect(await chooseModel(catalog[4]!)).toBe(true);
  expect(isSiblingModel.value).toBe(false);
  expect(availableLevels.value).toEqual(["off"]);

  // 8. Native reasoning model continues using thinkingLevel PATCH.
  patchCalls.length = 0;
  expect(await chooseModel(catalog[5]!)).toBe(true);
  expect(isSiblingModel.value).toBe(false);
  expect(availableLevels.value).toEqual(["off", "low", "medium", "high"]);
  expect(await setThinking("high")).toBe(true);
  expect(patchCalls.length).toBe(2); // 1 chooseModel + 1 setThinking
  expect(patchCalls[1]!.body).toEqual({ thinkingLevel: "high" });
  expect(models.thinking).toBe("high");
} finally {
  await GlobalRegistrator.unregister();
}
console.log("models-sibling-check ok");
