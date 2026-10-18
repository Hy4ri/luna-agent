// Only files explicitly named by a background answer are available through its authenticated job URL.
import { basename, extname, isAbsolute, resolve } from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
};
export function sideMedia(text: string, cwd = process.cwd()) {
  return [...text.matchAll(/MEDIA:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>`]+))/g)].map(match => {
    const raw = match[1] ?? match[2] ?? match[3]!;
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const mimeType = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    return { path, name: basename(path), mimeType, directive: match[0],
      type: mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "voice" : mimeType.startsWith("video/") ? "video" : "document" };
  });
}
export async function readSideMedia(path: string): Promise<Uint8Array> {
  // Do not follow a final symlink or read devices, pipes, or sockets.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    return await file.readFile();
  } finally { await file.close(); }
}
