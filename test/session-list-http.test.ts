import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { ExecTarget } from "../src/workers.js";
import { SessionCreated } from "../src/session-activity.js";
import { finishSessionReview, SessionHandoffDoc, startSessionReview } from "../src/session-status.js";

async function makeTempDb() {
  const dir = await mkdtemp(join(tmpdir(), "luna-session-list-http-test-"));
  const dbPath = join(dir, "luna.db");
  return {
    dir,
    dbPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("opt-in GET /v1/sessions pagination protocol: legacy compatibility, bounded pages, keyset traversal, and global group summaries", async () => {
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

      // 1. Create a named project
      const proj = conversations.projects.create("Alpha Project", tmp.dir);
      const projId = proj.id;

      // 2. Create 6 sessions:
      // s1: General (no link), user msg "alpha search test"
      // s2: General, pinned=true, user msg "pinned session s2"
      // s3: Alpha Project, archived=true, user msg "archived alpha session"
      // s4: Alpha Project, worker=42, user msg "worker session on alpha"
      // s5: General, worker=99, user msg "worker session on main/general"
      // s6: delegate child (parent=s1, has delegate.child entry) -> must be hidden
      const s1 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await conversations.update(Number(s1), { title: "alpha search test" });

      const s2 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await conversations.update(Number(s2), { title: "pinned session s2", pinned: true });

      const s3 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await conversations.update(Number(s3), { title: "archived alpha session", archived: true });
      await conversations.move(Number(s3), projId);

      const s4 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await conversations.update(Number(s4), { title: "worker session on alpha" });
      await harness.commit(async (tx) => {
        (await tx.doc(ExecTarget, s4)).worker = 42;
      }, context);
      await conversations.move(Number(s4), projId);

      const s5 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await conversations.update(Number(s5), { title: "worker session on main/general" });
      await harness.commit(async (tx) => {
        (await tx.doc(ExecTarget, s5)).worker = 99;
      }, context);

      // s6: subagent delegate child (should be hidden from session listing)
      const s6 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await harness.commit(async (tx) => {
        await tx.appendEntry(s6, { kind: "delegate.child", data: { parent: Number(s1) } } as never);
      }, context);

      // Pin order dominates activity; s4/s5 share activity, so a cursor must retain the ID tie-breaker.
      await harness.commit(async tx => {
        for (const [id, at] of [[s1, 100], [s2, 10], [s3, 400], [s4, 300], [s5, 300], [s6, 999]] as const) {
          (await tx.doc(SessionCreated, id)).at = at;
        }
      }, context);

      // --- Legacy GET /v1/sessions (no query parameters) ---
      const legacyRes = await app.request("/v1/sessions");
      expect(legacyRes.status).toBe(200);
      const legacyJson = (await legacyRes.json()) as { sessions: Array<{ id: number; pinned: boolean }>; nextCursor?: unknown; total?: unknown; groups?: unknown };
      expect(legacyJson.nextCursor).toBe(undefined);
      expect(legacyJson.total).toBe(undefined);
      expect(legacyJson.groups).toBe(undefined);
      expect(Array.isArray(legacyJson.sessions)).toBeTruthy();
      // Hidden s6 must be excluded
      const legacyIds = legacyJson.sessions.map((s) => s.id);
      expect(!legacyIds.includes(Number(s6))).toBeTruthy() /* "delegate child must be excluded" */;
      // Must include s1..s5 (archived s3 is included in unpaginated legacy listing)
      expect(legacyJson.sessions.length).toBe(5);
      // Pinned session s2 must be first
      expect(legacyIds).toEqual([s2, s3, s5, s4, s1].map(Number));

      // --- Opt-in pagination: page size limit=2 & keyset traversal ---
      // Visible unarchived: s2 (pinned), s1, s4, s5 (4 sessions)
      const page1Res = await app.request("/v1/sessions?limit=2");
      expect(page1Res.status).toBe(200);
      const page1Json = (await page1Res.json()) as {
        sessions: Array<{ id: number; pinned: boolean }>;
        nextCursor: string | null;
        total: number;
        groups: Record<string, { count: number; lastActivity: number; activity: number; statuses: Record<string, number>; machines: Record<string, number> }>;
      };
      expect(page1Json.sessions.length).toBe(2);
      expect(page1Json.total).toBe(4) /* "total matching unarchived non-delegate sessions" */;
      expect(typeof page1Json.nextCursor === "string" && page1Json.nextCursor.length > 0).toBeTruthy();
      expect(page1Json.sessions[0]?.id).toBe(Number(s2)) /* "pinned session s2 comes first" */;

      // Verify exact global groups summaries: ignore project/worker/q, computed over visible sessions excluding hidden delegate child
      // Unarchived visible: s2 (general, main), s1 (general, main), s5 (general, worker 99), s4 (Alpha, worker 42)
      // Archived: s3 (Alpha, main)
      const groups = page1Json.groups;
      expect(groups.none).toBeTruthy() /* "General group summary exists" */;
      const alphaSummary = groups[String(projId)];
      expect(alphaSummary).toBeTruthy() /* "Alpha project group summary exists" */;
      expect(groups.none!.count).toBe(3) /* "s1, s2, s5 in General" */;
      expect(groups.none!.machines).toEqual({ main: 2, "99": 1 });
      expect(alphaSummary!.count).toBe(1) /* "s4 in Alpha (s3 is archived)" */;
      expect(alphaSummary!.machines).toEqual({ "42": 1 });
      expect(groups).toEqual({
        none: { count: 3, lastActivity: 300, activity: 300, statuses: { ready: 3 }, machines: { main: 2, "99": 1 } },
        [projId]: { count: 1, lastActivity: 300, activity: 400, statuses: { ready: 1 }, machines: { "42": 1 } },
      });

      // Page 2 crosses the activity tie: s4 remains after s5, then the older s1.
      const page2Res = await app.request(`/v1/sessions?limit=2&cursor=${encodeURIComponent(page1Json.nextCursor!)}`);
      expect(page2Res.status).toBe(200);
      const page2Json = (await page2Res.json()) as {
        sessions: Array<{ id: number }>;
        nextCursor: string | null;
        total: number;
      };
      expect(page2Json.sessions.length).toBe(2);
      expect(page2Json.total).toBe(4);
      // Since startIndex (2) + limit (2) == total matching (4), no more sessions remain, nextCursor is null
      expect(page2Json.nextCursor).toBe(null);

      // Complete traversal uniqueness: combined pages cover exactly the 4 unarchived sessions without overlap
      const traversedIds = [...page1Json.sessions.map((s) => s.id), ...page2Json.sessions.map((s) => s.id)];
      expect(new Set(traversedIds).size).toBe(4);
      expect(traversedIds).toEqual([s2, s5, s4, s1].map(Number));
      expect(!traversedIds.includes(Number(s3))).toBeTruthy() /* "archived s3 not in archived=0" */;
      expect(!traversedIds.includes(Number(s6))).toBeTruthy() /* "delegate child s6 not in traversed sessions" */;

      // --- Filter combinations: project=none vs positive project id ---
      const projNoneRes = await app.request("/v1/sessions?limit=50&project=none");
      expect(projNoneRes.status).toBe(200);
      const projNoneJson = (await projNoneRes.json()) as { sessions: Array<{ id: number }>; total: number; groups: Record<string, unknown> };
      expect(projNoneJson.total).toBe(3) /* "s1, s2, s5 belong to project=none" */;
      expect(projNoneJson.groups).toEqual(groups) /* "project filtering must not narrow global summaries" */;
      const narrowed = await app.request(`/v1/sessions?limit=2&project=${projId}&worker=42&q=PROJECT%20worker`);
      expect(narrowed.status).toBe(200);
      const narrowedJson = await narrowed.json() as { sessions: { id: number }[]; groups: unknown };
      expect(narrowedJson.sessions.map(row => row.id)).toEqual([Number(s4)]) /* "AND search spans project name and title" */;
      expect(narrowedJson.groups).toEqual(groups) /* "worker and search filtering must not narrow global summaries" */;

      const projAlphaRes = await app.request(`/v1/sessions?limit=50&project=${projId}`);
      expect(projAlphaRes.status).toBe(200);
      const projAlphaJson = (await projAlphaRes.json()) as { sessions: Array<{ id: number }>; total: number };
      expect(projAlphaJson.total).toBe(1) /* "only s4 matches unarchived Alpha project" */;
      expect(projAlphaJson.sessions[0]?.id).toBe(Number(s4));

      // --- Filter combinations: worker=main vs positive worker id ---
      const workerMainRes = await app.request("/v1/sessions?limit=50&worker=main");
      expect(workerMainRes.status).toBe(200);
      const workerMainJson = (await workerMainRes.json()) as { sessions: Array<{ id: number }>; total: number };
      const workerMainIds = workerMainJson.sessions.map((s) => s.id);
      expect(workerMainIds.sort()).toEqual([Number(s1), Number(s2)].sort());

      const worker42Res = await app.request("/v1/sessions?limit=50&worker=42");
      expect(worker42Res.status).toBe(200);
      const worker42Json = (await worker42Res.json()) as { sessions: Array<{ id: number }>; total: number };
      expect(worker42Json.total).toBe(1);
      expect(worker42Json.sessions[0]?.id).toBe(Number(s4));

      // --- Filter combinations: archived=1 vs archived=all ---
      const archived1Res = await app.request("/v1/sessions?limit=50&archived=1");
      expect(archived1Res.status).toBe(200);
      const archived1Json = (await archived1Res.json()) as { sessions: Array<{ id: number }>; total: number };
      expect(archived1Json.total).toBe(1);
      expect(archived1Json.sessions[0]?.id).toBe(Number(s3));

      const archivedAllRes = await app.request("/v1/sessions?limit=50&archived=all");
      expect(archivedAllRes.status).toBe(200);
      const archivedAllJson = (await archivedAllRes.json()) as { sessions: Array<{ id: number }>; total: number };
      expect(archivedAllJson.total).toBe(5) /* "all 5 non-delegate sessions" */;

      // --- Search (q): case-insensitive AND across title, id, project name, default title ---
      // Search by project name token "alpha"
      const searchProjRes = await app.request("/v1/sessions?limit=50&q=Alpha");
      expect(searchProjRes.status).toBe(200);
      const searchProjJson = (await searchProjRes.json()) as { sessions: Array<{ id: number }> };
      // s4 is in Alpha project; s1 has "alpha" in title ("alpha search test")
      const searchProjIds = searchProjJson.sessions.map((s) => s.id);
      expect(searchProjIds.includes(Number(s4))).toBeTruthy();
      expect(searchProjIds.includes(Number(s1))).toBeTruthy();

      // Search by multi-token AND matching title
      const searchMultiRes = await app.request("/v1/sessions?limit=50&q=search%20test");
      expect(searchMultiRes.status).toBe(200);
      const searchMultiJson = (await searchMultiRes.json()) as { sessions: Array<{ id: number }> };
      expect(searchMultiJson.sessions.length).toBe(1);
      expect(searchMultiJson.sessions[0]?.id).toBe(Number(s1));

      // Search by session ID
      const searchIdRes = await app.request(`/v1/sessions?limit=50&q=${s5}`);
      expect(searchIdRes.status).toBe(200);
      const searchIdJson = (await searchIdRes.json()) as { sessions: Array<{ id: number }> };
      expect(searchIdJson.sessions.map((s) => s.id).includes(Number(s5))).toBeTruthy();
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await tmp.cleanup();
  }
});

test("opt-in GET /v1/sessions pagination protocol: running/reviewing filters, background notification tracking (running OR ids), and strict parameter validation", async () => {
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

      const s1 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      const s2 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      const s3 = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);

      // Put s2 into "reviewing" state via SessionReviewDoc
      await harness.commit(async (tx) => {
        await startSessionReview(tx, s2, "review-job-1", 1);
      }, context);

      // Query running=1: must match s2 because status is 'reviewing'
      const runningRes = await app.request("/v1/sessions?limit=50&running=1");
      expect(runningRes.status).toBe(200);
      const runningJson = (await runningRes.json()) as { sessions: Array<{ id: number; status: string }>; total: number };
      expect(runningJson.total).toBe(1);
      expect(runningJson.sessions[0]?.id).toBe(Number(s2));
      expect(runningJson.sessions[0]?.status).toBe("reviewing");

      // Query ids filter alone: exact metadata lookup
      const idsRes = await app.request(`/v1/sessions?limit=50&ids=${s1},${s3}`);
      expect(idsRes.status).toBe(200);
      const idsJson = (await idsRes.json()) as { sessions: Array<{ id: number }>; total: number };
      expect(idsJson.total).toBe(2);
      const foundIds = idsJson.sessions.map((s) => s.id).sort();
      expect(foundIds).toEqual([Number(s1), Number(s3)].sort());

      // Query ids AND running=1: union (running OR those ids) used by background notification tracking
      // Here s2 is reviewing/running, and ids target s1. Total should be s1 and s2.
      const unionRes = await app.request(`/v1/sessions?limit=50&ids=${s1}&running=1`);
      expect(unionRes.status).toBe(200);
      const unionJson = (await unionRes.json()) as { sessions: Array<{ id: number }>; total: number };
      expect(unionJson.total).toBe(2);
      const unionIds = unionJson.sessions.map((s) => s.id).sort();
      expect(unionIds).toEqual([Number(s1), Number(s2)].sort());

      const defaultTitle = await app.request(`/v1/sessions?limit=50&q=Conversation%20${s1}`);
      expect(defaultTitle.status).toBe(200);
      expect((await defaultTitle.json() as { sessions: { id: number }[] }).sessions.map(row => row.id)).toEqual([Number(s1)]) /* "untitled sessions must be searchable by their displayed default title" */;

      // --- Strict query validation 400 regressions ---
      // 1. Unknown query parameter
      const unknownRes = await app.request("/v1/sessions?limit=50&unknown=1");
      expect(unknownRes.status).toBe(400);

      // 2. Duplicate query parameter
      const dupRes = await app.request("/v1/sessions?limit=50&limit=20");
      expect(dupRes.status).toBe(400);

      // 3. Invalid limit: not integer, < 1, or > 100
      expect((await app.request("/v1/sessions?limit=0")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=101")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=abc")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=1.5")).status).toBe(400);

      // 4. Invalid archived filter
      expect((await app.request("/v1/sessions?limit=50&archived=2")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&archived=true")).status).toBe(400);

      // 5. Invalid project filter
      expect((await app.request("/v1/sessions?limit=50&project=0")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&project=-1")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&project=foo")).status).toBe(400);

      // 6. Invalid worker filter
      expect((await app.request("/v1/sessions?limit=50&worker=0")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&worker=-5")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&worker=worker1")).status).toBe(400);

      // 7. Invalid ids filter: non-integer, negative, empty element
      expect((await app.request("/v1/sessions?limit=50&ids=1,,2")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&ids=0")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&ids=foo")).status).toBe(400);

      // 8. Invalid running filter
      expect((await app.request("/v1/sessions?limit=50&running=0")).status).toBe(400);
      expect((await app.request("/v1/sessions?limit=50&running=true")).status).toBe(400);

      // 9. Malformed / noncanonical cursor
      // Not base64 / regex mismatch
      expect((await app.request("/v1/sessions?limit=50&cursor=$$$")).status).toBe(400);
      // Valid base64url but invalid json structure [pinned, activity, id]
      const badJsonCursor = Buffer.from(JSON.stringify({ not: "an array" }), "utf8").toString("base64url");
      expect((await app.request(`/v1/sessions?limit=50&cursor=${badJsonCursor}`)).status).toBe(400);
      // Array with invalid elements
      const badValuesCursor = Buffer.from(JSON.stringify([2, -1, 0]), "utf8").toString("base64url");
      expect((await app.request(`/v1/sessions?limit=50&cursor=${badValuesCursor}`)).status).toBe(400);
      // Non-canonical base64url encoding
      const nonCanonicalCursor = Buffer.from(JSON.stringify([0, 100, 1]), "utf8").toString("base64url") + "==";
      expect((await app.request(`/v1/sessions?limit=50&cursor=${nonCanonicalCursor}`)).status).toBe(400);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await tmp.cleanup();
  }
});

test("POST /v1/sessions/:id/read and POST /v1/sessions/read-all mark finished and review_finished sessions ready", async () => {
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
      const app = createApp({ harness, conversations, models });

      const createFinished = async (ts: number, archived = false) => {
        const id = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
        const boundary = await harness.commit(async (tx) => {
          const u = await tx.appendEntry(id, { kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: ts - 1 }] });
          await tx.appendEntry(id, { kind: "pi.assistant", model: [fauxAssistantMessage([fauxText("done")], { timestamp: ts })] });
          return Number(u.id);
        }, context);
        if (archived) await conversations.update(Number(id), { archived: true });
        return { id, boundary };
      };

      const { id: sFinished } = await createFinished(100);
      const { id: sReview, boundary: reviewBoundary } = await createFinished(100);
      await harness.commit(async (tx) => {
        await startSessionReview(tx, sReview, "rev-1", reviewBoundary);
      }, context);
      await harness.commit(async (tx) => {
        await finishSessionReview(tx, sReview, "rev-1");
      }, context);

      const sFailed = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await harness.commit(async (tx) => {
        await tx.appendEntry(sFailed, { kind: "pi.user", model: [{ role: "user", content: "fail", timestamp: 100 }] });
        await tx.appendEntry(sFailed, { kind: "pi.assistant", model: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom", timestamp: 101 })] });
      }, context);

      const sHandoff = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
      await harness.commit(async (tx) => {
        const u = await tx.appendEntry(sHandoff, { kind: "pi.user", model: [{ role: "user", content: "ask", timestamp: 100 }] });
        (await tx.doc(SessionHandoffDoc, sHandoff)).handoff = { status: "needs_approval", reason: "confirm", boundary: Number(u.id) };
      }, context);

      const { id: sBatchA } = await createFinished(100);
      const { id: sBatchB } = await createFinished(100);
      const { id: sArchived } = await createFinished(100, true);

      const statusMap = async () => {
        const res = await app.request("/v1/sessions?limit=50&archived=all");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { sessions: Array<{ id: number; status: string }> };
        return new Map(body.sessions.map((s) => [s.id, s.status]));
      };

      let statuses = await statusMap();
      expect(statuses.get(Number(sFinished))).toBe("finished");
      expect(statuses.get(Number(sReview))).toBe("review_finished");
      expect(statuses.get(Number(sFailed))).toBe("failed");
      expect(statuses.get(Number(sHandoff))).toBe("needs_approval");

      // 404 for unknown session
      expect((await app.request("/v1/sessions/999999/read", { method: "POST" })).status).toBe(404);

      // Single mark-read clears finished and review_finished to ready, and is idempotent
      const r1 = await app.request(`/v1/sessions/${sFinished}/read`, { method: "POST" });
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ ok: true, status: "ready", statusReason: null });
      const r1Again = await app.request(`/v1/sessions/${sFinished}/read`, { method: "POST" });
      expect(r1Again.status).toBe(200);
      expect(await r1Again.json()).toEqual({ ok: true, status: "ready", statusReason: null });

      const r2 = await app.request(`/v1/sessions/${sReview}/read`, { method: "POST" });
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({ ok: true, status: "ready", statusReason: null });

      // Failed and needs_approval are preserved by mark-read
      const rFail = await app.request(`/v1/sessions/${sFailed}/read`, { method: "POST" });
      expect(rFail.status).toBe(200);
      expect(await rFail.json()).toEqual({ ok: true, status: "failed", statusReason: "boom" });

      const rHandoff = await app.request(`/v1/sessions/${sHandoff}/read`, { method: "POST" });
      expect(rHandoff.status).toBe(200);
      expect(await rHandoff.json()).toEqual({ ok: true, status: "needs_approval", statusReason: "confirm" });

      statuses = await statusMap();
      expect(statuses.get(Number(sFinished))).toBe("ready");
      expect(statuses.get(Number(sReview))).toBe("ready");
      expect(statuses.get(Number(sFailed))).toBe("failed");
      expect(statuses.get(Number(sHandoff))).toBe("needs_approval");

      // Validation errors on read-all
      expect((await app.request("/v1/sessions/read-all", { method: "POST", body: "not-json" })).status).toBe(400);
      expect((await app.request("/v1/sessions/read-all", { method: "POST", body: JSON.stringify({ extra: 1 }) })).status).toBe(400);
      expect((await app.request("/v1/sessions/read-all", { method: "POST", body: JSON.stringify({ ids: [0] }) })).status).toBe(400);

      // Targeted read-all updates only the listed finished sessions and ignores unknown/non-finished ids
      const batchRes = await app.request("/v1/sessions/read-all", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [Number(sBatchA), Number(sFailed), 999999] }),
      });
      expect(batchRes.status).toBe(200);
      expect(await batchRes.json()).toEqual({ ok: true, count: 1, ids: [Number(sBatchA)] });

      statuses = await statusMap();
      expect(statuses.get(Number(sBatchA))).toBe("ready");
      expect(statuses.get(Number(sBatchB))).toBe("finished");
      expect(statuses.get(Number(sFailed))).toBe("failed");

      // Empty read-all marks all remaining unarchived finished sessions read, leaving archived untouched
      const allRes = await app.request("/v1/sessions/read-all", { method: "POST" });
      expect(allRes.status).toBe(200);
      expect(await allRes.json()).toEqual({ ok: true, count: 1, ids: [Number(sBatchB)] });

      statuses = await statusMap();
      expect(statuses.get(Number(sBatchB))).toBe("ready");
      expect(statuses.get(Number(sArchived))).toBe("finished");
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await tmp.cleanup();
  }
});
