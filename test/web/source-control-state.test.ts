import assert from "node:assert/strict";
import { test } from "bun:test";
import { formatHash, parseHash, readPrefs, mergePrefs } from "../../web/src/pages/source-control/state.ts";

test("the hash round-trips sections and items", () => {
  assert.deepEqual(parseHash("#source-control"), { section: "changes" });
  assert.deepEqual(parseHash("#source-control/history"), { section: "history" });
  assert.deepEqual(parseHash("#source-control/branches"), { section: "branches" });
  assert.deepEqual(parseHash("#source-control/pr/148"), { section: "pr", number: 148 });
  assert.deepEqual(parseHash("#source-control/issue/12"), { section: "issue", number: 12 });
  assert.deepEqual(parseHash("#source-control/pr"), { section: "pr" });
  assert.equal(formatHash({ section: "changes" }), "#source-control");
  assert.equal(formatHash({ section: "history" }), "#source-control/history");
  assert.equal(formatHash({ section: "pr", number: 148 }), "#source-control/pr/148");
  assert.equal(formatHash({ section: "issue" }), "#source-control/issue");
});

test("unknown or malformed hashes fall back to Changes", () => {
  for (const h of ["#source-control/nope", "#source-control/pr/abc", "#source-control/pr/-1", "#source-control/pr/0", "#source-control/pr/1/2", "#source-control/history/3", "#source-control/pr/99999999999", "#analytics", ""]) {
    assert.deepEqual(parseHash(h), { section: "changes" }, h);
  }
});

test("saved preferences ignore anything invalid", () => {
  assert.deepEqual(readPrefs('{"section":"pr","state":"closed"}'), { section: "pr", state: "closed" });
  assert.deepEqual(readPrefs('{"section":"x","state":"y"}'), {});
  assert.deepEqual(readPrefs("not json"), {});
  assert.deepEqual(readPrefs(null), {});
  assert.deepEqual(mergePrefs({ section: "pr" }, { state: "all" }), { section: "pr", state: "all" });
});
