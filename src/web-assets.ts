import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

export function createWebApp(root: URL): Hono {
  const app = new Hono();

  const loadBuild = () => {
    try {
      const page = readFileSync(new URL("index.html", root), "utf8");
      const assets = readdirSync(new URL("assets/", root), { withFileTypes: true })
        .filter(item => item.isFile()).map(item => item.name).sort();
      const files = ["/", "/manifest.webmanifest", "/icon.svg", ...assets.map(n => "/assets/" + n)];
      const worker = readFileSync(new URL("sw.js", root), "utf8");
      const version = "luna-vue-" + createHash("sha256").update(page).update(worker).update(JSON.stringify(files)).digest("hex").slice(0, 16);
      const swCode = worker
        .replace("__SHELL_VERSION__", version)
        .replace("__SHELL_FILES__", JSON.stringify(files));
      return { page, swCode };
    } catch {
      return null;
    }
  };

  app.get("/", (c) => {
    const build = loadBuild();
    if (!build) return c.text("Web UI is not built. Run pnpm run build:web.", 503);
    // Only the internal session pane can be framed, and only by this origin.
    const pane = c.req.query("pane") === "session";
    return c.html(build.page, 200, { "cache-control": "no-cache", "x-frame-options": pane ? "SAMEORIGIN" : "DENY", "content-security-policy": `frame-ancestors ${pane ? "'self'" : "'none'"}`, "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  });

  app.get("/sw.js", (c) => {
    const build = loadBuild();
    if (!build) return c.text("Service worker not available", 503);
    return c.body(build.swCode, 200, { "content-type": "text/javascript; charset=UTF-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  });

  for (const path of ["/manifest.webmanifest", "/icon.svg"]) {
    const type = path.endsWith(".svg") ? "image/svg+xml; charset=UTF-8" : "application/manifest+json; charset=UTF-8";
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
      const type = subpath.endsWith(".js") ? "text/javascript; charset=UTF-8" : subpath.endsWith(".css") ? "text/css; charset=UTF-8" : subpath.endsWith(".svg") ? "image/svg+xml; charset=UTF-8" : "application/octet-stream";
      return c.body(data, 200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
    } catch {
      return c.notFound();
    }
  });

  return app;
}
