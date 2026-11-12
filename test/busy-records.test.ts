// Contract: unreadable saved process records are kept aside once, not re-parsed and re-logged on every start.
// Contract: output snapshots are written once after new output; an idle manager keeps no polling timer.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BusyExecutions } from "../src/busy-tools.js";

const record = (id: string) => JSON.stringify({ version: 1, id, session: 5, owner: "o", command: "true", createdAt: 1,
  finishedAt: Date.now(), status: "complete", exitCode: 0, output: "ok", truncated: false, delivered: true });

test("an empty or NUL-filled process record is quarantined once and valid records still load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-busy-records-"));
  try {
    const good = "11111111-1111-4111-8111-111111111111", empty = "22222222-2222-4222-8222-222222222222", nul = "33333333-3333-4333-8333-333333333333";
    writeFileSync(join(dir, `${good}.json`), record(good));
    writeFileSync(join(dir, `${empty}.json`), "");
    writeFileSync(join(dir, `${nul}.json`), Buffer.alloc(64));
    const logs: string[] = [];
    const first = new BusyExecutions(async () => {}, { directory: dir, log: m => logs.push(m) });
    await first.close();
    expect(logs.filter(m => m.includes("Cannot load process record")).length).toBe(2);
    // The bad bytes are preserved for inspection, not deleted.
    expect(existsSync(join(dir, `${empty}.json.corrupt`))).toBeTruthy();
    expect(readFileSync(join(dir, `${nul}.json.corrupt`))).toEqual(Buffer.alloc(64));
    expect(existsSync(join(dir, `${good}.json`))).toBeTruthy();
    logs.length = 0;
    const second = new BusyExecutions(async () => {}, { directory: dir, log: m => logs.push(m) });
    await second.close();
    expect(logs).toEqual([]);
    expect(readdirSync(dir).filter(f => f.endsWith(".json"))).toEqual([`${good}.json`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an idle process manager arms no repeating timer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-busy-idle-"));
  const original = globalThis.setInterval;
  const intervals: number[] = [];
  globalThis.setInterval = ((fn: () => void, ms?: number) => { intervals.push(ms ?? 0); return original(fn, ms); }) as typeof setInterval;
  try {
    const busy = new BusyExecutions(async () => {}, { directory: dir });
    await busy.start();
    // Only the hourly prune may repeat; sub-second polling wakes an idle daemon four times a second.
    expect(intervals.filter(ms => ms < 60000)).toEqual([]);
    await busy.close();
  } finally { globalThis.setInterval = original; rmSync(dir, { recursive: true, force: true }); }
});
