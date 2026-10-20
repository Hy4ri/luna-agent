// Only files explicitly named by an assistant answer are available, through that answer's authenticated URL.
import { isAbsolute, resolve } from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import type { Context as HonoContext } from "hono";
import { mediaDirectives, type MediaDirective } from "./media-directives.js";

export type ResolvedMedia = MediaDirective & { path: string };
export const resolveMedia = (d: MediaDirective, cwd = process.cwd()): ResolvedMedia => ({ ...d, path: isAbsolute(d.raw) ? d.raw : resolve(cwd, d.raw) });

export function sideMedia(text: string, cwd = process.cwd()): ResolvedMedia[] {
  return mediaDirectives(text).map(d => resolveMedia(d, cwd));
}

/** Open a regular file without following a final symlink or touching devices, pipes, or sockets. */
export async function openMedia(path: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    return { size: stat.size, stream: Readable.toWeb(file.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array> };
  } catch (e) { await file.close(); throw e; }
}

export async function readSideMedia(path: string): Promise<Uint8Array> {
  const { stream } = await openMedia(path);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Stream a named file, or a JSON error that says why it is unavailable. */
export async function mediaResponse(c: HonoContext, media: ResolvedMedia | undefined) {
  if (!media) return c.json({ error: "no such media" }, 404);
  try {
    const { size, stream } = await openMedia(media.path);
    return c.body(stream, 200, { "content-type": media.mimeType, "content-length": String(size), "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(media.name)}` });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "file not found" : code === "EACCES" || code === "EPERM" ? "permission denied"
      : code === "ELOOP" ? "symlinks are not served" : code === "EISDIR" || (e as Error).message === "not a regular file" ? "not a regular file" : "file unreadable";
    return c.json({ error: why }, 404);
  }
}
