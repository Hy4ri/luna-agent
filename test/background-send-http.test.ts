import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { BackgroundCommandStore } from "../src/background-command.js";
import { conversationStorage } from "../src/conversation-storage.js";

function setupFauxModels() {
  const faux = fauxProvider({
    models: [
      { id: "gpt-4o-mini", reasoning: false },
      { id: "o3-mini", reasoning: true },
    ],
  });
  faux.setResponses([
    () => fauxAssistantMessage("ack"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

test("draft execution defaults resolve without session creation or side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-bg-defaults-"));
  const p1Dir = join(dir, "project-p1");
  const defaultDir = join(dir, "default-daemon-cwd");
  const customDir = join(dir, "custom-cwd");
  mkdirSync(p1Dir, { recursive: true });
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(customDir, { recursive: true });

  const { models } = setupFauxModels();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });

  try {
    const conversations = new ConversationStore(harness);
    const p1 = conversations.projects.create("p1", p1Dir);
    const app = createApp({ harness, conversations, models, cwd: defaultDir });

    // 1. Plain default
    const resDefault = await app.request("/v1/session-defaults");
    expect(resDefault.status).toBe(200);
    expect(await resDefault.json()).toEqual({ worker: null, cwd: defaultDir });

    // 2. Project cwd resolution
    const resProj = await app.request(`/v1/session-defaults?project=${p1.id}`);
    expect(resProj.status).toBe(200);
    expect(await resProj.json()).toEqual({ worker: null, cwd: p1Dir });

    // 3. Explicit cwd overrides project cwd
    const resOverride = await app.request(`/v1/session-defaults?project=${p1.id}&cwd=${customDir}`);
    expect(resOverride.status).toBe(200);
    expect(await resOverride.json()).toEqual({ worker: null, cwd: customDir });

    // 4. Invalid project returns 400
    const resBadProj = await app.request("/v1/session-defaults?project=99999");
    expect(resBadProj.status).toBe(400);

    // 5. Read-only verification: no conversations were created
    const sessionList = await app.request("/v1/sessions");
    expect(sessionList.status).toBe(200);
    const sessionListBody = (await sessionList.json()) as { sessions: unknown[] };
    expect(sessionListBody.sessions.length).toBe(0) /* "session-defaults must be read-only and create no sessions" */;
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session creation requestId idempotency, lookup, deletion persistence, and reopen durability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-bg-sessions-"));
  const alphaDir = join(dir, "alpha");
  mkdirSync(alphaDir, { recursive: true });

  const { models } = setupFauxModels();
  const dbPath = join(dir, "luna.db");

  let s1Id: number;
  const req1 = "req-create-111";
  const req2 = "req-create-222";

  // Phase 1: create sessions and test idempotency
  {
    const harness = await openLuna({ dbPath, models, memory: false, coding: false });
    try {
      const conversations = new ConversationStore(harness);
      const proj = conversations.projects.create("alpha-proj", alphaDir);
      const app = createApp({ harness, conversations, models });

      // Non-existent session creation receipt before creation
      const preLookup = await app.request(`/v1/session-creations/${req1}`);
      expect(preLookup.status).toBe(404);

      // Create session 1 with requestId
      const payload1 = {
        requestId: req1,
        // A reasoning model, so the requested level is stored unclamped.
        model: { provider: "faux", modelId: "o3-mini" },
        thinkingLevel: "low",
        project: proj.id,
      };
      const createRes1 = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload1),
      });
      expect(createRes1.status).toBe(201);
      const body1 = (await createRes1.json()) as { id: number };
      s1Id = body1.id;
      expect(typeof s1Id === "number" && s1Id > 0).toBeTruthy();

      // Session record: verify no ownership/source relationship (ownerless)
      const convRecord = await harness.commit((tx) => tx.conversation(s1Id as never), context);
      expect(convRecord).toBeTruthy() /* "session record exists" */;
      expect(convRecord.owner).toBe(undefined) /* "session must have no owner task / source ownership" */;

      // Verify exact settings and project linkage
      const sessionDetail = await app.request(`/v1/sessions/${s1Id}`);
      expect(sessionDetail.status).toBe(200);
      const configured = await (await harness.conversation(s1Id as never, context))!.agent(context);
      expect(configured.model).toEqual(payload1.model);
      expect(configured.thinkingLevel).toBe("low");
      expect(configured.cwd).toBe(alphaDir);
      expect(conversations.projects.projectOf(s1Id)).toBe(proj.id);

      // Replay identical POST returns same session id (200 or 201)
      const replayRes = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload1),
      });
      expect([200, 201].includes(replayRes.status)).toBeTruthy();
      expect(await replayRes.json()).toEqual({ id: s1Id });

      // Conflicting payload with same requestId returns 409
      const conflictRes = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload1, thinkingLevel: "high" }),
      });
      expect(conflictRes.status).toBe(409);

      // Lookup created session identity via GET /v1/session-creations/:requestId
      const lookupRes = await app.request(`/v1/session-creations/${req1}`);
      expect(lookupRes.status).toBe(200);
      expect(await lookupRes.json()).toEqual({ id: s1Id });

      // Distinct requestId creates distinct session
      const createRes2 = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: req2 }),
      });
      expect(createRes2.status).toBe(201);
      const s2Id = ((await createRes2.json()) as { id: number }).id;
      expect(s2Id).not.toBe(s1Id) /* "distinct requestIds must create distinct sessions" */;

      const concurrent = await Promise.all(Array.from({ length: 3 }, () => app.request("/v1/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "concurrent-create", cwd: alphaDir }),
      })));
      expect(concurrent.every(response => response.status === 201 || response.status === 200)).toBeTruthy();
      const concurrentIds = await Promise.all(concurrent.map(response => response.json() as Promise<{ id: number }>));
      expect(new Set(concurrentIds.map(row => row.id)).size).toBe(1) /* "concurrent creation is atomic" */;

      const submission = await app.request(`/v1/sessions/${s1Id}/messages?async=1`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "recover-message", content: "hello" }),
      });
      expect(submission.status).toBe(202);
      const admitted = await submission.json() as { submissionId: number };
      const recovered = await app.request(`/v1/sessions/${s1Id}/submissions/by-request/recover-message`);
      expect(recovered.status).toBe(200);
      expect((await recovered.json() as { id: number }).id).toBe(admitted.submissionId);
      // Deletion requires an idle conversation, even if shutdown interrupted a run.
      await (await harness.conversation(s1Id as never, context))!.abort(context);
    } finally {
      await harness.close(context);
    }
  }

  // Phase 2: reopen harness; verify persisted identity and deletion behavior
  {
    const harness = await openLuna({ dbPath, models, memory: false, coding: false });
    try {
      const conversations = new ConversationStore(harness);
      const app = createApp({ harness, conversations, models });

      // Lookup across reopen
      const lookupReopen = await app.request(`/v1/session-creations/${req1}`);
      expect(lookupReopen.status).toBe(200);
      expect(await lookupReopen.json()).toEqual({ id: s1Id });
      const replayAfterRestart = await app.request("/v1/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: req1, model: { provider: "faux", modelId: "o3-mini" }, thinkingLevel: "low", project: conversations.projects.projectOf(s1Id) }),
      });
      expect(replayAfterRestart.ok).toBeTruthy();
      expect(await replayAfterRestart.json()).toEqual({ id: s1Id });
      const recovered = await app.request(`/v1/sessions/${s1Id}/submissions/by-request/recover-message`);
      expect(recovered.status).toBe(200);

      // Ordinary submission receipt lookup on session
      // Submission by non-existent request returns 404
      const absentSub = await app.request(`/v1/sessions/${s1Id}/submissions/by-request/no-such-req`);
      expect(absentSub.status).toBe(404);

      // Delete the session
      const delRes = await app.request(`/v1/sessions/${s1Id}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);

      // GET /v1/session-creations/:requestId for deleted session returns 410
      const lookupDel = await app.request(`/v1/session-creations/${req1}`);
      expect(lookupDel.status).toBe(410);

      // Deleted session identity never recreates; attempting to POST with same requestId returns 409 or 410
      const recreateRes = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: req1 }),
      });
      expect([409, 410].includes(recreateRes.status)).toBeTruthy() /* "deleted session identity never recreates" */;
    } finally {
      await harness.close(context);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("background command execution, replay idempotency, conflict rejection, and receipt lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-bg-commands-"));
  const { models } = setupFauxModels();
  const dbPath = join(dir, "luna.db");

  const harness = await openLuna({ dbPath, models, memory: false, coding: false });
  try {
    const conversations = new ConversationStore(harness);
    const app = createApp({ harness, conversations, models });

    // Create a target session
    const createRes = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(201);
    const sessionId = ((await createRes.json()) as { id: number }).id;

    const cmdReqId = "bg-cmd-abc-123";

    // Non-existent command receipt returns 404
    const absentReceipt = await app.request(`/v1/sessions/${sessionId}/background-commands/${cmdReqId}`);
    expect(absentReceipt.status).toBe(404);

    // Non-slash command rejected with 400
    const nonSlashRes = await app.request(`/v1/sessions/${sessionId}/background-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "non-slash", content: "hello world" }),
    });
    expect(nonSlashRes.status).toBe(400);

    // Immediate safe slash command: /queue list
    const cmdPayload = { requestId: cmdReqId, content: "/queue list" };
    const cmdRes = await app.request(`/v1/sessions/${sessionId}/background-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cmdPayload),
    });
    expect(cmdRes.status).toBe(200);
    const cmdResult = await cmdRes.json();
    expect(cmdResult).toBeTruthy() /* "immediate safe command returns result" */;

    // Command receipt lookup returns { state: "done", status, result }
    const receiptRes = await app.request(`/v1/sessions/${sessionId}/background-commands/${cmdReqId}`);
    expect(receiptRes.status).toBe(200);
    const receipt = (await receiptRes.json()) as { state: string; status: number; result: unknown };
    expect(receipt.state).toBe("done");
    expect(receipt.status).toBe(200);
    expect(receipt.result).toEqual(cmdResult);

    // Identical replay returns saved response without duplicate execution
    const replayCmdRes = await app.request(`/v1/sessions/${sessionId}/background-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cmdPayload),
    });
    expect(replayCmdRes.status).toBe(200);
    expect(await replayCmdRes.json()).toEqual(cmdResult);

    // Conflicting payload with same requestId rejects with 409
    const conflictCmdRes = await app.request(`/v1/sessions/${sessionId}/background-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: cmdReqId, content: "/clear" }),
    });
    expect(conflictCmdRes.status).toBe(409);

    // Concurrent identical invocations resolve consistently
    const concReqId = "bg-cmd-conc-456";
    const concPayload = { requestId: concReqId, content: "/queue list" };
    const [conc1, conc2] = await Promise.all([
      app.request(`/v1/sessions/${sessionId}/background-commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(concPayload),
      }),
      app.request(`/v1/sessions/${sessionId}/background-commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(concPayload),
      }),
    ]);
    expect(conc1.status).toBe(200);
    expect(conc2.status).toBe(200);
    expect(await conc1.json()).toEqual(await conc2.json());

    // Simulate a crash after durable command admission, before a response was saved.
    const store = new BackgroundCommandStore(conversationStorage(harness).db);
    await harness.commit(() => store.claim(sessionId, "interrupted", "/queue list"), context);
    const interrupted = await app.request(`/v1/sessions/${sessionId}/background-commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "interrupted", content: "/queue list" }),
    });
    expect(interrupted.status).toBe(409);
    expect((await interrupted.json() as { error: string }).error).toMatch(/uncertain/);
    const pending = await app.request(`/v1/sessions/${sessionId}/background-commands/interrupted`);
    expect(await pending.json()).toEqual({ state: "pending" });
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
