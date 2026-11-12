import { test, expect } from "bun:test";
import { normalizeUrl, toPagePoint } from "../../web/src/lib/browser-view.ts";

const box = { left: 100, top: 50, width: 400, height: 400 };

test("maps a click on a letterboxed canvas to page pixels", () => {
  // 800x400 bitmap in a 400x400 box: scale 0.5, picture 400x200, bars of 100px above and below.
  const bitmap = { width: 800, height: 400 };
  expect(toPagePoint(100, 150, box, bitmap, bitmap)).toEqual({ x: 0, y: 0 });
  expect(toPagePoint(300, 250, box, bitmap, bitmap)).toEqual({ x: 400, y: 200 });
  expect(toPagePoint(300, 100, box, bitmap, bitmap)).toBe(null) /* "inside the top bar" */;
});

test("scales to the page size when it differs from the bitmap", () => {
  expect(toPagePoint(300, 250, box, { width: 400, height: 400 }, { width: 800, height: 800 })).toEqual({ x: 400, y: 400 });
});

test("empty bitmap or box gives null", () => {
  expect(toPagePoint(1, 1, box, { width: 0, height: 0 }, { width: 0, height: 0 })).toBe(null);
});

test("normalizeUrl adds https to bare hosts only", () => {
  expect(normalizeUrl(" example.com/a ")).toBe("https://example.com/a");
  expect(normalizeUrl("http://x.test")).toBe("http://x.test");
  expect(normalizeUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
  expect(normalizeUrl("")).toBe("");
});
