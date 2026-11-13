import { test, expect } from "bun:test";

const check = new URL("./support/activity-read-check.ts", import.meta.url).pathname;

test("activity mark-read syncs finished sessions with server and rolls back on failure", async () => {
  const proc = Bun.spawn([process.execPath, check], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code, `Activity read check failed:\n${out}${err}`).toBe(0);
});
