import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry, UsageDoc } from "@earendil-works/pi-durable";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";

export async function runVerifyAnalytics() {
  const dir = mkdtempSync(join(process.cwd(), ".analytics-test-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));

    const faux = fauxProvider({ models: [{ id: "main" }, { id: "advanced", cost: { input: 2.5, output: 10, cacheRead: 0.5, cacheWrite: 2 } }] });
    faux.setResponses([() => fauxAssistantMessage([fauxText("analytics test reply")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const m = faux.getModel("main")!;

    const rt = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
    try {
      const app = createApp({
        harness: rt.harness,
        models: rt.models,
        providers: rt.providers,
        settings: rt.settings,
        conversations: rt.conversations,
        agent: { model: { provider: m.provider, modelId: m.id } },
        token: "analytics-secret"
      });

      const headers = { authorization: "Bearer analytics-secret", "content-type": "application/json" };

      // 1. Auth check
      const unauth = await app.request("/v1/analytics");
      assert.equal(unauth.status, 401);

      const initial = await (await app.request("/v1/analytics", { headers })).json() as any;
      assert.equal(initial.sessions, 0); assert.deepEqual(initial.models, []); assert.deepEqual(initial.tools, []);
      assert.equal(initial.totals.totalTokens, 0); assert.equal(initial.totals.cacheHitRate, null);
      assert.equal(initial.totals.reasoning, null); assert.equal(initial.totals.cacheWrite1h, null);

      // 2. Create >100 conversations / >200 entries and populate exact aggregates, ledger-only usage, tool separation, models, rates
      const convsCount = 105;
      for (let i = 0; i < convsCount; i++) {
        const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: m.provider, modelId: m.id } } }, context);
        await conv.commit(async tx => {
          const usageState = await tx.doc(UsageDoc, conv.id);
          usageState.models["faux/main"] = {
            input: 1000,
            output: 200,
            cacheRead: 500,
            cacheWrite: 100,
            totalTokens: 1800,
            cost: { input: 0.002, output: 0.001, cacheRead: 0.0005, cacheWrite: 0.0001, total: 0.0036 }
          };
          usageState.tools["search"] = {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          };

          const assistantMsg = fauxAssistantMessage([
            fauxToolCall("search", { query: `test-${i}` }),
            fauxText("Done searching")
          ]);
          assistantMsg.provider = m.provider;
          assistantMsg.model = m.id;
          assistantMsg.timestamp = Date.UTC(2026, 9, 18) - (i * 1000);
          assistantMsg.usage = {
            input: 400,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 500,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          };
          await tx.appendEntry(UserEntry, conv.id, { model: [{ role: "user", content: `Hello ${i}`, timestamp: assistantMsg.timestamp - 1000 }] });
          await tx.appendEntry(AssistantEntry, conv.id, { model: [assistantMsg] });
        }, context);
      }

      const special = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: m.provider, modelId: m.id } } }, context);
      await rt.conversations.update(Number(special.id), { archived: true });
      const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 5, totalTokens: 40, reasoning: 0, cacheWrite1h: 0,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
      const firstEntry = await special.commit(async tx => {
        const doc = await tx.doc(UsageDoc, special.id);
        doc.models["faux/advanced"] = usage; // Ledger-only compaction-shaped usage.
        doc.models["retired/model/with/slashes"] = { ...usage, reasoning: 2, cacheWrite1h: 1 };
        doc.tools.search = { ...usage, totalTokens: 9999 }; // Never enters model totals.
        let first;
        for (let i = 0; i < 205; i++) {
          const msg = fauxAssistantMessage([fauxText("Paginated response")]);
          msg.provider = "faux"; msg.model = "main";
          msg.usage = usage;
          msg.timestamp = i % 2 ? Date.UTC(2026, 0, 2) : Date.UTC(2026, 0, 1, 23, 59, 59);
          msg.stopReason = i === 0 ? "error" : i === 1 ? "aborted" : "stop";
          const entry = await tx.appendEntry(AssistantEntry, special.id, { model: [msg] });
          first ??= entry;
        }
        return first!;
      }, context);
      const fork = await special.fork(firstEntry.id, { ownership: { kind: "ownerless" } }, context);
      await fork.commit(async tx => {
        const doc = await tx.doc(UsageDoc, fork.id);
        doc.models["faux/advanced"] = { ...usage, input: -1, cost: { ...usage.cost, input: -100, total: -100 } };
        const msg = fauxAssistantMessage([fauxText("Unknown model response")]);
        msg.provider = "unknown"; msg.model = "entry-only"; msg.timestamp = 1e30;
        msg.usage = usage;
        await tx.appendEntry(AssistantEntry, fork.id, { model: [msg] });
      }, context);

      // 3. Request /v1/analytics
      const res = await app.request("/v1/analytics", { headers });
      assert.equal(res.status, 200, await res.clone().text());
      const data = await res.json() as any;

      assert.ok(data.generatedAt);
      assert.ok(typeof data.scope === "string");
      assert.ok(data.totals);
      assert.ok(Array.isArray(data.models));
      assert.ok(Array.isArray(data.tools));
      assert.equal(data.sessions, convsCount + 2);
      assert.ok(Array.isArray(data.notes));

      // Verify exact totals and aggregates
      assert.equal(data.totals.input, 105 * 1000 + 20);
      assert.equal(data.totals.output, 105 * 200 + 15);
      assert.equal(data.totals.cacheRead, 105 * 500 + 60);
      assert.equal(data.totals.cacheWrite, 105 * 100 + 15);
      assert.equal(data.totals.totalTokens, 105 * 1800 + 120);

      assert.equal(data.totals.reasoning, 2);
      assert.equal(data.totals.cacheWrite1h, 1);
      assert.equal(data.totals.cacheHitRate, data.totals.cacheRead / (data.totals.input + data.totals.cacheRead + data.totals.cacheWrite));
      assert.ok(Math.abs(data.totals.cost.total - (105 * 0.0036 + 2)) < 1e-10);
      assert.ok(Math.abs(data.totals.cost.input - (105 * 0.002 + 0.2)) < 1e-10, "Negative costs must not subtract spend");
      assert.deepEqual(data.models.map((x: any) => x.key), ["faux/advanced", "faux/main", "retired/model/with/slashes", "unknown/entry-only"]);
      const advanced = data.models[0], main = data.models[1], retired = data.models[2], entryOnly = data.models[3];
      assert.deepEqual(advanced.rates, { input: 2.5, output: 10, cacheRead: 0.5, cacheWrite: 2 });
      assert.equal(advanced.sessions, 2); assert.equal(advanced.responses, 0);
      assert.equal(advanced.usage.reasoning, 0, "Reported zero is not missing");
      assert.equal(advanced.usage.cacheWrite1h, 0);
      assert.deepEqual(advanced.daily, []); assert.equal(advanced.firstSeen, null);
      assert.equal(main.responses, 105 + 205, "Inherited response must not be recounted in fork");
      assert.equal(main.sessions, 105, "Response history does not fabricate ledger sessions");
      assert.equal(main.errors, 1); assert.equal(main.aborted, 1);
      assert.equal(main.usage.reasoning, null); assert.equal(main.usage.cacheWrite1h, null);
      assert.equal(main.firstSeen, "2026-01-01T23:59:59.000Z");
      const jan1 = main.daily.find((d: any) => d.date === "2026-01-01");
      const jan2 = main.daily.find((d: any) => d.date === "2026-01-02");
      assert.equal(jan1.responses, 103); assert.equal(jan2.responses, 102);
      assert.equal(jan1.usage.totalTokens, 103 * 40);
      assert.deepEqual(main.daily.map((d: any) => d.date), [...main.daily.map((d: any) => d.date)].sort());
      assert.equal(retired.provider, "retired"); assert.equal(retired.model, "model/with/slashes"); assert.equal(retired.rates, null);
      assert.equal(entryOnly.usage.totalTokens, 0); assert.equal(entryOnly.responses, 1);
      assert.equal(entryOnly.sessions, 0); assert.equal(entryOnly.firstSeen, null); assert.deepEqual(entryOnly.daily, []);
      assert.equal(data.tools.length, 1); assert.equal(data.tools[0].name, "search");
      assert.equal(data.tools[0].usage.totalTokens, 105 * 120 + 9999);
      for (const [path, mime] of [["/analytics.js", "text/javascript"], ["/analytics.css", "text/css"]]) {
        const r = await app.request(path!); assert.equal(r.status, 200); assert.ok(r.headers.get("content-type")!.startsWith(mime!));
      }
      assert.equal((await app.request("/v1/analytics", { headers: { authorization: "Bearer wrong" } })).status, 401);
      const broken = new Proxy(rt.harness, { get(target, key, receiver) {
        if (key === "commit") return async () => { throw new Error("Storage unavailable"); };
        return Reflect.get(target, key, receiver);
      } });
      const failed = await createApp({ harness: broken, models }).request("/v1/analytics");
      assert.equal(failed.status, 500, "Storage errors must not return an incomplete success");
      assert.match(await failed.text(), /Storage unavailable/);
      console.log("ANALYTICS_CONTRACT_TEST_OK: pagination, exact ledgers, tool separation, forks, archive, zero/null subsets, rates, dates, response errors, auth and storage failures");
    } finally {
      await rt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` ) {
  await runVerifyAnalytics();
}
