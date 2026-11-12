// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
// The client clamp must match the server (pi-ai clampThinkingLevel), so the picker never shows a level the session cannot store.
import { test, expect } from "bun:test";
import {
  LEVELS,
  buildSiblingIndex,
  clampTo,
  findModel,
  findSiblingGroup,
  levelsOf,
  modelDisplayName,
  parseSiblingSuffix,
  siblingLevelOf,
  siblingTarget,
  startLevel,
} from "../../web/src/lib/thinking-levels.ts";

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

const cliProxyCatalog = [
  { provider: "cli-proxy-api", id: "claude-opus-4-6-thinking", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "claude-opus-5-5-high", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "claude-opus-5-5-low", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "claude-opus-5-5-medium", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "claude-sonnet-4-6", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3-flash", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.1-flash-image", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.1-flash-lite", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.5-flash-lite", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.8-flash-high", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.8-flash-low", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.8-flash-medium", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-3.8-flash-tiered", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-xhigh", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-low", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-high", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gemini-4-hydrogen-medium", thinkingLevels: ["off"] },
  { provider: "cli-proxy-api", id: "gpt-oss-120b-medium", thinkingLevels: ["off"] },
  // Same prefix in another provider must not merge with cli-proxy-api, nor group with < 2 variants.
  { provider: "other-proxy", id: "gpt-oss-120b-high", thinkingLevels: ["off"] },
  // Native reasoning models with -<level> suffixes keep native thinking levels instead of sibling switching.
  { provider: "native", id: "reasoner-low", thinkingLevels: ["off", "low", "high"] },
  { provider: "native", id: "reasoner-high", thinkingLevels: ["off", "low", "high"] },
];

test("parseSiblingSuffix recognizes only valid trailing level suffixes", () => {
  expect(parseSiblingSuffix("gemini-4-hydrogen-xhigh")).toStrictEqual({ base: "gemini-4-hydrogen", level: "xhigh" });
  expect(parseSiblingSuffix("gpt-oss-120b-medium")).toStrictEqual({ base: "gpt-oss-120b", level: "medium" });
  expect(parseSiblingSuffix("gemini-3.8-flash-tiered")).toBe(null);
  expect(parseSiblingSuffix("claude-opus-4-6-thinking")).toBe(null);
  expect(parseSiblingSuffix("-high")).toBe(null);
  expect(parseSiblingSuffix("gemini-3-flash")).toBe(null);
});

test("buildSiblingIndex groups >= 2 non-reasoning -<level> siblings per provider in LEVELS order", () => {
  const index = buildSiblingIndex(cliProxyCatalog);

  const hRef = { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" };
  const hGroup = findSiblingGroup(index, hRef);
  expect(hGroup).toBeTruthy();
  expect(hGroup.levels).toStrictEqual(["low", "medium", "high", "xhigh"]);
  expect(levelsOf(findModel(cliProxyCatalog, hRef), hGroup)).toStrictEqual(["low", "medium", "high", "xhigh"]);
  expect(siblingLevelOf(index, hRef)).toBe("high");
  expect(siblingTarget(index, hRef, "xhigh")?.id).toBe("gemini-4-hydrogen-xhigh");
  expect(siblingTarget(index, hRef, "low")?.id).toBe("gemini-4-hydrogen-low");
  expect(siblingTarget(index, hRef, "off")).toBe(undefined);
  expect(startLevel(findModel(cliProxyCatalog, hRef), "medium", hGroup, hRef)).toBe("high");
  expect(clampTo(levelsOf(findModel(cliProxyCatalog, hRef), hGroup), "off")).toBe("low");
  expect(clampTo(levelsOf(findModel(cliProxyCatalog, hRef), hGroup), "max")).toBe("xhigh");

  // gemini-3.8-flash-tiered is excluded from the gemini-3.8-flash group.
  const fRef = { provider: "cli-proxy-api", modelId: "gemini-3.8-flash-medium" };
  const fGroup = findSiblingGroup(index, fRef);
  expect(fGroup?.levels).toStrictEqual(["low", "medium", "high"]);
  const tieredRef = { provider: "cli-proxy-api", modelId: "gemini-3.8-flash-tiered" };
  expect(findSiblingGroup(index, tieredRef)).toBe(undefined);
  expect(levelsOf(findModel(cliProxyCatalog, tieredRef), findSiblingGroup(index, tieredRef))).toStrictEqual(["off"]);

  // Standalone -<level> models with < 2 variants in the same provider are not grouped.
  const ossRef = { provider: "cli-proxy-api", modelId: "gpt-oss-120b-medium" };
  expect(findSiblingGroup(index, ossRef)).toBe(undefined);
  expect(siblingLevelOf(index, ossRef)).toBe(undefined);
  expect(levelsOf(findModel(cliProxyCatalog, ossRef))).toStrictEqual(["off"]);
  expect(findSiblingGroup(index, { provider: "other-proxy", modelId: "gpt-oss-120b-high" })).toBe(undefined);

  // Non-sibling models remain unaffected.
  expect(findSiblingGroup(index, { provider: "cli-proxy-api", modelId: "claude-opus-4-6-thinking" })).toBe(undefined);
  expect(findSiblingGroup(index, { provider: "cli-proxy-api", modelId: "gemini-3.1-flash-lite" })).toBe(undefined);

  // Native multi-level reasoning models are not grouped into sibling switching.
  expect(findSiblingGroup(index, { provider: "native", modelId: "reasoner-low" })).toBe(undefined);
});
