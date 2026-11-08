import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatStamp, stampMessages } from "../src/message-time.js";

const ts = new Date(2026, 10, 7, 1, 55).getTime();

test("formatStamp renders local date, time and offset", () => {
  assert.match(formatStamp(ts), /^\[2026-11-07 01:55 [+-]\d{2}(\d{2})?\]$/);
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
  assert.equal(out[0].content, `${s} hi`);
  assert.equal(out[1].content[1].text, `${s} look`);
  assert.equal(out[1].content[0].type, "image");
  assert.deepEqual(out[2].content[0], { type: "text", text: s });
  assert.equal(out[3], msgs[3]);
  assert.equal(out[4], msgs[4]);
  assert.equal(msgs[0].content, "hi", "input is not mutated");
});

test("stampMessages is deterministic for cache stability", () => {
  const msgs: any[] = [{ role: "user", content: "a", timestamp: ts }];
  assert.deepEqual(stampMessages(msgs), stampMessages(msgs));
});

test("stampMessages returns same array when nothing to stamp", () => {
  const msgs: any[] = [{ role: "assistant", content: [], timestamp: ts }];
  assert.equal(stampMessages(msgs), msgs);
});
