// Contract: MEDIA:<path> directives are found in text order, never inside code, and the server and web UI
// agree on their index. SVG is never inline media, because it can carry script.
import { test, expect } from "bun:test";
import { entryMedia, mediaDirectives, mediaInfo } from "../src/media-directives.js";

test("directives: bare, quoted with spaces, and in text order", () => {
  const got = mediaDirectives('See MEDIA:/out/a.png and MEDIA: "/out/my file.pdf" then MEDIA:\'/out/b.mp3\'.');
  expect(got.map(d => [d.raw, d.type])).toEqual([["/out/a.png", "image"], ["/out/my file.pdf", "document"], ["/out/b.mp3", "voice"]]);
});

test("directives inside fenced or inline code are text", () => {
  const text = "MEDIA:/a.png\n```\nMEDIA:/fenced.png\n```\n~~~md\nMEDIA:/tilde.png\n~~~\nuse `MEDIA:/inline.png` like this\nMEDIA:/b.png";
  expect(mediaDirectives(text).map(d => d.raw)).toEqual(["/a.png", "/b.png"]);
  // An unclosed fence runs to the end of the text.
  expect(mediaDirectives("MEDIA:/a.png\n```\nMEDIA:/never.png").map(d => d.raw)).toEqual(["/a.png"]);
});

test("types: SVG and unknown extensions are documents", () => {
  expect(mediaInfo("/x/logo.SVG")).toEqual({ name: "logo.SVG", mimeType: "image/svg+xml", type: "document" });
  expect(mediaInfo("/x/clip.webm").type).toBe("video");
  expect(mediaInfo("/x/blob")).toEqual({ name: "blob", mimeType: "application/octet-stream", type: "document" });
  expect(mediaInfo("/x/.png").mimeType).toBe("application/octet-stream") /* "a dotfile has no extension" */;
});

test("entry media: assistant text blocks only, numbered across messages and blocks", () => {
  const model = [
    { role: "user", content: "MEDIA:/user.png" },
    { role: "assistant", content: "MEDIA:/one.png" },
    { role: "assistant", content: [{ type: "thinking", thinking: "MEDIA:/think.png" }, { type: "text", text: "x" },
      { type: "text", text: "MEDIA:/two.png MEDIA:/three.png" }] },
  ];
  expect(entryMedia(model).map(d => [d.raw, d.message, d.block])).toEqual([["/one.png", 1, 0], ["/two.png", 2, 2], ["/three.png", 2, 2]]);
  expect(entryMedia(undefined)).toEqual([]);
});
