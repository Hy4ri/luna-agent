// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
// The client clamp must match the server (pi-ai clampThinkingLevel), so the picker never shows a level the session cannot store.
import { test, expect } from "bun:test";
import { LEVELS, clampTo, findModel, levelsOf, modelDisplayName, startLevel } from "../../web/src/lib/thinking-levels.ts";

const list = [
  { provider: "p", id: "limited", thinkingLevels: ["off", "low", "high"], defaultThinkingLevel: "high" },
  { provider: "p", id: "plain", thinkingLevels: ["off"] },
];
const limited = levelsOf(findModel(list, { provider: "p", modelId: "limited" }));

test("levelsOf keeps LEVELS order and shows every standard level for an unknown model; ultra needs a listing", () => {
  const standard = LEVELS.filter(level => level !== "ultra");
  expect(limited).toEqual(["off", "low", "high"]);
  expect(levelsOf(findModel(list, { provider: "p", modelId: "unknown" }))).toEqual(standard);
  expect(levelsOf(findModel(list, null))).toEqual(standard);
  expect(levelsOf({ provider: "p", id: "u", thinkingLevels: ["high", "max", "ultra"] })).toEqual(["high", "max", "ultra"]);
  expect(clampTo(["off", "high", "max"], "ultra")).toBe("max");
});

test("clampTo picks the nearest supported level above, then below", () => {
  expect(clampTo(limited, "minimal")).toBe("low");
  expect(clampTo(limited, "medium")).toBe("high");
  expect(clampTo(limited, "max")).toBe("high");
  expect(clampTo(["off"], "high")).toBe("off");
});

test("startLevel uses the model default, then the global default, clamped", () => {
  expect(startLevel(list[0], "medium")).toBe("high");
  expect(startLevel(list[1], "medium")).toBe("off");
  expect(startLevel(undefined, "medium")).toBe("medium");
});

test("modelDisplayName hides provider and shows only the model name", () => {
  expect(modelDisplayName({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }, { provider: "anthropic", modelId: "claude-sonnet-4-5" })).toBe("Claude Sonnet 4.5");
  expect(modelDisplayName({ provider: "cli-proxy-api", id: "gemini-4-hydrogen-high" }, { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" })).toBe("gemini-4-hydrogen-high");
  expect(modelDisplayName(undefined, { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" })).toBe("gemini-4-hydrogen-high");
  expect(modelDisplayName(undefined, null)).toBe("Choose model");
});
