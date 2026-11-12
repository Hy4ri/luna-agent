// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
// The client clamp must match the server (pi-ai clampThinkingLevel), so the picker never shows a level the session cannot store.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { LEVELS, clampTo, findModel, levelsOf, modelDisplayName, startLevel } from "../../web/src/lib/thinking-levels.ts";

const list = [
  { provider: "p", id: "limited", thinkingLevels: ["off", "low", "high"], defaultThinkingLevel: "high" },
  { provider: "p", id: "plain", thinkingLevels: ["off"] },
];
const limited = levelsOf(findModel(list, { provider: "p", modelId: "limited" }));

test("levelsOf keeps LEVELS order and shows every standard level for an unknown model; ultra needs a listing", () => {
  const standard = LEVELS.filter(level => level !== "ultra");
  assert.deepEqual(limited, ["off", "low", "high"]);
  assert.deepEqual(levelsOf(findModel(list, { provider: "p", modelId: "unknown" })), standard);
  assert.deepEqual(levelsOf(findModel(list, null)), standard);
  assert.deepEqual(levelsOf({ provider: "p", id: "u", thinkingLevels: ["high", "max", "ultra"] }), ["high", "max", "ultra"]);
  assert.equal(clampTo(["off", "high", "max"], "ultra"), "max");
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

test("modelDisplayName hides provider and shows only the model name", () => {
  assert.equal(
    modelDisplayName({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }, { provider: "anthropic", modelId: "claude-sonnet-4-5" }),
    "Claude Sonnet 4.5",
  );
  assert.equal(
    modelDisplayName({ provider: "cli-proxy-api", id: "gemini-4-hydrogen-high" }, { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" }),
    "gemini-4-hydrogen-high",
  );
  assert.equal(
    modelDisplayName(undefined, { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" }),
    "gemini-4-hydrogen-high",
  );
  assert.equal(modelDisplayName(undefined, null), "Choose model");
});
