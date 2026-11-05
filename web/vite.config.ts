import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { registerTS } from "vue/compiler-sfc";
import ts from "typescript5";

// Root uses TypeScript 7 (no JS API). Vue SFC type resolution needs the TS 5 compiler API.
registerTS(() => ts as never);

// Keep the worker in the build output. The HTTP server injects the current shell list on each request.
function serviceWorker(): Plugin {
  return {
    name: "luna-service-worker",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sw.js", source: stripTypeScriptTypes(readFileSync(new URL("./sw.ts", import.meta.url), "utf8")) });
    },
  };
}

// Packages reachable only through these lazy imports stay out of the eager vendor chunk.
const LAZY_ONLY = ["mermaid", "katex"];

function dependencyClosure(roots: string[], from: string, skip: Set<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string, dir: string) => {
    if (seen.has(name) || skip.has(name)) return;
    // Node lookup by hand: require.resolve fails for packages whose exports hide package.json.
    let pkgDir = "";
    for (let d = dir; ; d = dirname(d)) {
      if (existsSync(join(d, "node_modules", name, "package.json"))) { pkgDir = realpathSync(join(d, "node_modules", name)); break; }
      if (dirname(d) === d) return;
    }
    seen.add(name);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pkgDir);
  };
  for (const root of roots) visit(root, from);
  return seen;
}

function lazyOnlyPackages(): Set<string> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as Record<string, Record<string, string> | undefined>;
  const direct = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const eager = dependencyClosure(direct.filter(d => !LAZY_ONLY.includes(d)), root, new Set(LAZY_ONLY));
  return new Set([...dependencyClosure(LAZY_ONLY, root)].filter(d => !eager.has(d)));
}

const lazyOnly = lazyOnlyPackages();
const packageName = (id: string) => /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/](?!.*node_modules)/.exec(id)?.[1]?.replace("\\", "/");
const isVendor = (id: string) => id.includes("node_modules") && !lazyOnly.has(packageName(id) ?? "");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue(), tailwindcss(), serviceWorker()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true, assetsDir: "assets", sourcemap: false, rolldownOptions: { output: { codeSplitting: { groups: [{ name: "vendor", test: isVendor }] } } } },
  server: { proxy: { "/html-preview": "http://127.0.0.1:8787", "/v1": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" } },
});
