import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { AssistantEntry, CompactionEntry, UserEntry } from "@earendil-works/pi-durable";
import { loadConfig, parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";
import { activeContextTokens } from "./context-usage.js";

assert.deepEqual(parseConfig({}, ".", {}).compaction, { enabled: true, triggerPercent: 75 });
for (const triggerPercent of [0, 100, 75.5, "75", null]) {
  assert.throws(() => parseConfig({ compaction: { triggerPercent } }, ".", {}));
}
assert.throws(() => parseConfig({ compaction: { enabled: "false" } }, ".", {}));
assert.throws(() => parseConfig({ compaction: { unexpected: true } }, ".", {}));
const dir = mkdtempSync(join(tmpdir(), "luna-context-"));
const file = join(dir, "config.json");
writeFileSync(file, JSON.stringify({ dataDir: dir, provider: "faux", extensions: [], compaction: { enabled: false, triggerPercent: 75 } }));
const faux = fauxProvider({ models: [{ id: "small", contextWindow: 4000 }, { id: "large", contextWindow: 8000 }] });
const models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel("small")!, model = { provider: m.provider, modelId: m.id };
const rt = await startRuntime(loadConfig(file), { models, model });
try {
  const app = createApp({ harness: rt.harness, models, settings: rt.settings, agent: { model } });
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const url = `/v1/sessions/${conv.id}`;
  const read = async () => {
    const response = await app.request(url + "/context");
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  let usage = await read();
  assert.equal(usage.contextWindow, 4000); assert.equal(usage.percent, 0);
  assert.equal(usage.estimated, true); assert.equal(usage.autoCompactionEnabled, false);
  assert.equal((await app.request("/v1/sessions/999999/context")).status, 404);
  const secured = createApp({ harness: rt.harness, models, token: "secret" });
  assert.equal((await secured.request(url + "/context")).status, 401);
  await conv.commit(async tx => {
    await tx.appendEntry(UserEntry, conv.id, { model: [{ role: "user", content: "A".repeat(800), timestamp: 1 }] });
    const message = fauxAssistantMessage([fauxText("First answer")]);
    message.usage = { input: 1000, output: 100, cacheRead: 500, cacheWrite: 100, totalTokens: 1700, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    await tx.appendEntry(AssistantEntry, conv.id, { model: [message] });
    await tx.appendEntry(UserEntry, conv.id, { model: [{ role: "user", content: "B".repeat(400), timestamp: 2 }] });
  }, context);
  usage = await read();
  assert.ok(usage.usedTokens >= 1800 && usage.usedTokens < 1900, JSON.stringify(usage));
  assert.equal(usage.percent, usage.usedTokens / 4000 * 100);
  const session = await (await app.request(url)).json() as any;
  assert.deepEqual(session.contextUsage, usage);
  await conv.configure({ model: { provider: m.provider, modelId: "large" } }, context);
  const large = await read();
  assert.equal(large.contextWindow, 8000); assert.equal(large.usedTokens, usage.usedTokens);
  assert.equal(large.percent, usage.percent / 2);
  // A new compaction head must invalidate old reported usage, even if kept entries follow it logically.
  await conv.commit(async tx => {
    await tx.appendEntry(CompactionEntry, conv.id, { head: "self", data: { reason: "manual" }, model: [{ role: "user", content: "Short summary", timestamp: 3 }] });
  }, context);
  assert.ok((await read()).usedTokens < 100, "Post-summary usage must not retain old measurements");
  assert.equal(activeContextTokens(await conv.context(context)), (await read()).usedTokens);
  let settings = await (await app.request("/v1/settings")).json() as any;
  settings.config.compaction = { enabled: true, triggerPercent: 60 };
  const saved = await app.request("/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json() as any).restartRequired, false);
  assert.deepEqual(rt.compaction(), { enabled: true, triggerPercent: 60 });
  usage = await read();
  assert.equal(usage.autoCompactionEnabled, true); assert.equal(usage.triggerPercent, 60);
  settings = await (await app.request("/v1/settings")).json();
  settings.config.compaction.triggerPercent = 100;
  assert.equal((await app.request("/v1/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) })).status, 400);
  console.log("CONTEXT_USAGE_OK: config validation, live settings, active estimate, cache tokens, model capacity, summary reset, auth");
} finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
