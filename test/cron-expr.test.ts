// Contract: a cron expression parses or fails loudly, and nextRun returns the first matching minute strictly after `after`.
// A wrong answer here silently skips or repeats scheduled jobs.
import assert from "node:assert/strict";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { nextRun, parseCron } from "../src/cron-expr.js";

// Schedules use local time. Pin a zone without DST so the expected values are fixed.
const savedTz = process.env.TZ;
before(() => { process.env.TZ = "UTC"; });
after(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

const next = (expr: string, iso: string) => new Date(nextRun(expr, Date.parse(iso))).toISOString();

test("fields: lists, ranges, steps, names, and day-of-week 7 as Sunday", () => {
  const s = parseCron("0,30 9-17/4 * jan-mar,dec mon-fri");
  assert.deepEqual([...s.min], [0, 30]);
  assert.deepEqual([...s.hour], [9, 13, 17]);
  assert.deepEqual([...s.mon], [1, 2, 3, 12]);
  assert.deepEqual([...s.dow], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").dow], [0]);
  // A single value with a step runs to the end of the range.
  assert.deepEqual([...parseCron("5/20 * * * *").min], [5, 25, 45]);
});

test("aliases expand to their five-field form", () => {
  assert.deepEqual(parseCron("@daily"), parseCron("0 0 * * *"));
  assert.deepEqual(parseCron("@weekly"), parseCron("0 0 * * 0"));
  assert.deepEqual(parseCron(" @HOURLY "), parseCron("0 * * * *"));
});

test("invalid expressions are rejected", () => {
  for (const expr of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8",
    "*/0 * * * *", "5-1 * * * *", "1.5 * * * *", "-1 * * * *", "foo * * * *", ""]) {
    assert.throws(() => parseCron(expr), Error, expr);
  }
});

test("nextRun is strictly after the given time and drops seconds", () => {
  assert.equal(next("* * * * *", "2026-11-01T10:00:00.000Z"), "2026-11-01T10:01:00.000Z");
  assert.equal(next("* * * * *", "2026-11-01T10:00:59.999Z"), "2026-11-01T10:01:00.000Z");
  assert.equal(next("0 * * * *", "2026-11-01T10:00:00.000Z"), "2026-11-01T11:00:00.000Z");
});

test("nextRun carries across day, month, and year boundaries", () => {
  assert.equal(next("15 3 * * *", "2026-11-01T04:00:00Z"), "2026-11-02T03:15:00.000Z");
  assert.equal(next("0 0 1 * *", "2026-11-15T00:00:00Z"), "2026-12-01T00:00:00.000Z");
  assert.equal(next("@yearly", "2026-12-31T23:59:00Z"), "2027-01-01T00:00:00.000Z");
  assert.equal(next("0 0 29 2 *", "2026-03-01T00:00:00Z"), "2028-02-29T00:00:00.000Z");
  assert.equal(next("0 0 31 * *", "2026-11-01T00:00:00Z"), "2026-12-31T00:00:00.000Z");
});

test("day-of-month and day-of-week: either restricted field matches when both are set", () => {
  // 2026-11-01 is a Sunday. "1st of the month OR Monday".
  assert.equal(next("0 9 1 * mon", "2026-11-01T00:00:00Z"), "2026-11-01T09:00:00.000Z");
  assert.equal(next("0 9 1 * mon", "2026-11-01T10:00:00Z"), "2026-11-02T09:00:00.000Z");
  // Only day-of-week restricted: day-of-month star does not widen it.
  assert.equal(next("0 9 * * mon", "2026-11-01T00:00:00Z"), "2026-11-02T09:00:00.000Z");
  // Only day-of-month restricted.
  assert.equal(next("0 9 15 * *", "2026-11-01T00:00:00Z"), "2026-11-15T09:00:00.000Z");
});

test("schedules use the process local zone", () => {
  process.env.TZ = "Asia/Amman"; // UTC+3, no DST.
  try {
    assert.equal(next("0 9 * * *", "2026-11-01T00:00:00Z"), "2026-11-01T06:00:00.000Z");
  } finally { process.env.TZ = "UTC"; }
});

// Known DST bugs (Europe/Berlin). m57 runs in Asia/Amman, which has no DST, so these do not fire there today.
test.todo("DST spring forward: a job in the skipped hour still runs that day", () => {
  process.env.TZ = "Europe/Berlin"; // 2026-03-29 02:00 CET -> 03:00 CEST; 02:30 does not exist.
  try {
    assert.equal(new Date(nextRun("30 2 * * *", Date.parse("2026-03-29T00:00:00Z"))).toISOString().slice(0, 10), "2026-03-29");
  } finally { process.env.TZ = "UTC"; }
});

test.todo("DST fall back: */15 does not skip the repeated hour", () => {
  process.env.TZ = "Europe/Berlin"; // 2026-10-25 03:00 CEST -> 02:00 CET.
  try {
    assert.equal(new Date(nextRun("*/15 * * * *", Date.parse("2026-10-25T00:45:00Z"))).toISOString(), "2026-10-25T01:00:00.000Z");
  } finally { process.env.TZ = "UTC"; }
});

test("an expression that can never fire fails instead of looping", () => {
  assert.throws(() => nextRun("0 0 31 2 *", Date.parse("2026-01-01T00:00:00Z")), /never fires/);
});
