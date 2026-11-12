// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
// The client clamp must match the server (pi-ai clampThinkingLevel), so the picker never shows a level the session cannot store.
import assert from "node:assert/strict";
import { test } from "bun:test";
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
  assert.deepEqual(parseSiblingSuffix("gemini-4-hydrogen-xhigh"), { base: "gemini-4-hydrogen", level: "xhigh" });
  assert.deepEqual(parseSiblingSuffix("gpt-oss-120b-medium"), { base: "gpt-oss-120b", level: "medium" });
  assert.equal(parseSiblingSuffix("gemini-3.8-flash-tiered"), null);
  assert.equal(parseSiblingSuffix("claude-opus-4-6-thinking"), null);
  assert.equal(parseSiblingSuffix("-high"), null);
  assert.equal(parseSiblingSuffix("gemini-3-flash"), null);
});

test("buildSiblingIndex groups >= 2 non-reasoning -<level> siblings per provider in LEVELS order", () => {
  const index = buildSiblingIndex(cliProxyCatalog);

  const hRef = { provider: "cli-proxy-api", modelId: "gemini-4-hydrogen-high" };
  const hGroup = findSiblingGroup(index, hRef);
  assert.ok(hGroup);
  assert.deepEqual(hGroup.levels, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(levelsOf(findModel(cliProxyCatalog, hRef), hGroup), ["low", "medium", "high", "xhigh"]);
  assert.equal(siblingLevelOf(index, hRef), "high");
  assert.equal(siblingTarget(index, hRef, "xhigh")?.id, "gemini-4-hydrogen-xhigh");
  assert.equal(siblingTarget(index, hRef, "low")?.id, "gemini-4-hydrogen-low");
  assert.equal(siblingTarget(index, hRef, "off"), undefined);
  assert.equal(startLevel(findModel(cliProxyCatalog, hRef), "medium", hGroup, hRef), "high");
  assert.equal(clampTo(levelsOf(findModel(cliProxyCatalog, hRef), hGroup), "off"), "low");
  assert.equal(clampTo(levelsOf(findModel(cliProxyCatalog, hRef), hGroup), "max"), "xhigh");

  // gemini-3.8-flash-tiered is excluded from the gemini-3.8-flash group.
  const fRef = { provider: "cli-proxy-api", modelId: "gemini-3.8-flash-medium" };
  const fGroup = findSiblingGroup(index, fRef);
  assert.deepEqual(fGroup?.levels, ["low", "medium", "high"]);
  const tieredRef = { provider: "cli-proxy-api", modelId: "gemini-3.8-flash-tiered" };
  assert.equal(findSiblingGroup(index, tieredRef), undefined);
  assert.deepEqual(levelsOf(findModel(cliProxyCatalog, tieredRef), findSiblingGroup(index, tieredRef)), ["off"]);

  // Standalone -<level> models with < 2 variants in the same provider are not grouped.
  const ossRef = { provider: "cli-proxy-api", modelId: "gpt-oss-120b-medium" };
  assert.equal(findSiblingGroup(index, ossRef), undefined);
  assert.equal(siblingLevelOf(index, ossRef), undefined);
  assert.deepEqual(levelsOf(findModel(cliProxyCatalog, ossRef)), ["off"]);
  assert.equal(findSiblingGroup(index, { provider: "other-proxy", modelId: "gpt-oss-120b-high" }), undefined);

  // Non-sibling models remain unaffected.
  assert.equal(findSiblingGroup(index, { provider: "cli-proxy-api", modelId: "claude-opus-4-6-thinking" }), undefined);
  assert.equal(findSiblingGroup(index, { provider: "cli-proxy-api", modelId: "gemini-3.1-flash-lite" }), undefined);

  // Native multi-level reasoning models are not grouped into sibling switching.
  assert.equal(findSiblingGroup(index, { provider: "native", modelId: "reasoner-low" }), undefined);
});
