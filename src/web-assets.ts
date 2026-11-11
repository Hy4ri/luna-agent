import { HTML_PREVIEW_CSP, HTML_PREVIEW_SHELL } from "./html-preview.js";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";

export function createWebApp(root: URL): Hono {
  const app = new Hono();

  // No auth or stored content: this shell receives only the displayed HTML from its parent.
  // The response sandbox also protects direct visits, independently of iframe attributes.
  app.get("/html-preview", c => c.html(HTML_PREVIEW_SHELL, 200, {
    "content-security-policy": HTML_PREVIEW_CSP,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
  }));

  const loadBuild = () => {
    try {
      const page = readFileSync(new URL("index.html", root), "utf8");
      const assets = readdirSync(new URL("assets/", root), { withFileTypes: true })
        .filter(item => item.isFile()).map(item => item.name).sort();
      // icon.svg is only a PNG wrapper for old pages. It stays served but is not part of the installed shell.
      const fixed = ["/", "/manifest.webmanifest", "/favicon.png", "/icon.png"];
      const files = [...fixed, ...assets.map(n => "/assets/" + n)];
      // Only static entry dependencies block installation. Dynamic imports warm after the page loads.
      const manifest = JSON.parse(readFileSync(new URL(".vite/manifest.json", root), "utf8")) as Record<string, {
        file: string; isEntry?: boolean; imports?: string[]; css?: string[]; assets?: string[];
      }>;
      const core = new Set(fixed), visited = new Set<string>(), allowed = new Set(files);
      const visit = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        const chunk = manifest[key];
        if (!chunk) throw new Error("Missing static entry dependency");
        for (const asset of [chunk.file, ...chunk.css ?? [], ...chunk.assets ?? []]) {
          const path = "/" + asset;
          if (!allowed.has(path)) throw new Error("Missing shell asset");
          core.add(path);
        }
        for (const imported of chunk.imports ?? []) visit(imported);
      };
      for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
      if (!visited.size) throw new Error("Missing shell entry");
      const worker = readFileSync(new URL("sw.js", root), "utf8");
      const version = "luna-vue-" + new Bun.CryptoHasher("sha256").update(page).update(worker).update(JSON.stringify(files)).digest("hex").slice(0, 16);
      const swCode = worker
        .replace("__SHELL_VERSION__", version)
        .replace("__SHELL_FILES__", JSON.stringify(files))
        .replace("__SHELL_CORE__", JSON.stringify([...core]));
      return { page, swCode };
    } catch {
      return null;
    }
  };

  app.get("/", (c) => {
    const build = loadBuild();
    if (!build) return c.text("Web UI is not built. Run bun run build:web.", 503);
    // Only the internal session pane can be framed, and only by this origin.
    const pane = c.req.query("pane") === "session";
    return c.html(build.page, 200, { "cache-control": "no-cache", "x-frame-options": pane ? "SAMEORIGIN" : "DENY", "content-security-policy": `frame-ancestors ${pane ? "'self'" : "'none'"}`, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  });

  app.get("/sw.js", (c) => {
    const build = loadBuild();
    if (!build) return c.text("Service worker not available", 503);
    return c.body(build.swCode, 200, { "content-type": "text/javascript; charset=UTF-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  });

  for (const path of ["/manifest.webmanifest", "/icon.svg", "/icon.png", "/favicon.png"]) {
    const type = path.endsWith(".svg") ? "image/svg+xml; charset=UTF-8" : path.endsWith(".png") ? "image/png" : "application/manifest+json; charset=UTF-8";
    app.get(path, (c) => {
      try {
        return c.body(readFileSync(new URL(path.slice(1), root)), 200, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      } catch {
        return c.notFound();
      }
    });
  }

  app.get("/assets/*", (c) => {
    const subpath = c.req.path.slice("/assets/".length);
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(subpath) || subpath.includes("..")) {
      return c.notFound();
    }
    try {
      const data = readFileSync(new URL("assets/" + subpath, root));
      const type = subpath.endsWith(".js") ? "text/javascript; charset=UTF-8" : subpath.endsWith(".css") ? "text/css; charset=UTF-8" : subpath.endsWith(".svg") ? "image/svg+xml; charset=UTF-8" : subpath.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
      return c.body(data, 200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
    } catch {
      return c.notFound();
    }
  });

  return app;
}
