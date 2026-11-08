// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
import assert from "node:assert/strict";
import { test } from "bun:test";
(globalThis as { window?: unknown }).window ??= { innerWidth: 1600, innerHeight: 900 };
(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => {} };
const { clampWidth, clampHeight, effectivePosition, loadPosition, loadWidth } = await import("../../web/src/stores/dock.ts");

test("clampWidth keeps the dock between 320 px and 70% of the area", () => {
  assert.equal(clampWidth(100, 1000), 320);
  assert.equal(clampWidth(500, 1000), 500);
  assert.equal(clampWidth(900, 1000), 700);
  assert.equal(clampWidth(900, 200), 320);
});

test("clampHeight keeps the dock between 120 px and 80% of the area", () => {
  assert.equal(clampHeight(10, 1000), 120);
  assert.equal(clampHeight(2000, 1000), 800);
});

test("a narrow chat area forces the bottom position without changing the saved one", () => {
  assert.equal(effectivePosition("right", 899), "bottom");
  assert.equal(effectivePosition("right", 900), "right");
  assert.equal(effectivePosition("bottom", 2000), "bottom");
});

test("stored values fall back to safe defaults", () => {
  assert.equal(loadPosition("right"), "right");
  assert.equal(loadPosition("left"), "bottom");
  assert.equal(loadPosition(null), "bottom");
  assert.equal(loadWidth("100"), 420);
  assert.equal(loadWidth("nope"), 420);
  assert.equal(loadWidth("500"), 500);
});
