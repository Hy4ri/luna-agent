import { test, expect } from "bun:test";
import { formatStamp, stampMessages } from "../src/message-time.js";

const ts = new Date(2026, 10, 7, 1, 55).getTime();

test("formatStamp renders local date, time and offset", () => {
  expect(formatStamp(ts)).toMatch(/^\[2026-11-07 01:55 [+-]\d{2}(\d{2})?\]$/);
});

test("stampMessages prefixes string and part user content, leaves others", () => {
  const msgs: any[] = [
    { role: "user", content: "hi", timestamp: ts },
    { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "look" }], timestamp: ts },
    { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: ts },
    { role: "user", content: "no time" },
    { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: ts },
  ];
  const out: any[] = stampMessages(msgs) as any[];
  const s = formatStamp(ts);
  expect(out[0].content).toBe(`${s} hi`);
  expect(out[1].content[1].text).toBe(`${s} look`);
  expect(out[1].content[0].type).toBe("image");
  expect(out[2].content[0]).toEqual({ type: "text", text: s });
  expect(out[3]).toBe(msgs[3]);
  expect(out[4]).toBe(msgs[4]);
  expect(msgs[0].content).toBe("hi") /* "input is not mutated" */;
});

test("stampMessages is deterministic for cache stability", () => {
  const msgs: any[] = [{ role: "user", content: "a", timestamp: ts }];
  expect(stampMessages(msgs)).toEqual(stampMessages(msgs));
});

test("stampMessages returns same array when nothing to stamp", () => {
  const msgs: any[] = [{ role: "assistant", content: [], timestamp: ts }];
  expect(stampMessages(msgs)).toBe(msgs);
});
