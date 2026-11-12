// Contracts: install only the static dependency graph; cached panes preserve the server's frame policy.
// Regressions: eager addAll(FILES), or changing X-Frame-Options while leaving frame-ancestors 'none'.
// No existing test exercises the emitted worker. Evaluate its real handlers in an isolated VM;
// the platform stubs capture Cache API arguments, not the graph selection or response-header logic.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const stripTs = (code: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(code);
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { test, expect } from "bun:test";
import { createWebApp } from "../src/web-assets.js";

type WorkerEvent = { request?: Request; waitUntil(promise: Promise<unknown>): void; respondWith(promise: Promise<Response>): void };
const source = stripTs(readFileSync(new URL("../web/sw.ts", import.meta.url), "utf8"));
function worker(code: string, overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  runInNewContext(code, { URL, Response, Headers, AbortSignal, location: { origin: "https://luna.test" },
    addEventListener: (name: string, handler: (event: WorkerEvent) => void) => handlers.set(name, handler),
    skipWaiting: async () => {}, ...overrides });
  return handlers;
}

test("shipped worker installs entry imports and assets, but defers dynamic and unrelated chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-web-assets-"));
  try {
    mkdirSync(join(dir, "assets")); mkdirSync(join(dir, ".vite"));
    for (const file of ["main.js", "main.css", "shared.js", "font.woff2", "lazy.js", "lazy.css", "unused.js"]) {
      writeFileSync(join(dir, "assets", file), file);
    }
    for (const file of ["index.html", "manifest.webmanifest", "icon.svg", "icon.png", "favicon.png"]) writeFileSync(join(dir, file), file);
    writeFileSync(join(dir, "sw.js"), source);
    writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { isEntry: true, file: "assets/main.js", css: ["assets/main.css"], assets: ["assets/font.woff2"], imports: ["shared"], dynamicImports: ["lazy"] },
      shared: { file: "assets/shared.js", imports: ["index.html"] },
      lazy: { file: "assets/lazy.js", css: ["assets/lazy.css"] },
    }));
    const app = createWebApp(pathToFileURL(dir + "/"));
    const response = await app.request("/sw.js"); expect(response.status).toBe(200);
    const installed: string[] = [], waits: Promise<unknown>[] = [];
    const handlers = worker(await response.text(), { caches: { open: async () => ({ addAll: async (paths: string[]) => { installed.push(...paths); } }) } });
    handlers.get("install")!({ waitUntil: promise => waits.push(promise), respondWith: () => {} });
    await Promise.all(waits);
    expect(installed.sort()).toEqual(["/", "/manifest.webmanifest", "/favicon.png", "/icon.png", "/assets/main.js", "/assets/main.css", "/assets/shared.js", "/assets/font.woff2"].sort());
    // The legacy SVG wrapper is still served to old pages, but a new install does not download it.
    expect((await app.request("/icon.svg")).status).toBe(200);
    expect((await app.request("/favicon.png")).headers.get("content-type")).toBe("image/png");
    expect((await app.request("/assets/font.woff2")).headers.get("content-type")).toBe("font/woff2");
    const root = await app.request("/"), pane = await app.request("/?pane=session&session=42");
    expect(root.headers.get("x-frame-options")).toBe("DENY");
    expect(root.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(pane.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(pane.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify({ entry: { isEntry: true, file: "assets/missing.js" } }));
    expect((await app.request("/sw.js")).status).toBe(503) /* "incomplete builds must not install a broken shell" */;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline shell canonicalizes pane URLs and keeps both frame restrictions consistent", async () => {
  const code = source.replace("__SHELL_VERSION__", "luna-vue-test").replace("__SHELL_FILES__", JSON.stringify(["/", "/assets/main.js"]))
    .replace("__SHELL_CORE__", JSON.stringify(["/", "/assets/main.js"]));
  const reads: string[] = [];
  const handlers = worker(code, {
    fetch: async () => { throw new TypeError("offline"); },
    caches: { match: async (key: string) => {
      reads.push(key);
      return new Response("installed shell", { headers: { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "x-content-type-options": "nosniff" } });
    } },
  });
  for (const [path, frame, policy] of [["/?session=1", "DENY", "frame-ancestors 'none'"], ["/?pane=session&session=42", "SAMEORIGIN", "frame-ancestors 'self'"]]) {
    let result: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: new Request("https://luna.test" + path), waitUntil: () => {}, respondWith: value => { result = value; } });
    expect(result).toBeTruthy(); const response = await result;
    expect(await response!.text()).toBe("installed shell"); expect<string | null | undefined>(response!.headers.get("x-frame-options")).toBe(frame);
    expect<string | null | undefined>(response!.headers.get("content-security-policy")).toBe(policy);
    expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect(reads).toEqual(["/", "/"]);
  for (const request of [new Request("https://luna.test/v1/sessions"), new Request("https://other.test/"), new Request("https://luna.test/", { method: "POST" })]) {
    let intercepted = false;
    handlers.get("fetch")!({ request, waitUntil: () => {}, respondWith: () => { intercepted = true; } });
    expect(intercepted).toBe(false) /* request.url */;
  }
});
