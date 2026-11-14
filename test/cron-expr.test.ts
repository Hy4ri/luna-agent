// Contract: a cron expression parses or fails loudly, and nextRun returns the first matching minute strictly after `after`.
// A wrong answer here silently skips or repeats scheduled jobs.
import { afterAll as after, beforeAll as before, test, expect } from "bun:test";
import { nextRun, parseCron } from "../src/cron-expr.js";

// Schedules use local time. Pin a zone without DST so the expected values are fixed.
const savedTz = process.env.TZ;
before(() => { process.env.TZ = "UTC"; });
after(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

const next = (expr: string, iso: string) => new Date(nextRun(expr, Date.parse(iso))).toISOString();

test("fields: lists, ranges, steps, names, and day-of-week 7 as Sunday", () => {
  const s = parseCron("0,30 9-17/4 * jan-mar,dec mon-fri");
  expect([...s.min]).toEqual([0, 30]);
  expect([...s.hour]).toEqual([9, 13, 17]);
  expect([...s.mon]).toEqual([1, 2, 3, 12]);
  expect([...s.dow]).toEqual([1, 2, 3, 4, 5]);
  expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
  // A single value with a step runs to the end of the range.
  expect([...parseCron("5/20 * * * *").min]).toEqual([5, 25, 45]);
});

test("aliases expand to their five-field form", () => {
  expect(parseCron("@daily")).toEqual(parseCron("0 0 * * *"));
  expect(parseCron("@weekly")).toEqual(parseCron("0 0 * * 0"));
  expect(parseCron(" @HOURLY ")).toEqual(parseCron("0 * * * *"));
});

test("invalid expressions are rejected", () => {
  for (const expr of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8",
    "*/0 * * * *", "5-1 * * * *", "1.5 * * * *", "-1 * * * *", "foo * * * *", ""]) {
    expect(() => parseCron(expr)).toThrow(Error) /* expr */;
  }
});

test("nextRun is strictly after the given time and drops seconds", () => {
  expect(next("* * * * *", "2026-11-01T10:00:00.000Z")).toBe("2026-11-01T10:01:00.000Z");
  expect(next("* * * * *", "2026-11-01T10:00:59.999Z")).toBe("2026-11-01T10:01:00.000Z");
  expect(next("0 * * * *", "2026-11-01T10:00:00.000Z")).toBe("2026-11-01T11:00:00.000Z");
});

test("nextRun carries across day, month, and year boundaries", () => {
  expect(next("15 3 * * *", "2026-11-01T04:00:00Z")).toBe("2026-11-02T03:15:00.000Z");
  expect(next("0 0 1 * *", "2026-11-15T00:00:00Z")).toBe("2026-12-01T00:00:00.000Z");
  expect(next("@yearly", "2026-12-31T23:59:00Z")).toBe("2027-01-01T00:00:00.000Z");
  expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
  expect(next("0 0 31 * *", "2026-11-01T00:00:00Z")).toBe("2026-12-31T00:00:00.000Z");
});

test("day-of-month and day-of-week: either restricted field matches when both are set", () => {
  // 2026-11-01 is a Sunday. "1st of the month OR Monday".
  expect(next("0 9 1 * mon", "2026-11-01T00:00:00Z")).toBe("2026-11-01T09:00:00.000Z");
  expect(next("0 9 1 * mon", "2026-11-01T10:00:00Z")).toBe("2026-11-02T09:00:00.000Z");
  // Only day-of-week restricted: day-of-month star does not widen it.
  expect(next("0 9 * * mon", "2026-11-01T00:00:00Z")).toBe("2026-11-02T09:00:00.000Z");
  // Only day-of-month restricted.
  expect(next("0 9 15 * *", "2026-11-01T00:00:00Z")).toBe("2026-11-15T09:00:00.000Z");
});

test("schedules use the process local zone", () => {
  process.env.TZ = "Asia/Amman"; // UTC+3, no DST.
  try {
    expect(next("0 9 * * *", "2026-11-01T00:00:00Z")).toBe("2026-11-01T06:00:00.000Z");
  } finally { process.env.TZ = "UTC"; }
});

// Missing wall-clock times run at the gap boundary; repeated times remain eligible.
test("DST spring forward: a job in the skipped hour still runs that day", () => {
  process.env.TZ = "Europe/Berlin"; // 2026-03-29 02:00 CET -> 03:00 CEST; 02:30 does not exist.
  try {
    expect(next("30 2 * * *", "2026-03-29T00:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
  } finally { process.env.TZ = "UTC"; }
});

test("DST fall back: */15 does not skip the repeated hour", () => {
  process.env.TZ = "Europe/Berlin"; // 2026-10-25 03:00 CEST -> 02:00 CET.
  try {
    expect(new Date(nextRun("*/15 * * * *", Date.parse("2026-10-25T00:45:00Z"))).toISOString()).toBe("2026-10-25T01:00:00.000Z");
  } finally { process.env.TZ = "UTC"; }
});

test("DST boundaries preserve strict ordering and calendar restrictions", () => {
  process.env.TZ = "Europe/Berlin";
  try {
    for (const [expr, after, expected] of [
      ["*/15 * * * *", "2026-10-25T00:59:59.999Z", "2026-10-25T01:00:00.000Z"],
      ["*/15 * * * *", "2026-10-25T01:00:00Z", "2026-10-25T01:15:00.000Z"],
      ["30 2 * * *", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00.000Z"],
      ["30 2 * * *", "2026-10-25T01:30:00Z", "2026-10-26T01:30:00.000Z"],
      ["30 2 * * *", "2026-03-29T00:59:59.999Z", "2026-03-29T01:00:00.000Z"],
      ["30 2 * * *", "2026-03-29T01:00:00Z", "2026-03-30T00:30:00.000Z"],
      ["30 3 * * *", "2026-03-29T00:00:00Z", "2026-03-29T01:30:00.000Z"],
      ["30 2 * * mon", "2026-03-29T00:00:00Z", "2026-03-30T00:30:00.000Z"],
      ["30 2 29 3 *", "2026-03-29T00:00:00Z", "2026-03-29T01:00:00.000Z"],
    ]) expect(next(expr!, after!)).toBe(expected!);
  } finally { process.env.TZ = "UTC"; }
});

test("DST changes need not be a whole hour", () => {
  process.env.TZ = "Australia/Lord_Howe";
  try {
    // 02:00 -> 02:30 in October, 02:00 -> 01:30 in April.
    expect(next("15 2 * * *", "2026-10-03T15:00:00Z")).toBe("2026-10-03T15:30:00.000Z");
    expect(next("45 1 * * *", "2026-04-04T14:45:00Z")).toBe("2026-04-04T15:15:00.000Z");
  } finally { process.env.TZ = "UTC"; }
});

test("an expression that can never fire fails instead of looping", () => {
  expect(() => nextRun("0 0 31 2 *", Date.parse("2026-01-01T00:00:00Z"))).toThrow(/never fires/);
});
