import { test, expect } from "bun:test";
import { StreamPacer } from "../../web/src/lib/stream-pacer.ts";

test("StreamPacer reveals text gradually without splitting emojis or combining marks", () => {
  const pacer = new StreamPacer(130);
  const sample = "Hi 🚀✨ السَّلَامُ";
  pacer.setTarget(sample);

  const steps: string[] = [];
  for (let i = 0; i < 60 && pacer.hasPending; i++) {
    const next = pacer.step(16.67);
    if (next !== null) steps.push(next);
  }

  expect(steps.length).toBeGreaterThan(2);
  expect(pacer.displayed).toBe(sample);
  expect(pacer.hasPending).toBe(false);
  // Ensure no broken surrogate halves appeared in any intermediate frame
  for (const s of steps) {
    expect(s).toBe(s.toWellFormed());
  }
});

test("StreamPacer snaps immediately when requested and handles prefix changes", () => {
  const pacer = new StreamPacer(130);
  expect(pacer.setTarget("Hello there", true)).toBe(true);
  expect(pacer.displayed).toBe("Hello there");
  expect(pacer.hasPending).toBe(false);

  expect(pacer.setTarget("Hello world")).toBe(true);
  expect(pacer.displayed).toBe("Hello ");
  expect(pacer.hasPending).toBe(true);
  expect(pacer.flush()).toBe("Hello world");
  expect(pacer.hasPending).toBe(false);
});

test("IncrementalMarkdown reconciles streaming DOM cleanly", async () => {
  const check = new URL("./support/markdown-stream-check.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, check], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code, `Markdown stream check failed:\n${out}${err}`).toBe(0);
});
