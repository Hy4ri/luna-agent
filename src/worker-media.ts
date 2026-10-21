// Serve a file explicitly named by MEDIA: from the machine that produced the answer.
import type { Context as HonoContext } from "hono";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { WorkerHub } from "./workers.js";
import type { MediaDirective } from "./media-directives.js";

export async function workerMediaResponse(c: HonoContext, hub: WorkerHub, worker: number, cwd: string | undefined, media: MediaDirective) {
  const env = hub.env(worker, cwd);
  const ctx = withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT);
  const path = await env.absolutePath(media.raw, ctx);
  if (!path.ok) return c.json({ error: path.error.message }, 404);
  const opened = await env.openBinaryReader(path.value, { noFollow: true }, ctx);
  if (!opened.ok) return c.json({ error: opened.error.message }, 404);
  const reader = opened.value;
  const info = await reader.info(ctx);
  if (!info.ok || info.value.kind !== "file") {
    await reader.close(BACKGROUND_CONTEXT);
    return c.json({ error: "not a regular file" }, 404);
  }
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (offset >= info.value.size) { await reader.close(BACKGROUND_CONTEXT); controller.close(); return; }
        const result = await reader.read(offset, Math.min(65536, info.value.size - offset), ctx);
        if (!result.ok) throw result.error;
        if (!result.value.length) throw new Error("File changed during transfer.");
        offset += result.value.length; controller.enqueue(result.value);
      } catch (e) { await reader.close(BACKGROUND_CONTEXT); controller.error(e); }
    },
    async cancel() { await reader.close(BACKGROUND_CONTEXT); },
  });
  return c.body(stream, 200, { "content-type": media.mimeType, "content-length": String(info.value.size), "cache-control": "private, no-store",
    "x-content-type-options": "nosniff", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(media.name)}` });
}
