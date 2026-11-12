import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import { AnalyticsStore } from "../src/analytics/store.js";
import type { AnalyticsFact, AnalyticsScan, AnalyticsSessionRecord } from "../src/analytics/types.js";

async function makeTempStore(parserVersion?: number) {
  const dir = await mkdtemp(join(tmpdir(), "luna-analytics-test-"));
  const dbPath = join(dir, "analytics.db");
  const store = new AnalyticsStore(dbPath, parserVersion);
  return {
    dir,
    dbPath,
    store,
    async cleanup() {
      try {
        store.close();
      } catch {
        // ignore already closed
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function makeSessionRecord(overrides: Partial<AnalyticsSessionRecord> = {}): AnalyticsSessionRecord {
  return {
    id: 1,
    title: "Session 1",
    parentId: null,
    projectId: 1,
    projectName: "Project A",
    worker: "main",
    cwd: "/workspace",
    createdAt: 1000,
    lastActivity: 2000,
    status: "idle",
    statusReason: null,
    archived: false,
    pinned: false,
    deletedAt: null,
    lastEntryId: 5,
    revision: "rev-1",
    userTurns: 2,
    assistantTurns: 2,
    subagentCount: 0,
    forkDepth: 0,
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 20,
      totalTokens: 180,
      reasoning: null,
      cacheWrite1h: null,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
      cacheHitRate: 0.0769,
    },
    workflow: {
      goals: 1,
      completedGoals: 1,
      todos: 2,
      completedTodos: 2,
      visionCalls: 0,
      uploads: 0,
      uploadBytes: 0,
    },
    ...overrides,
  };
}

function makeFact(overrides: Partial<AnalyticsFact> = {}): AnalyticsFact {
  return {
    key: "fact-1",
    sessionId: 1,
    kind: "response",
    ts: 1500,
    name: "step-1",
    model: "claude-3-5-sonnet",
    source: "direct",
    durationMs: 450,
    error: false,
    aborted: false,
    data: { role: "assistant" },
    usage: {
      input: 50,
      output: 25,
      totalTokens: 75,
    },
    ...overrides,
  };
}

describe("AnalyticsStore", () => {
  it("atomic apply and upsert idempotency", async () => {
    const tmp = await makeTempStore();
    try {
      const session = makeSessionRecord({ id: 101, title: "Initial Title" });
      const fact1 = makeFact({ key: "fact-101-1", sessionId: 101, durationMs: 100 });
      const fact2 = makeFact({ key: "fact-101-2", sessionId: 101, durationMs: 200 });

      const scan1: AnalyticsScan = {
        session,
        facts: [fact1, fact2],
        rebuild: false,
        entriesScanned: 2,
      };

      tmp.store.apply(scan1);

      // Verify session stored
      const storedSession = tmp.store.getSession(101);
      expect(storedSession).toBeTruthy() /* "Session 101 should exist" */;
      expect(storedSession!.id).toBe(101);
      expect(storedSession!.title).toBe("Initial Title");

      // Verify facts stored via raw db check
      const factsBefore = tmp.store.db
        .query<{ key: string; duration_ms: number }, [number]>(
          "SELECT key, duration_ms FROM analytics_facts WHERE session_id = ? ORDER BY key ASC",
        )
        .all(101);
      expect(factsBefore.length).toBe(2);
      expect(factsBefore[0]!.key).toBe("fact-101-1");
      expect(factsBefore[0]!.duration_ms).toBe(100);
      expect(factsBefore[1]!.key).toBe("fact-101-2");
      expect(factsBefore[1]!.duration_ms).toBe(200);

      // Apply duplicate scan with updated fact values (upsert idempotency)
      const updatedSession = makeSessionRecord({ id: 101, title: "Updated Title" });
      const fact1Updated = makeFact({ key: "fact-101-1", sessionId: 101, durationMs: 150 });
      const scanDuplicate: AnalyticsScan = {
        session: updatedSession,
        facts: [fact1Updated, fact2],
        rebuild: false,
        entriesScanned: 2,
      };

      tmp.store.apply(scanDuplicate);

      // Check session updated
      const sessionAfter = tmp.store.getSession(101);
      expect(sessionAfter).toBeTruthy();
      expect(sessionAfter!.title).toBe("Updated Title");

      // Check fact updated rather than duplicated
      const factsAfter = tmp.store.db
        .query<{ key: string; duration_ms: number }, [number]>(
          "SELECT key, duration_ms FROM analytics_facts WHERE session_id = ? ORDER BY key ASC",
        )
        .all(101);
      expect(factsAfter.length).toBe(2) /* "Duplicate keys must upsert and not duplicate rows" */;
      expect(factsAfter[0]!.key).toBe("fact-101-1");
      expect(factsAfter[0]!.duration_ms).toBe(150) /* "Upsert should update fields" */;
      expect(factsAfter[1]!.key).toBe("fact-101-2");
      expect(factsAfter[1]!.duration_ms).toBe(200);
    } finally {
      await tmp.cleanup();
    }
  });

  it("restart persistence across closing and reopening db", async () => {
    const tmp = await makeTempStore();
    try {
      const session = makeSessionRecord({ id: 42, title: "Persistent Session" });
      const fact = makeFact({ key: "fact-42", sessionId: 42, model: "gpt-4o" });

      tmp.store.apply({
        session,
        facts: [fact],
        rebuild: false,
        entriesScanned: 1,
      });

      // Close store and reopen from same sqlite path
      tmp.store.close();

      const reopened = new AnalyticsStore(tmp.dbPath);
      try {
        const retrieved = reopened.getSession(42);
        expect(retrieved).toBeTruthy() /* "Session should persist across restart" */;
        expect(retrieved!.id).toBe(42);
        expect(retrieved!.title).toBe("Persistent Session");

        const allSessions = reopened.sessions();
        expect(allSessions.length).toBe(1);
        expect(allSessions[0]!.id).toBe(42);

        const factRow = reopened.db
          .query<{ key: string; model: string }, [number]>(
            "SELECT key, model FROM analytics_facts WHERE session_id = ?",
          )
          .get(42);
        expect(factRow).toBeTruthy() /* "Fact row must persist across restart" */;
        expect(factRow!.key).toBe("fact-42");
        expect(factRow!.model).toBe("gpt-4o");
      } finally {
        reopened.close();
      }
    } finally {
      await tmp.cleanup();
    }
  });

  it("incremental new facts append without destroying existing facts when rebuild is false", async () => {
    const tmp = await makeTempStore();
    try {
      const sessionInitial = makeSessionRecord({ id: 10, lastEntryId: 1 });
      const fact1 = makeFact({ key: "fact-10-1", sessionId: 10 });

      tmp.store.apply({
        session: sessionInitial,
        facts: [fact1],
        rebuild: false,
        entriesScanned: 1,
      });

      // Incremental append: scan contains only new facts
      const sessionIncremental = makeSessionRecord({ id: 10, lastEntryId: 2 });
      const fact2 = makeFact({ key: "fact-10-2", sessionId: 10, ts: 2500 });

      tmp.store.apply({
        session: sessionIncremental,
        facts: [fact2],
        rebuild: false,
        entriesScanned: 1,
      });

      const facts = tmp.store.db
        .query<{ key: string }, [number]>(
          "SELECT key FROM analytics_facts WHERE session_id = ? ORDER BY key ASC",
        )
        .all(10);
      expect(facts.length).toBe(2) /* "Both initial and incrementally added fact must be preserved" */;
      expect(facts[0]!.key).toBe("fact-10-1");
      expect(facts[1]!.key).toBe("fact-10-2");

      const session = tmp.store.getSession(10);
      expect(session?.lastEntryId).toBe(2);
    } finally {
      await tmp.cleanup();
    }
  });

  it("rebuild replaces only target session facts and does not touch other sessions", async () => {
    const tmp = await makeTempStore();
    try {
      // Seed session 1 with 2 facts
      const s1 = makeSessionRecord({ id: 1, title: "Session 1" });
      const f1_a = makeFact({ key: "f1-a", sessionId: 1 });
      const f1_b = makeFact({ key: "f1-b", sessionId: 1 });
      tmp.store.apply({ session: s1, facts: [f1_a, f1_b], rebuild: false, entriesScanned: 2 });

      // Seed session 2 with 2 facts
      const s2 = makeSessionRecord({ id: 2, title: "Session 2" });
      const f2_a = makeFact({ key: "f2-a", sessionId: 2 });
      const f2_b = makeFact({ key: "f2-b", sessionId: 2 });
      tmp.store.apply({ session: s2, facts: [f2_a, f2_b], rebuild: false, entriesScanned: 2 });

      // Apply rebuild scan for session 1 with 1 completely new fact
      const s1Rebuilt = makeSessionRecord({ id: 1, title: "Session 1 Rebuilt" });
      const f1_c = makeFact({ key: "f1-c", sessionId: 1 });
      tmp.store.apply({ session: s1Rebuilt, facts: [f1_c], rebuild: true, entriesScanned: 1 });

      // Verify session 1 facts were replaced
      const s1Facts = tmp.store.db
        .query<{ key: string }, [number]>("SELECT key FROM analytics_facts WHERE session_id = ? ORDER BY key ASC")
        .all(1);
      expect(s1Facts.length).toBe(1);
      expect(s1Facts[0]!.key).toBe("f1-c");

      // Verify session 2 facts remain completely untouched
      const s2Facts = tmp.store.db
        .query<{ key: string }, [number]>("SELECT key FROM analytics_facts WHERE session_id = ? ORDER BY key ASC")
        .all(2);
      expect(s2Facts.length).toBe(2);
      expect(s2Facts[0]!.key).toBe("f2-a");
      expect(s2Facts[1]!.key).toBe("f2-b");

      const s2Record = tmp.store.getSession(2);
      expect(s2Record?.title).toBe("Session 2");
    } finally {
      await tmp.cleanup();
    }
  });

  it("tombstones remain when markDeleted is called and preserve tombstone on apply unless new incarnation", async () => {
    const tmp = await makeTempStore();
    try {
      const s1 = makeSessionRecord({ id: 20, createdAt: 1000, title: "Session 20" });
      tmp.store.apply({ session: s1, facts: [makeFact({ key: "f-20", sessionId: 20 })], rebuild: false, entriesScanned: 1 });

      const deletedAt = 5000;
      tmp.store.markDeleted([20], deletedAt);

      const deletedSession = tmp.store.getSession(20);
      expect(deletedSession).toBeTruthy() /* "Session row remains in store as tombstone" */;
      expect(deletedSession!.deletedAt).toBe(deletedAt) /* "deletedAt must be recorded" */;

      // Attempt apply with older or matching incarnation without explicit new created_at
      const sameIncarnation = makeSessionRecord({ id: 20, createdAt: 1000, title: "Stale Scan" });
      tmp.store.apply({ session: sameIncarnation, facts: [], rebuild: false, entriesScanned: 0 });

      const preservedTombstone = tmp.store.getSession(20);
      expect(preservedTombstone?.deletedAt).toBe(deletedAt) /* "Tombstone must be preserved against re-applying deleted session" */;

      // Now source proves a new incarnation with newer created_at > deletedAt
      const newIncarnation = makeSessionRecord({ id: 20, createdAt: 6000, title: "Recreated Session 20", deletedAt: null });
      tmp.store.apply({ session: newIncarnation, facts: [makeFact({ key: "f-20-new", sessionId: 20 })], rebuild: false, entriesScanned: 1 });

      const resurrected = tmp.store.getSession(20);
      expect(resurrected?.deletedAt).toBe(null) /* "New incarnation replaces tombstone" */;
      expect(resurrected?.createdAt).toBe(6000);
      expect(resurrected?.title).toBe("Recreated Session 20");
    } finally {
      await tmp.cleanup();
    }
  });

  it("parser bump doesn't delete tombstones and invalidates retained sessions revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "luna-analytics-parser-bump-"));
    const dbPath = join(dir, "analytics.db");

    try {
      // Version 1 store
      const storeV1 = new AnalyticsStore(dbPath, 1);
      const activeSession = makeSessionRecord({ id: 30, title: "Active Session", revision: "rev-30" });
      const tombstoneSession = makeSessionRecord({ id: 31, title: "Tombstoned Session", deletedAt: 9999 });

      storeV1.apply({ session: activeSession, facts: [makeFact({ key: "fact-30", sessionId: 30 })], rebuild: false, entriesScanned: 1 });
      storeV1.apply({ session: tombstoneSession, facts: [makeFact({ key: "fact-31", sessionId: 31 })], rebuild: false, entriesScanned: 1 });
      storeV1.markDeleted([31], 9999);
      storeV1.close();

      // Open with bumped parser version 2
      const storeV2 = new AnalyticsStore(dbPath, 2);
      try {
        // Tombstone MUST remain intact because deleted sessions cannot be rescanned/reparsed
        const tombstone = storeV2.getSession(31);
        expect(tombstone).toBeTruthy() /* "Tombstone row must not be destroyed by parser version bump" */;
        expect(tombstone!.deletedAt).toBe(9999);

        // Retained session revision is empty / invalidated on version mismatch to force re-parse
        const retained = storeV2.getSession(30);
        expect(retained).toBeTruthy() /* "Retained session record is accessible" */;
        expect(retained!.revision).toBe("") /* "Revision should be empty on version mismatch for retained session" */;

        // Facts for retained sessions cleared or flagged on scan, but tombstone preserved
        const tombstoneRow = storeV2.db
          .query<{ deleted_at: number | null }, [number]>("SELECT deleted_at FROM analytics_sessions WHERE id = ?")
          .get(31);
        expect(tombstoneRow?.deleted_at).toBe(9999);
      } finally {
        storeV2.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
