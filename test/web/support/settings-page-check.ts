// Mounts the real SettingsPage.vue in happy-dom against the real daemon settings route and opens every tab.
// Usage: bun test/web/support/settings-page-check.ts <config.json>. Exit 0 means Settings opened with no error.
// It runs in its own process: Vue's DOM renderer binds `document` on first import, and other web tests in the
// same `bun test` process import Vue before any DOM exists.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { parse, compileScript, registerTS } from "vue/compiler-sfc";
import ts from "typescript5";
import { createModels } from "@earendil-works/pi-ai";
import { openLuna, context } from "../../../src/luna.js";
import { ConversationStore } from "../../../src/conversations.js";
import { createApp as createDaemonApp } from "../../../src/server.js";
import { SettingsStore } from "../../../src/settings.js";

// Imported prop types (for example reka-ui props) need the TS 5 JS API; root TypeScript 7 has none.
registerTS(() => ts);
const webSrc = new URL("../../../web/src/", import.meta.url).pathname;
// Compile .vue files and resolve the @/ alias the way Vite does.
plugin({
  name: "vue-sfc",
  setup(build) {
    build.onResolve({ filter: /^@\// }, ({ path }) => {
      const base = join(webSrc, path.slice(2));
      const hit = [".ts", ".vue", "/index.ts", ""].map(ext => base + ext).find(p => existsSync(p));
      if (!hit) throw new Error(`cannot resolve ${path}`);
      return { path: hit };
    });
    build.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const { descriptor } = parse(readFileSync(path, "utf8"), { filename: path });
      const fs = { fileExists: existsSync, readFile: (file: string) => readFileSync(file, "utf8") };
      const script = compileScript(descriptor, { id: Bun.hash(path).toString(16), inlineTemplate: true, fs });
      return { contents: script.content, loader: "ts" };
    });
  },
});

const dir = mkdtempSync(join(tmpdir(), "luna-settings-page-"));
GlobalRegistrator.register({ url: "http://luna.test/" });
const configFile = process.argv[2];
if (!configFile) throw new Error("usage: settings-page-check.ts <config.json>");

// Import web modules after the DOM exists: some read window/localStorage at import.
const vue = await import("vue");
const { setSettingsTab } = await import("../../../web/src/stores/app.ts");
const { sections } = await import("../../../web/src/pages/settings/catalog.ts");
const SettingsPage = (await import("../../../web/src/pages/SettingsPage.vue")).default;

/** Let fetches, async components, and Vue updates finish. */
async function settle() {
  for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await vue.nextTick(); }
}

const configPath = join(dir, "luna.config.json");
writeFileSync(configPath, readFileSync(configFile, "utf8"));
try {
  const models = createModels();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  const daemon = createDaemonApp({ harness, models, conversations: new ConversationStore(harness), settings: new SettingsStore(configPath, dir) });
  const failedRequests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const res = await daemon.request(url.pathname + url.search, init);
    if (url.pathname === "/v1/settings" && !res.ok) failedRequests.push(`${url.pathname} ${res.status}`);
    return res;
  }) as typeof fetch;

  const errors: string[] = [];
  const onError = (event: Event) => errors.push(`page error: ${(event as ErrorEvent).error?.stack || (event as ErrorEvent).message}`);
  window.addEventListener("error", onError);
  const root = document.createElement("div");
  document.body.append(root);
  const app = vue.createApp(SettingsPage);
  app.config.errorHandler = (err, _instance, info) => { errors.push(`${info}: ${(err as Error).stack || err}`); };
  app.config.warnHandler = (msg, _instance, trace) => { errors.push(`warn: ${msg}${trace}`); };
  try {
    app.mount(root);
    await settle();
    for (const section of sections) {
      setSettingsTab(section.id);
      await settle();
      const label = `tab ${section.id}`;
      assert.equal(root.querySelector(".settings-loading"), null, `${label}: still loading`);
      assert.equal(root.querySelector(".settings-error")?.textContent ?? null, null, `${label}: load error`);
      assert.equal(root.querySelector('[data-settings-tab][aria-current="page"]')?.getAttribute("data-settings-tab"), section.id, label);
      // Connections shows the provider and MCP managers; every other tab shows the shared form.
      const body = root.querySelector(section.id === "connections" ? ".settings-manager" : "#settings-configuration");
      assert.ok(body && body.textContent!.trim().length > 0, `${label}: tab content is empty`);
      assert.deepEqual(errors, [], label);
    }
    assert.deepEqual(failedRequests, []);
  } finally {
    app.unmount();
    root.remove();
    window.removeEventListener("error", onError);
    await harness.close(context);
  }
} finally {
  await GlobalRegistrator.unregister();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Settings opened: ${sections.length} tabs, no errors`);
