import { Database } from "bun:sqlite";
import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { scanAnalyticsSession } from "../src/analytics/source.js";
import { AnalyticsStore } from "../src/analytics/store.js";
import {
  AnalyticsWaitDoc,
  closeOpenSessionStatusWaits,
  closeWait,
  startWait,
} from "../src/analytics/waits.js";

const tempDirs: string[] = [];
const openStores: AnalyticsStore[] = [];
const openDbs: Database[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "luna-analytics-waits-"));
  tempDirs.push(dir);
  return dir;
}

function createTempStore(): AnalyticsStore {
  const dir = createTempDir();
  const store = new AnalyticsStore(join(dir, "analytics.db"));
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (openDbs.length > 0) openDbs.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("analytics waits", () => {
  test("startWait and closeWait in real tx: preserves startedAt on duplicate, close is idempotent, no question/answer in metadata", async () => {
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      context,
    );
    try {
      const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);

      const first = await harness.commit(async (tx) => {
        return startWait(tx, conv.id, {
          callId: "call-1",
          kind: "ask_user_question",
          purpose: "input",
          tool: "ask_user_question",
          startedAt: 1_000,
        });
      }, context);
      expect(first).toBe(true);

      // Duplicate startWait with same callId must return false and preserve startedAt: 1000
      const dup = await harness.commit(async (tx) => {
        const ok = await startWait(tx, conv.id, {
          callId: "call-1",
          kind: "ask_user_question",
          purpose: "input",
          tool: "ask_user_question",
          startedAt: 9_999,
        });
        const doc = await tx.doc(AnalyticsWaitDoc, conv.id);
        return { ok, startAt: doc.pending["call-1"]?.startAt };
      }, context);
      expect(dup.ok).toBe(false);
      expect(dup.startAt).toBe(1_000);

      const closed = await harness.commit(async (tx) => {
        return closeWait(tx, conv.id, {
          callId: "call-1",
          outcome: "answered",
          endedAt: 2_500,
        });
      }, context);
      expect(closed).toBe(true);

      // Second closeWait is idempotent
      const closedAgain = await harness.commit(async (tx) => {
        return closeWait(tx, conv.id, {
          callId: "call-1",
          outcome: "answered",
          endedAt: 3_000,
        });
      }, context);
      expect(closedAgain).toBe(false);

      // Closed call cannot restart
      const restarted = await harness.commit(async (tx) => {
        return startWait(tx, conv.id, {
          callId: "call-1",
          kind: "ask_user_question",
          purpose: "input",
          tool: "ask_user_question",
          startedAt: 4_000,
        });
      }, context);
      expect(restarted).toBe(false);

      // Verify wait metadata entries contain no question/answer fields
      const { items: allEntries } = await conv.entries({}, 100, undefined, context);
      const entries = allEntries.filter((e) => e.kind === "luna.analytics.wait");
      expect(entries.length).toBe(2);
      for (const entry of entries) {
        const data = entry.data as Record<string, unknown>;
        expect("question" in data).toBe(false);
        expect("answer" in data).toBe(false);
      }
    } finally {
      await harness.close(context);
    }
  });

  test("closeOpenSessionStatusWaits closes only session_status waits and records stopped/answered outcome", async () => {
    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      context,
    );
    try {
      const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);

      await harness.commit(async (tx) => {
        await startWait(tx, conv.id, {
          callId: "q-1",
          kind: "ask_user_question",
          purpose: "input",
          tool: "ask_user_question",
          startedAt: 1_000,
        });
        await startWait(tx, conv.id, {
          callId: "s-1",
          kind: "session_status",
          purpose: "approval",
          tool: "session_status",
          startedAt: 1_100,
        });
      }, context);

      const closedStopped = await harness.commit(async (tx) => {
        const ids = await closeOpenSessionStatusWaits(tx, conv.id, "stopped", 2_000);
        const doc = await tx.doc(AnalyticsWaitDoc, conv.id);
        return { ids, remainingKeys: Object.keys(doc.pending) };
      }, context);
      expect(closedStopped.ids).toEqual(["s-1"]);
      expect(closedStopped.remainingKeys).toEqual(["q-1"]);

      await harness.commit(async (tx) => {
        await startWait(tx, conv.id, {
          callId: "s-2",
          kind: "session_status",
          purpose: "input",
          tool: "session_status",
          startedAt: 2_100,
        });
      }, context);

      const closedAnswered = await harness.commit(async (tx) => {
        return closeOpenSessionStatusWaits(tx, conv.id, "answered", 3_000);
      }, context);
      expect(closedAnswered).toEqual(["s-2"]);

      const { items: allEntries } = await conv.entries({}, 100, undefined, context);
      const entries = allEntries.filter((e) => e.kind === "luna.analytics.wait");
      const closedPayloads = entries
        .map((e) => e.data as { callId: string; outcome: string | null })
        .filter((d) => d.outcome !== null)
        .map((d) => ({ callId: d.callId, outcome: d.outcome }));
      expect(closedPayloads).toEqual([
        { callId: "s-2", outcome: "answered" },
        { callId: "s-1", outcome: "stopped" },
      ]);
    } finally {
      await harness.close(context);
    }
  });

  test("scanner: historical generic wait has null duration vs measured metadata wait 1500ms; incremental ending upserts same fact key", async () => {
    const dir = createTempDir();
    const convDbPath = join(dir, "luna.db");
    const harness = await openLuna({ dbPath: convDbPath, models: createModels(), memory: false, coding: false });
    const store = createTempStore();

    try {
      const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      const db = new Database(convDbPath, { readonly: true });
      openDbs.push(db);

      // 1) Historical generic wait (pi.assistant toolCall without luna.analytics.wait metadata) -> durationMs: null
      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: "hist-1", name: "ask_user_question", arguments: { question: "hi" } }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        timestamp: 1_000,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      await harness.commit(async (tx) => {
        await tx.appendEntry(conv.id, { kind: "pi.assistant", model: [assistantMsg] } as never);
      }, context);

      const histScan = scanAnalyticsSession(db, conv.id)!;
      store.apply(histScan);
      const histWait = histScan.facts.find((f) => f.key === `wait:${conv.id}:hist-1`);
      expect(histWait).toBeTruthy();
      expect(histWait!.kind).toBe("wait");
      expect(histWait!.durationMs).toBe(null);

      // 2) Measured metadata wait: first open (endedAt: null -> durationMs: null), then closed (endedAt: 2500 -> durationMs: 1500)
      await harness.commit(async (tx) => {
        await tx.appendEntry(conv.id, {
          kind: "luna.analytics.wait",
          data: {
            callId: "meta-1",
            startedAt: 1_000,
            endedAt: null,
            purpose: "input",
            tool: "ask_user_question",
            outcome: null,
          } as never,
        });
      }, context);

      const openScan = scanAnalyticsSession(db, conv.id, histScan.session)!;
      store.apply(openScan);

      await harness.commit(async (tx) => {
        await tx.appendEntry(conv.id, {
          kind: "luna.analytics.wait",
          data: {
            callId: "meta-1",
            startedAt: 1_000,
            endedAt: 2_500,
            purpose: "input",
            tool: "ask_user_question",
            outcome: "answered",
          } as never,
        });
      }, context);

      const closedScan = scanAnalyticsSession(db, conv.id, openScan.session)!;
      store.apply(closedScan);

      const rows = store.db
        .query(`SELECT key, duration_ms FROM analytics_facts WHERE session_id = ? AND key = ?`)
        .all(conv.id, `wait:${conv.id}:meta-1`) as { key: string; duration_ms: number | null }[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.duration_ms).toBe(1500);
    } finally {
      await harness.close(context);
    }
  });
});
