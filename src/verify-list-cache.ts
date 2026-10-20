// The session list and analytics cache storage-derived rows per conversation. Every commit must invalidate the
// rows it touched, metadata must stay live, and the cached output must equal an uncached rebuild.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";

const dir = mkdtempSync(join(process.cwd(), ".list-cache-test-"));
try {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  faux.setResponses([() => fauxAssistantMessage([fauxText("reply")])]);
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel("main")!;
  const rt = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
  try {
    const opts = { harness: rt.harness, models: rt.models, conversations: rt.conversations, agent: { model: { provider: m.provider, modelId: m.id } } };
    const app = createApp(opts);
    const get = async (a: typeof app, path: string) => { const r = await a.request(path); assert.equal(r.status, 200, path); return r.json() as Promise<any>; };
    const list = async (a = app) => (await get(a, "/v1/sessions")).sessions as any[];
    const created = async () => (await (await app.request("/v1/sessions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json() as any).id;
    const say = (id: number, text: string, at: number) => rt.harness.commit(async tx => {
      await tx.appendEntry(UserEntry, id as never, { model: [{ role: "user", content: text, timestamp: at }] });
      await tx.appendEntry(AssistantEntry, id as never, { model: [{ ...fauxAssistantMessage([fauxText("ok")]), provider: m.provider, model: m.id, timestamp: at + 1 }] as never });
    }, context);

    const a = await created(), b = await created();
    assert.deepEqual((await list()).map(s => s.title), ["", ""]);
    await say(a, "first question", 1000);
    // The touched row is rebuilt: title and activity change, and it sorts first.
    let rows = await list();
    assert.equal(rows.find(s => s.id === a).title, "first question");
    assert.equal(rows.find(s => s.id === a).lastActivity, 1001);
    await say(b, "second question", 2000);
    rows = await list();
    assert.deepEqual(rows.map(s => s.id), [b, a], "newest activity sorts first after a commit");
    // Metadata changes outside commits stay live.
    await rt.conversations!.update(a, { pinned: true, title: "renamed" });
    rows = await list();
    assert.deepEqual(rows.map(s => [s.id, s.title, s.pinned]), [[a, "renamed", true], [b, "second question", false]]);
    // Deletion drops the row.
    await rt.conversations!.delete(b);
    assert.deepEqual((await list()).map(s => s.id), [a]);
    // Concurrent requests share one pass and agree.
    const [x, y] = await Promise.all([list(), list()]);
    assert.deepEqual(x, y);
    // Cached output equals a fresh app with an empty cache.
    assert.deepEqual(await list(), await list(createApp(opts)));

    // Analytics: a new response appears after the first (cached) read.
    const before = await get(app, "/v1/analytics");
    await say(a, "third", 3000);
    const after = await get(app, "/v1/analytics");
    const responses = (d: any) => d.models.reduce((n: number, r: any) => n + r.responses, 0);
    assert.equal(responses(after), responses(before) + 1, "analytics cache invalidated by the commit");
    const fresh = await get(createApp(opts), "/v1/analytics");
    delete after.generatedAt; delete fresh.generatedAt;
    assert.deepEqual(after, fresh, "cached analytics equal an uncached rebuild");
    console.log("LIST_CACHE_OK: per-conversation invalidation, live metadata, deletion, shared passes, analytics, cached == uncached");
  } finally { await rt.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
