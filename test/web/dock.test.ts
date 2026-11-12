// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
import { test, expect } from "bun:test";
(globalThis as { window?: unknown }).window ??= { innerWidth: 1600, innerHeight: 900 };
(globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => {} };
const { clampWidth, clampHeight, effectivePosition, loadPosition, loadWidth } = await import("../../web/src/stores/dock.ts");

test("clampWidth keeps the dock between 320 px and 70% of the area", () => {
  expect(clampWidth(100, 1000)).toBe(320);
  expect(clampWidth(500, 1000)).toBe(500);
  expect(clampWidth(900, 1000)).toBe(700);
  expect(clampWidth(900, 200)).toBe(320);
});

test("clampHeight keeps the dock between 120 px and 80% of the area", () => {
  expect(clampHeight(10, 1000)).toBe(120);
  expect(clampHeight(2000, 1000)).toBe(800);
});

test("a narrow chat area forces the bottom position without changing the saved one", () => {
  expect(effectivePosition("right", 899)).toBe("bottom");
  expect(effectivePosition("right", 900)).toBe("right");
  expect(effectivePosition("bottom", 2000)).toBe("bottom");
});

test("stored values fall back to safe defaults", () => {
  expect(loadPosition("right")).toBe("right");
  expect(loadPosition("left")).toBe("bottom");
  expect(loadPosition(null)).toBe("bottom");
  expect(loadWidth("100")).toBe(420);
  expect(loadWidth("nope")).toBe(420);
  expect(loadWidth("500")).toBe(500);
});
