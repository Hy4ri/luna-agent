import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { UsageDoc } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { analyticsService } from "../src/analytics/index.js";
import { ANALYTICS_TABS } from "../src/analytics/types.js";

async function makeTempDb() {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-http-test-"));
  const dbPath = join(dir, "luna.db");
  return {
    dir,
    dbPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("analytics HTTP contracts: legacy routes, v2 tabs, filters, sorting validation, CSV/JSON export, deleted retention, and SSE coalescing", async () => {
  const tmp = await makeTempDb();
  try {
    const models = createModels();
    const harness = await openLuna({
      dbPath: tmp.dbPath,
      models,
      memory: false,
      coding: false,
    });

    try {
      const conversations = new ConversationStore(harness);
      const app = createApp({
        harness,
        conversations,
        models,
      });

      // 1. Seed two conversations with assistant entries, metadata, and ledger usage
      const convA = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      const convB = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
      const idA = Number(convA.id);
      const idB = Number(convB.id);

      await conversations.update(idA, { title: "Session A Analytics" });
      await conversations.update(idB, { title: "Session B Analytics" });

      const now = Date.now();
      await harness.commit(async (tx) => {
        await tx.appendEntry(convA.id, {
          kind: "pi.assistant",
          model: [{
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-5-sonnet",
            api: "anthropic-messages",
            stopReason: "stop",
            content: [{ type: "text", text: "Response from A" }],
            timestamp: now - 1000,
            usage: {
              input: 120,
              output: 60,
              cacheRead: 20,
              cacheWrite: 10,
              totalTokens: 210,
              cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
            },
          }],
        });

        await tx.appendEntry(convB.id, {
          kind: "pi.assistant",
          model: [{
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            api: "openai-completions",
            stopReason: "stop",
            content: [{ type: "text", text: "Response from B" }],
            timestamp: now,
            usage: {
              input: 200,
              output: 100,
              cacheRead: 50,
              cacheWrite: 0,
              totalTokens: 350,
              cost: { input: 0.002, output: 0.004, cacheRead: 0.0002, cacheWrite: 0, total: 0.0062 },
            },
          }],
        });

        const docA = await tx.doc(UsageDoc, convA.id);
        docA.models["anthropic/claude-3-5-sonnet"] = {
          input: 120,
          output: 60,
          cacheRead: 20,
          cacheWrite: 10,
          totalTokens: 210,
          cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
        };

        const docB = await tx.doc(UsageDoc, convB.id);
        docB.models["openai/gpt-4o"] = {
          input: 200,
          output: 100,
          cacheRead: 50,
          cacheWrite: 0,
          totalTokens: 350,
          cost: { input: 0.002, output: 0.004, cacheRead: 0.0002, cacheWrite: 0, total: 0.0062 },
        };
      }, BACKGROUND_CONTEXT);

      // Trigger indexer refresh
      const service = analyticsService(harness, conversations);
      await service.refresh();

      // 2. Legacy analytics endpoint /v1/analytics
      const legacyRes = await app.request("/v1/analytics");
      assert.equal(legacyRes.status, 200);
      const legacyData = (await legacyRes.json()) as {
        totals: { totalTokens: number };
        sessions: number;
        sessionsList: Array<{ id: string; title: string | null }>;
      };
      assert.ok(legacyData.sessions >= 2, "legacy analytics should see at least 2 sessions");
      assert.ok(Array.isArray(legacyData.sessionsList), "sessionsList should be an array");
      assert.ok(legacyData.totals && typeof legacyData.totals.totalTokens === "number");

      // Legacy /v1/analytics/sessions
      const legacySessionsRes = await app.request("/v1/analytics/sessions?sort=tokensDesc&limit=10");
      assert.equal(legacySessionsRes.status, 200);
      const legacySessionsData = (await legacySessionsRes.json()) as {
        sessions: Array<{ id: string; title: string | null; usage: { totalTokens: number } }>;
        total: number;
      };
      assert.equal(legacySessionsData.total >= 2, true);
      assert.ok(legacySessionsData.sessions.length >= 2);

      // 3. /v1/analytics/v2/filters options
      const filtersRes = await app.request("/v1/analytics/v2/filters");
      assert.equal(filtersRes.status, 200);
      const filterOpts = (await filtersRes.json()) as {
        models: Array<{ value: string; label: string }>;
        providers: Array<{ value: string; label: string }>;
      };
      assert.ok(Array.isArray(filterOpts.models));
      assert.ok(Array.isArray(filterOpts.providers));

      // 4. Test all 10 tabs under /v1/analytics/v2/:tab
      for (const tab of ANALYTICS_TABS) {
        const tabRes = await app.request(`/v1/analytics/v2/${tab}`);
        assert.equal(tabRes.status, 200, `Tab /v1/analytics/v2/${tab} should return 200`);
        const tabData = (await tabRes.json()) as {
          tab: string;
          summary: Record<string, unknown>;
          table: { columns: unknown[]; rows: unknown[]; total: number };
        };
        assert.equal(tabData.tab, tab);
        assert.ok(tabData.summary !== undefined);
        assert.ok(Array.isArray(tabData.table.rows));
      }

      // 5. Invalid tab must return 400 without crashing
      const invalidTabRes = await app.request("/v1/analytics/v2/non_existent_tab");
      assert.equal(invalidTabRes.status, 400);

      // 6. Malformed sort and SQL injection rejected with 400 (not 500)
      const badSortRes1 = await app.request("/v1/analytics/v2/sessions?sort=notAColumn:desc");
      // Could be valid regex for parseAnalyticsFilters but queryAnalytics fails with 400 on allowlist
      assert.equal(badSortRes1.status, 400);

      const badSortRes2 = await app.request("/v1/analytics/v2/sessions?sort=tokens;DROP%20TABLE%20analytics_facts;--");
      assert.equal(badSortRes2.status, 400);

      const badSortRes3 = await app.request("/v1/analytics/v2/sessions?sort=invalid_column%20asc");
      assert.equal(badSortRes3.status, 400);

      // 7. CSV and JSON export
      const csvRes = await app.request("/v1/analytics/v2/sessions/export?format=csv&search=Session%20A");
      assert.equal(csvRes.status, 200);
      assert.match(csvRes.headers.get("content-type") ?? "", /text\/csv/);
      const csvBody = await csvRes.text();
      assert.match(csvBody, /Session A Analytics/);
      assert.doesNotMatch(csvBody, /Session B Analytics/);

      const jsonRes = await app.request("/v1/analytics/v2/sessions/export?format=json");
      assert.equal(jsonRes.status, 200);
      assert.match(jsonRes.headers.get("content-type") ?? "", /application\/json/);
      const jsonRows = (await jsonRes.json()) as unknown[];
      assert.ok(Array.isArray(jsonRows));
      assert.ok(jsonRows.length >= 2);

      // 8. Delete a session and verify tombstone retention and title/usage preserved when includeDeleted=true
      await conversations.delete(idA);
      await service.refresh();

      // Query with includeDeleted=true (default)
      const delQueryRes = await app.request("/v1/analytics/v2/sessions?includeDeleted=true");
      assert.equal(delQueryRes.status, 200);
      const delQueryData = (await delQueryRes.json()) as {
        table: { rows: Array<{ id: string | number; title: string | null; deletedAt: number | null; totalTokens: number }> };
      };
      const rowA = delQueryData.table.rows.find((r) => String(r.id) === String(idA));
      assert.ok(rowA, "Deleted session A must be present when includeDeleted=true");
      assert.equal(rowA.title, "Session A Analytics");
      assert.ok(rowA.deletedAt !== null, "deletedAt should be set on tombstoned session");
      assert.ok(rowA.totalTokens > 0, "Usage metrics must remain intact after deletion");

      // Query with includeDeleted=false
      const activeOnlyRes = await app.request("/v1/analytics/v2/sessions?includeDeleted=false");
      assert.equal(activeOnlyRes.status, 200);
      const activeOnlyData = (await activeOnlyRes.json()) as {
        table: { rows: Array<{ id: string | number }> };
      };
      const rowANotFound = activeOnlyData.table.rows.some((r) => String(r.id) === String(idA));
      assert.equal(rowANotFound, false, "Deleted session A must not appear when includeDeleted=false");

      // 9. SSE coalescing: subscribe to /v1/events and verify analytics_changed event
      const sseController = new AbortController();
      const sseRes = await app.request("/v1/events", {
        signal: sseController.signal,
      });
      assert.equal(sseRes.status, 200);
      assert.ok(sseRes.body, "SSE response stream must be present");

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      // The handler registers its subscriptions inside the stream callback, after headers are sent. It emits an
      // initial sessions_changed only after registering, so wait for it: a change made earlier can be missed (#526).
      while (!buffer.includes("event: sessions_changed")) {
        const { value, done } = await reader.read();
        assert.ok(!done, "SSE stream ended before the initial event");
        buffer += decoder.decode(value, { stream: true });
      }

      // Publication follows a materialized source change, not arbitrary raw DB writes.
      await conversations.update(idB, { title: "Session B refreshed" });
      await service.refresh();

      // Monotonic budget: this host suspends in short bursts. Date.now() jumps across a suspend and ended
      // the wait after only ~0.3 s of process time (#526). performance.now() pauses with the process.
      const timeoutDeadline = performance.now() + 2000;
      let receivedAnalyticsChanged = buffer.includes("event: analytics_changed");

      try {
        while (performance.now() < timeoutDeadline && !receivedAnalyticsChanged) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: true }>((resolve) => {
              timeout = setTimeout(() => resolve({ value: undefined, done: true }), Math.max(0, timeoutDeadline - performance.now()));
            }),
          ]);
          clearTimeout(timeout);
          if (done && value === undefined) break;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            if (buffer.includes("event: analytics_changed")) {
              receivedAnalyticsChanged = true;
              break;
            }
          }
        }
      } finally {
        sseController.abort();
        try {
          await reader.cancel();
        } catch {
          // ignore abort cancel error
        }
      }

      assert.ok(receivedAnalyticsChanged, "SSE stream should receive coalesced analytics_changed event");
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await tmp.cleanup();
  }
});
