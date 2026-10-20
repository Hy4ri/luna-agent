// MEDIA:<path> directives in assistant text. Shared by the server and the web UI (no Node APIs),
// so both sides agree on which directives exist and on their order.

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".pdf": "application/pdf", ".zip": "application/zip", ".json": "application/json",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".log": "text/plain",
};
export type MediaType = "image" | "voice" | "video" | "document";
export interface MediaDirective { directive: string; raw: string; index: number; name: string; mimeType: string; type: MediaType }

export function mediaInfo(path: string): { name: string; mimeType: string; type: MediaType } {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const dot = name.lastIndexOf(".");
  const mimeType = (dot > 0 && TYPES[name.slice(dot).toLowerCase()]) || "application/octet-stream";
  // SVG can carry script; serve it as a file, never inline.
  const type: MediaType = mimeType === "image/svg+xml" ? "document" : mimeType.startsWith("image/") ? "image"
    : mimeType.startsWith("audio/") ? "voice" : mimeType.startsWith("video/") ? "video" : "document";
  return { name, mimeType, type };
}

/** Directives in text order. Directives inside fenced code blocks or inline code are text, not media. */
export function mediaDirectives(text: string): MediaDirective[] {
  const code: [number, number][] = [];
  for (const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))|(`+)[^`\n]+?\2/gm)) code.push([m.index, m.index + m[0].length]);
  const out: MediaDirective[] = [];
  for (const m of text.matchAll(/MEDIA:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>`"']+))/g)) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const raw = m[1] ?? m[2] ?? m[3]!;
    out.push({ directive: m[0], raw, index: m.index, ...mediaInfo(raw) });
  }
  return out;
}

/** Text blocks of assistant messages, in the order the server numbers their media. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assistantTextBlocks(model: readonly any[] | undefined): { message: number; block: number; text: string }[] {
  const out: { message: number; block: number; text: string }[] = [];
  (model ?? []).forEach((msg, message) => {
    if (msg?.role !== "assistant") return;
    const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    content.forEach((c: { type?: string; text?: unknown }, block: number) => { if (c?.type === "text" && typeof c.text === "string") out.push({ message, block, text: c.text }); });
  });
  return out;
}

/** Media of one entry: a flat list whose position is the URL index. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function entryMedia(model: readonly any[] | undefined): (MediaDirective & { message: number; block: number })[] {
  return assistantTextBlocks(model).flatMap(({ message, block, text }) => mediaDirectives(text).map(d => ({ ...d, message, block })));
}
