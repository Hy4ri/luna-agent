// Verifies web-assets serving, fallback/503 behavior, asset security, MIME types, cache/security headers,
// and worker version/list rebuild rotation without daemon restart.
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createWebApp } from "./web-assets.js";

const ok = (m: string) => console.log("OK", m);
const d = mkdtempSync(join(process.cwd(), ".vweb-rebuild-"));

try {
  const root = new URL(`file://${d}/dist/web/`);
  const distDir = join(d, "dist", "web");

  // 1. App creation before missing build directory should not throw, but requesting static assets / index returns 503
  const app = createWebApp(root);
  const rMissing = await app.request("/");
  assert.equal(rMissing.status, 503, "missing build root should return 503");
  const swMissing = await app.request("/sw.js");
  assert.equal(swMissing.status, 503, "missing worker should return 503");
  ok("app creation succeeds with missing build dir; requests return 503");

  // 2. Populate fixture build output directory and secret file outside assets to test traversal
  mkdirSync(join(distDir, "assets"), { recursive: true });
  mkdirSync(join(distDir, "secret"), { recursive: true });
  writeFileSync(join(distDir, "secret", "password.txt"), "TOP_SECRET_PASSWORD");
  writeFileSync(join(distDir, "index.html"), "<!DOCTYPE html><html><head><title>Test</title></head><body>Root</body></html>");
  writeFileSync(join(distDir, "manifest.webmanifest"), '{"name":"Luna"}');
  writeFileSync(join(distDir, "icon.svg"), '<svg></svg>');
  writeFileSync(join(distDir, "sw.js"), '/* FIXTURE_ONLY_WORKER */ const VERSION = "__SHELL_VERSION__"; const FILES = __SHELL_FILES__;');
  writeFileSync(join(distDir, "assets", "index-abc12345.js"), 'console.log("app");');
  writeFileSync(join(distDir, "assets", "style-def67890.css"), 'body { color: red; }');

  // 3. Test successful serving through the SAME app instance without restart
  const rIndex = await app.request("/");
  assert.equal(rIndex.status, 200);
  assert.equal(rIndex.headers.get("content-type"), "text/html; charset=UTF-8");
  assert.equal(rIndex.headers.get("cache-control"), "no-cache");
  assert.equal(rIndex.headers.get("x-content-type-options"), "nosniff");
  assert.equal(rIndex.headers.get("x-frame-options"), "DENY");
  assert.equal(rIndex.headers.get("referrer-policy"), "no-referrer");
  assert.match(await rIndex.text(), /Root/);

  const rManifest = await app.request("/manifest.webmanifest");
  assert.equal(rManifest.status, 200);
  assert.ok((rManifest.headers.get("content-type") || "").includes("application/manifest+json"));
  assert.equal(rManifest.headers.get("cache-control"), "no-cache");

  const rIcon = await app.request("/icon.svg");
  assert.equal(rIcon.status, 200);
  assert.ok((rIcon.headers.get("content-type") || "").includes("image/svg+xml"));

  const rWorker = await app.request("/sw.js");
  assert.equal(rWorker.status, 200);
  assert.ok((rWorker.headers.get("content-type") || "").includes("text/javascript"));
  assert.equal(rWorker.headers.get("cache-control"), "no-cache");
  const workerText = await rWorker.text();
  assert.ok(workerText.includes("FIXTURE_ONLY_WORKER"), "worker must come from the supplied build root, not the source tree");
  assert.ok(!workerText.includes("__SHELL_VERSION__") && !workerText.includes("__SHELL_FILES__"));
  assert.ok(workerText.includes("index-abc12345.js"), "worker should include shell files list");
  assert.ok(workerText.includes("style-def67890.css"), "worker should include shell css list");
  assert.ok(!workerText.includes("interface ") && !workerText.includes(": string"), "worker must not contain TS type declarations");

  // The real Vite artifact must be JavaScript, with placeholders for request-time asset discovery.
  const builtWorker = readFileSync(new URL("../dist/web/sw.js", import.meta.url), "utf8");
  assert.ok(builtWorker.includes("__SHELL_VERSION__"));
  assert.ok(builtWorker.includes("__SHELL_FILES__"));
  new Function(builtWorker); // Syntax-only check: never executes worker code in Node.
  rmSync(join(distDir, "sw.js"));
  assert.equal((await app.request("/sw.js")).status, 503, "missing built worker returns 503, never a stub");
  writeFileSync(join(distDir, "sw.js"), '/* FIXTURE_ONLY_WORKER */ const VERSION = "__SHELL_VERSION__"; const FILES = __SHELL_FILES__;');

  const rAsset = await app.request("/assets/index-abc12345.js");
  assert.equal(rAsset.status, 200);
  assert.ok((rAsset.headers.get("content-type") || "").match(/text\/javascript|application\/javascript/));
  assert.match(rAsset.headers.get("cache-control") || "", /immutable/);

  const rCss = await app.request("/assets/style-def67890.css");
  assert.equal(rCss.status, 200);
  assert.ok((rCss.headers.get("content-type") || "").includes("text/css"));

  ok("fixture index, manifest, icon, worker markers, and assets served successfully with correct headers and MIME types");

  // 4. Security checks: path traversal, subpaths, encoded separators tested against secret file fixture outside assets
  const traversalAttempts = [
    "/assets/../secret/password.txt",
    "/assets/..%2fsecret%2fpassword.txt",
    "/assets/sub/index-abc12345.js",
    "/assets/index-abc12345.js/extra"
  ];
  for (const path of traversalAttempts) {
    const res = await app.request(path);
    assert.equal(res.status, 404, `should reject unsafe asset path: ${path}`);
    const bodyText = await res.text();
    assert.ok(!bodyText.includes("TOP_SECRET_PASSWORD"), "secret password must never be exposed via traversal");
  }
  ok("asset endpoint strictly rejects traversal (tested against real secret file outside assets), subpaths, and encoded separators with 404");

  // 5. Simulate rebuild: rotate assets without restarting daemon/app
  rmSync(join(distDir, "assets"), { recursive: true, force: true });
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<!DOCTYPE html><html><head><title>Test v2</title></head><body>V2</body></html>");
  writeFileSync(join(distDir, "assets", "index-new99999.js"), 'console.log("v2");');
  writeFileSync(join(distDir, "assets", "style-new99999.css"), 'body { color: blue; }');

  // Old hashed asset should now 404
  const rOldAsset = await app.request("/assets/index-abc12345.js");
  assert.equal(rOldAsset.status, 404, "old hashed asset must 404 after rebuild");
  assert.equal((await app.request("/assets/style-def67890.css")).status, 404);
  const newCss = await app.request("/assets/style-new99999.css");
  assert.equal(newCss.status, 200);
  assert.match(await newCss.text(), /blue/);

  // New index and new asset should serve correctly
  const rNewIndex = await app.request("/");
  assert.equal(rNewIndex.status, 200);
  assert.match(await rNewIndex.text(), /V2/);

  const rNewAsset = await app.request("/assets/index-new99999.js");
  assert.equal(rNewAsset.status, 200);
  assert.match(await rNewAsset.text(), /v2/);

  // Worker should dynamically reflect new version/files without restart
  const rNewWorker = await app.request("/sw.js");
  assert.equal(rNewWorker.status, 200);
  const newWorkerText = await rNewWorker.text();
  assert.ok(newWorkerText.includes("index-new99999.js"), "worker version/list must change on rebuild without daemon restart");
  assert.ok(!newWorkerText.includes("index-abc12345.js"), "old assets removed from worker file list");
  assert.ok(newWorkerText.includes("style-new99999.css"));
  assert.ok(!newWorkerText.includes("style-def67890.css"));
  assert.notEqual(/const VERSION = "([^"]+)"/.exec(newWorkerText)?.[1], /const VERSION = "([^"]+)"/.exec(workerText)?.[1], "worker cache version must change too");

  ok("rebuild rotation verified: old assets 404, new assets and worker shell list updated live without app restart");

  console.log("ALL VERIFY-WEB-REBUILD TESTS PASSED");
} finally {
  rmSync(d, { recursive: true, force: true });
}
