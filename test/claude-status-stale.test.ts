import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceClaudeStatusClockForTest, invalidateClaudeLoginStatus, readClaudeLoginStatusCached } from "../src/claude-native/status.js";

const dir = mkdtempSync(join(tmpdir(), "claude-status-"));
const counter = join(dir, "count");
const fake = join(dir, "claude");
writeFileSync(counter, "");
writeFileSync(fake, `#!/bin/sh\necho x >> ${counter}\nsleep 0.3\necho '{"loggedIn":true,"subscriptionType":"max"}'\n`);
chmodSync(fake, 0o755);
const previous = process.env.LUNA_CLAUDE_EXECUTABLE;
process.env.LUNA_CLAUDE_EXECUTABLE = fake;
afterAll(() => {
  if (previous === undefined) delete process.env.LUNA_CLAUDE_EXECUTABLE; else process.env.LUNA_CLAUDE_EXECUTABLE = previous;
  invalidateClaudeLoginStatus();
  rmSync(dir, { recursive: true, force: true });
});
const spawns = () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length;

test("an expired login status is served stale while one background check refreshes it", async () => {
  invalidateClaudeLoginStatus();
  const first = await readClaudeLoginStatusCached();
  expect(first.loggedIn).toBe(true);
  expect(spawns()).toBe(1);

  advanceClaudeStatusClockForTest(61_000);
  const t = performance.now();
  const stale = await readClaudeLoginStatusCached();
  expect(performance.now() - t).toBeLessThan(100);
  expect(stale.loggedIn).toBe(true);
  await readClaudeLoginStatusCached();
  await Bun.sleep(600);
  expect(spawns()).toBe(2);

  // A login change still forces a fresh, awaited check.
  invalidateClaudeLoginStatus();
  const t2 = performance.now();
  await readClaudeLoginStatusCached();
  expect(performance.now() - t2).toBeGreaterThan(250);
  expect(spawns()).toBe(3);
});
