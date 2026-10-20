import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "./providers.js";

const dir = mkdtempSync(join(tmpdir(), "luna-model-refresh-"));
let ids = ["saved"];
let calls = 0;
let fail = false;
let release: (() => void) | undefined;
let blocked: Promise<void> | undefined;
const manager = new ProviderManager({ dataDir: dir, fallbackModel: { provider: "local", modelId: "saved" }, fetch: async () => {
  calls++;
  if (blocked) await blocked;
  if (fail) return new Response("", { status: 503 });
  return Response.json({ data: ids.map(id => ({ id, context_length: 96000 })) });
} });
for (const provider of manager.models.getProviders()) manager.models.deleteProvider(provider.id);
const waitFor = async (test: () => boolean) => {
  const end = Date.now() + 2000;
  while (!test() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  assert.ok(test(), "condition timed out");
};
try {
  await manager.addCustom({ id: "local", baseUrl: "http://local.test/v1", models: [{ id: "saved", contextWindow: 32000 }] });
  ids.push("new");
  blocked = new Promise<void>(resolve => { release = resolve; });
  const first = manager.refreshCatalog();
  const second = manager.refreshCatalog();
  assert.equal(first, second, "concurrent requests share one refresh");
  await waitFor(() => calls === 1);
  assert.equal(manager.catalogStatus().refreshing, true);
  release!();
  await first;
  blocked = undefined;
  assert.equal(calls, 1);
  assert.equal(manager.models.getModel("local", "new")?.contextWindow, 96000);
  assert.equal(manager.models.getModel("local", "saved")?.contextWindow, 32000);
  assert.ok(manager.catalogStatus().checkedAt);
  fail = true;
  await manager.refreshCatalog();
  assert.match(manager.catalogStatus().errors.local!, /503/);
  assert.ok(manager.models.getModel("local", "new"));
  fail = false;
  ids.push("automatic");
  manager.startAutoRefresh(20);
  await waitFor(() => !!manager.models.getModel("local", "automatic") && !manager.catalogStatus().refreshing);
  assert.deepEqual(manager.catalogStatus().errors, {});
  manager.close();
  await waitFor(() => !manager.catalogStatus().refreshing);
  const stoppedCalls = calls;
  await new Promise(r => setTimeout(r, 80));
  assert.equal(calls, stoppedCalls, "close stops automatic refresh");
  console.log("MODEL_REFRESH_OK: discovery, saved overrides, coalescing, failure retention, automatic recovery, timer cleanup");
} finally {
  release?.();
  manager.close();
  rmSync(dir, { recursive: true, force: true });
}
