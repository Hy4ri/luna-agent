import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { registerTS } from "vue/compiler-sfc";
import ts from "typescript5";

// Root uses TypeScript 7 (no JS API). Vue SFC type resolution needs the TS 5 compiler API.
registerTS(() => ts as never);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("../dist/web", import.meta.url)), emptyOutDir: true, assetsDir: "assets", sourcemap: false },
  server: { proxy: { "/v1": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" } },
});
