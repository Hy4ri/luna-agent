import { test, expect } from "bun:test";
import { formatHash, parseHash, readPrefs, mergePrefs } from "../../web/src/pages/source-control/state.ts";

test("the hash round-trips sections and items", () => {
  expect(parseHash("#source-control")).toEqual({ section: "changes" });
  expect(parseHash("#source-control/history")).toEqual({ section: "history" });
  expect(parseHash("#source-control/branches")).toEqual({ section: "branches" });
  expect(parseHash("#source-control/pr/148")).toEqual({ section: "pr", number: 148 });
  expect(parseHash("#source-control/issue/12")).toEqual({ section: "issue", number: 12 });
  expect(parseHash("#source-control/pr")).toEqual({ section: "pr" });
  expect(formatHash({ section: "changes" })).toBe("#source-control");
  expect(formatHash({ section: "history" })).toBe("#source-control/history");
  expect(formatHash({ section: "pr", number: 148 })).toBe("#source-control/pr/148");
  expect(formatHash({ section: "issue" })).toBe("#source-control/issue");
});

test("unknown or malformed hashes fall back to Changes", () => {
  for (const h of ["#source-control/nope", "#source-control/pr/abc", "#source-control/pr/-1", "#source-control/pr/0", "#source-control/pr/1/2", "#source-control/history/3", "#source-control/pr/99999999999", "#analytics", ""]) {
    expect(parseHash(h)).toEqual({ section: "changes" }) /* h */;
  }
});

test("saved preferences ignore anything invalid", () => {
  expect(readPrefs('{"section":"pr","state":"closed"}')).toEqual({ section: "pr", state: "closed" });
  expect(readPrefs('{"section":"x","state":"y"}')).toEqual({});
  expect(readPrefs("not json")).toEqual({});
  expect(readPrefs(null)).toEqual({});
  expect(mergePrefs({ section: "pr" }, { state: "all" })).toEqual({ section: "pr", state: "all" });
});
