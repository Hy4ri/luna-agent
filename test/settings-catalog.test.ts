// Contract: every top-level config key has exactly one settings catalog entry. The Settings page
// refuses to render when one is unmapped, so adding a config field without a catalog entry broke it.
import { test, expect } from "bun:test";
import { ConfigSchema } from "../src/config.js";
import { assertCatalogCoverage } from "../web/src/pages/settings/catalog.js";

test("settings catalog maps every top-level config key exactly once", () => {
  const schema = ConfigSchema.toJSONSchema() as { properties?: Record<string, unknown> };
  expect(() => assertCatalogCoverage(schema)).not.toThrow();
});
