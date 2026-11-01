import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_UPLOAD_BYTES } from "../uploads.js";
import { context } from "../luna.js";
import type { RouteCtx } from "./context.js";

export function registerUploads(app: Hono, ctx: RouteCtx): void {
  const { opts, harness, err } = ctx;

  app.post("/v1/uploads", bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: c => err(c, 413, "file too large (32 MB max)") }), async c => {
      if (!opts.uploads) return err(c, 503, "upload storage unavailable");
      const name = c.req.query("name");
      if (!name?.trim()) return err(c, 400, "file name required");
      const data = new Uint8Array(await c.req.arrayBuffer());
      const metadata = await harness.commit(
        () =>
          opts.uploads!.put({
            name,
            mimeType: c.req.header("content-type") || "application/octet-stream",
            data,
          }),
        context,
      );
      return c.json(metadata, 201);
    },
  );

  app.get("/v1/uploads/:id", (c) => {
    const file = opts.uploads?.get(c.req.param("id"));
    if (!file) return err(c, 404, "uploaded file not found");
    const bytes = opts.uploads!.read(file.id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": file.mimeType,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });
}
