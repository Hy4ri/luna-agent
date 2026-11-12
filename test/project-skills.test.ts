import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { ProjectSkills } from "../src/project-skills.js";

// Contract: a project in "only chosen" mode keeps its active set at the switch, and a skill added later stays off there.
// Regression it catches: disabled() falling back to the global list, which turns every new skill on in every project.
test("only-chosen mode keeps the active set and keeps new skills off", () => {
  const store = new ProjectSkills(new Database(":memory:"));
  const global = ["c"]; // a, b on globally; c off
  store.set(1, "b", false);
  store.set(1, "c", true);
  expect(store.disabled(1, global, () => ["a", "b", "c"]).sort()).toEqual(["b"]);

  store.setOnlyChosen(1, true, ["a", "c"]);
  expect(store.onlyChosen(1)).toBe(true);
  expect(store.disabled(1, global, () => ["a", "b", "c", "new"]).sort()).toEqual(["b", "new"]);
  store.set(1, "a", false); // off means not chosen
  expect(store.overrides(1).has("a")).toBe(false);
  expect(store.disabled(2, global, () => ["a", "b", "c", "new"])).toEqual(["c"]); // other projects unchanged

  store.setOnlyChosen(1, false);
  expect(store.disabled(1, global, () => ["a", "b", "c", "new"])).toEqual([]);
  store.clear(1);
  expect(store.onlyChosen(1)).toBe(false);
});
