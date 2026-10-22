// Splits assistant text into markdown, MEDIA: attachments, and ```ui widget blocks, in order.
import { openFence, fenceLang, findFenceEnd } from "./fences";
import { mediaDirectives } from "./media";

export type Segment =
  | { kind: "md"; text: string }
  | { kind: "media"; url: string; name: string; type: string }
  | { kind: "ui"; json: string; closed: boolean };

interface UiRange { start: number; end: number; json: string; closed: boolean }

// Character ranges of every top-level `ui` fence. Other fences are skipped whole, so a ui
// example inside a longer or different fence stays plain text.
function uiRanges(text: string): UiRange[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) { starts.push(at); at += l.length + 1; }
  const out: UiRange[] = [];
  for (let i = 0; i < lines.length; ) {
    const fence = openFence(lines[i]);
    if (!fence) { i++; continue; }
    const close = findFenceEnd(lines, i + 1, fence);
    const last = close === -1 ? lines.length - 1 : close;
    if (fenceLang(fence).toLowerCase() === "ui") {
      out.push({
        start: starts[i],
        end: Math.min(text.length, starts[last] + lines[last].length + 1),
        json: lines.slice(i + 1, close === -1 ? lines.length : close).join("\n"),
        closed: close !== -1,
      });
    }
    i = last + 1;
  }
  return out;
}

export function segments(text: string, media?: { base: string; offset: number }): Segment[] {
  const ranges = uiRanges(text);
  const items: { start: number; end: number; seg: Segment }[] = ranges.map(r => ({ start: r.start, end: r.end, seg: { kind: "ui", json: r.json, closed: r.closed } }));
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
  return out;
}
