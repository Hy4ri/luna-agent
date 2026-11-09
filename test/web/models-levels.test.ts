// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
// The client clamp must match the server (pi-ai clampThinkingLevel), so the picker never shows a level the session cannot store.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { LEVELS, clampTo, findModel, levelsOf, startLevel } from "../../web/src/lib/thinking-levels.ts";

const list = [
  { provider: "p", id: "limited", thinkingLevels: ["off", "low", "high"], defaultThinkingLevel: "high" },
  { provider: "p", id: "plain", thinkingLevels: ["off"] },
];
const limited = levelsOf(findModel(list, { provider: "p", modelId: "limited" }));

test("levelsOf keeps LEVELS order and shows every level for an unknown model", () => {
  assert.deepEqual(limited, ["off", "low", "high"]);
  assert.deepEqual(levelsOf(findModel(list, { provider: "p", modelId: "unknown" })), [...LEVELS]);
  assert.deepEqual(levelsOf(findModel(list, null)), [...LEVELS]);
});

test("clampTo picks the nearest supported level above, then below", () => {
  assert.equal(clampTo(limited, "minimal"), "low");
  assert.equal(clampTo(limited, "medium"), "high");
  assert.equal(clampTo(limited, "max"), "high");
  assert.equal(clampTo(["off"], "high"), "off");
});

test("startLevel uses the model default, then the global default, clamped", () => {
  assert.equal(startLevel(list[0], "medium"), "high");
  assert.equal(startLevel(list[1], "medium"), "off");
  assert.equal(startLevel(undefined, "medium"), "medium");
});
