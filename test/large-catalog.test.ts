// Contract (#531): catalogs with thousands of models stay indexed. Lookups do not rebuild the merged
// catalog, repeated reads reuse it, and a refresh replaces it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { ProviderManager } from "../src/providers.js";
import { catalogCompaction } from "../src/compaction-limits.js";

const N = 5000;
const listing = (ids: string[]) => ({ data: ids.map(id => ({ id, context_length: 128_000 })) });

test("a large custom provider catalog is indexed, reused, and replaced on refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-large-catalog-"));
  let ids = Array.from({ length: N }, (_, i) => `vendor${i % 50}/model-${i}`);
  const fetchImpl = (async () => new Response(JSON.stringify(listing(ids)), { status: 200 })) as unknown as typeof fetch;
  const pm = new ProviderManager({ dataDir: dir, models: createModels(), fallbackModel: { provider: "big", modelId: ids[0]! }, fetch: fetchImpl });
  try {
    await pm.addCustom({ id: "big", name: "Big", baseUrl: "https://example.test/v1", key: "k" });
    await pm.refreshCatalog();
    const first = pm.models.getModels("big");
    assert.equal(first.length, N);
    assert.equal(pm.models.getModels("big"), first, "repeated reads reuse the merged catalog");

    // The pre-#531 lookup rebuilt the merged catalog per call (~1 s each at 10k). Indexed, many lookups are cheap.
    const last = ids.at(-1)!;
    const started = performance.now();
    for (let i = 0; i < 2000; i++) assert.equal(pm.models.getModel("big", last)?.id, last);
    assert.ok(performance.now() - started < 1000, "2000 indexed lookups finish well under a second");
    assert.equal(pm.models.getModel("big", "missing/model"), undefined);

    const compaction = catalogCompaction(pm.models);
    const limits = { backgroundAtTokens: 60_000, blockAtTokens: 90_000, keepRecentTokens: 20_000 };
    const table = compaction(limits);
    assert.ok(table.modelOverrides?.[`big/${last}`], "the session table covers the catalog");
    assert.equal(compaction({ ...limits }), table, "unchanged limits and catalog reuse the table");
    assert.notEqual(compaction({ ...limits, keepRecentTokens: 10_000 }), table, "changed limits rebuild the table");
    const rebuilt = compaction(limits);

    ids = [...ids.slice(1), "vendor0/new-model"];
    await pm.refreshCatalog();
    const next = pm.models.getModels("big");
    assert.notEqual(next, first, "a refresh publishes a new catalog");
    // Saved definitions from addCustom stay in the catalog; the live listing adds the new model.
    assert.equal(next.length, N + 1);
    assert.equal(pm.models.getModel("big", "vendor0/new-model")?.id, "vendor0/new-model", "the index follows the refresh");
    const afterRefresh = compaction(limits);
    assert.notEqual(afterRefresh, rebuilt, "a refresh rebuilds the session table");
    assert.ok(afterRefresh.modelOverrides?.["big/vendor0/new-model"]);
  } finally {
    pm.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
