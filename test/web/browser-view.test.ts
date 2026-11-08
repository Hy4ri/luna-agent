import assert from "node:assert/strict";
import { test } from "bun:test";
import { normalizeUrl, toPagePoint } from "../../web/src/lib/browser-view.ts";

const box = { left: 100, top: 50, width: 400, height: 400 };

test("maps a click on a letterboxed canvas to page pixels", () => {
  // 800x400 bitmap in a 400x400 box: scale 0.5, picture 400x200, bars of 100px above and below.
  const bitmap = { width: 800, height: 400 };
  assert.deepEqual(toPagePoint(100, 150, box, bitmap, bitmap), { x: 0, y: 0 });
  assert.deepEqual(toPagePoint(300, 250, box, bitmap, bitmap), { x: 400, y: 200 });
  assert.equal(toPagePoint(300, 100, box, bitmap, bitmap), null, "inside the top bar");
});

test("scales to the page size when it differs from the bitmap", () => {
  assert.deepEqual(toPagePoint(300, 250, box, { width: 400, height: 400 }, { width: 800, height: 800 }), { x: 400, y: 400 });
});

test("empty bitmap or box gives null", () => {
  assert.equal(toPagePoint(1, 1, box, { width: 0, height: 0 }, { width: 0, height: 0 }), null);
});

test("normalizeUrl adds https to bare hosts only", () => {
  assert.equal(normalizeUrl(" example.com/a "), "https://example.com/a");
  assert.equal(normalizeUrl("http://x.test"), "http://x.test");
  assert.equal(normalizeUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(normalizeUrl(""), "");
});
