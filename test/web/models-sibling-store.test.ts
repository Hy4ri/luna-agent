import { test, expect } from "bun:test";

const check = new URL("./support/models-sibling-check.ts", import.meta.url).pathname;

test("models store handles sibling thinking-level model switching and busy guard", async () => {
  const proc = Bun.spawn([process.execPath, check], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code, `Sibling store check failed:\n${out}${err}`).toBe(0);
});
