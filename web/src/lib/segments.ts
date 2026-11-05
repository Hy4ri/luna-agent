// Splits assistant text into markdown, MEDIA: attachments, and rich fences (ui, html, mermaid, math), in order.
import { openFence, fenceLang, findFenceEnd } from "./fences";
import { mediaDirectives } from "./media";

export type Segment =
  | { kind: "md"; text: string }
  | { kind: "media"; url: string; name: string; type: string }
  | { kind: "block"; lang: BlockLang; source: string; closed: boolean; excess?: boolean };

export type BlockLang = "ui" | "html" | "mermaid" | "math";
const BLOCK_LANGS = new Set<string>(["ui", "html", "mermaid", "math"]);

// The prompt tells the model to use at most this many ui/html blocks per message. Extra blocks do not execute.
export const MAX_WIDGETS = 4;

interface PreviewRange { start: number; end: number; kind: BlockLang; content: string; closed: boolean }

// Character ranges of every top-level rich fence. Other fences are skipped whole, so a preview
// example inside a longer or different fence stays plain text.
function previewRanges(text: string): PreviewRange[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const out: PreviewRange[] = [];
  for (let i = 0; i < lines.length; ) {
    const fence = openFence(lines[i]);
    if (!fence) { i++; continue; }
    const close = findFenceEnd(lines, i + 1, fence);
    const last = close === -1 ? lines.length - 1 : close;
    const kind = fenceLang(fence).toLowerCase();
    if (BLOCK_LANGS.has(kind)) {
      out.push({
        start: starts[i],
        end: Math.min(text.length, starts[last] + lines[last].length + 1),
        kind: kind as BlockLang,
        content: lines.slice(i + 1, close === -1 ? lines.length : close).join("\n"),
        closed: close !== -1,
      });
    }
    i = last + 1;
  }
  return out;
}

export function segments(text: string, media?: { base: string; offset: number }): Segment[] {
  const ranges = previewRanges(text);
  const items: { start: number; end: number; seg: Segment }[] = ranges.map(r => ({ start: r.start, end: r.end, seg: { kind: "block", lang: r.kind, source: r.content, closed: r.closed } }));
  // Without a media base (live text) the directives stay in the markdown.
  if (media) {
    mediaDirectives(text).forEach((d, i) => {
      if (ranges.some(r => d.index >= r.start && d.index < r.end)) return;
      items.push({ start: d.index, end: d.index + d.directive.length, seg: { kind: "media", url: `${media.base}/${media.offset + i}`, name: d.name, type: d.type } });
    });
  }
  items.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const it of items) {
    if (it.start > cursor) out.push({ kind: "md", text: text.slice(cursor, it.start) });
    out.push(it.seg);
    cursor = it.end;
  }
  if (cursor < text.length) out.push({ kind: "md", text: text.slice(cursor) });
  let widgets = 0;
  for (const seg of out) if (seg.kind === "block" && (seg.lang === "ui" || seg.lang === "html") && ++widgets > MAX_WIDGETS) seg.excess = true;
  return out;
}
