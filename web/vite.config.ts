import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
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

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue(), tailwindcss(), serviceWorker()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true, assetsDir: "assets", sourcemap: false, rolldownOptions: { output: { codeSplitting: { groups: [{ name: "vendor", test: /node_modules/ }] } } } },
  server: { proxy: { "/html-preview": "http://127.0.0.1:8787", "/v1": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" } },
});
