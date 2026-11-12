import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";

async function makeTempDb() {
  const dir = await mkdtemp(join(tmpdir(), "luna-session-del-test-"));
  const dbPath = join(dir, "luna.db");
  return {
    dir,
    dbPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("session lifecycle: create, send message, prime GET detail, DELETE returns 200, GET returns 404, list excludes deleted, existing session readable", async () => {
  const tmp = await makeTempDb();
  try {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxText("reply 1")]),
      fauxAssistantMessage([fauxText("reply 2")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();

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
        agent: { model: { provider: model.provider, modelId: model.id } },
      });

      // 1. Create two sessions via POST /v1/sessions
      const createRes1 = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(createRes1.status).toBe(201);
      const session1 = (await createRes1.json()) as { id: number };
      const s1Id = session1.id;

      const createRes2 = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(createRes2.status).toBe(201);
      const session2 = (await createRes2.json()) as { id: number };
      const s2Id = session2.id;

      // 2. Send message via HTTP to both sessions and wait for completion
      const msgRes1 = await app.request(`/v1/sessions/${s1Id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello s1" }),
      });
      expect(msgRes1.status).toBe(200);
      const msgBody1 = (await msgRes1.json()) as { status: string; answer: string };
      expect(msgBody1.status).toBe("done");
      expect(msgBody1.answer).toBe("reply 1");

      const msgRes2 = await app.request(`/v1/sessions/${s2Id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello s2" }),
      });
      expect(msgRes2.status).toBe(200);
      const msgBody2 = (await msgRes2.json()) as { status: string; answer: string };
      expect(msgBody2.status).toBe("done");
      expect(msgBody2.answer).toBe("reply 2");

      // 3. Prime GET detail BEFORE delete
      const primeRes = await app.request(`/v1/sessions/${s1Id}`);
      expect(primeRes.status).toBe(200);
      const primeBody = (await primeRes.json()) as { id: number };
      expect(primeBody.id).toBe(s1Id);

      // 4. DELETE returns 200
      const delRes = await app.request(`/v1/sessions/${s1Id}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      const delBody = (await delRes.json()) as { deleted: number[] };
      expect(delBody).toEqual({ deleted: [s1Id] });

      // 5. Subsequent GET detail returns 404
      const afterGetRes = await app.request(`/v1/sessions/${s1Id}`);
      expect(afterGetRes.status).toBe(404);

      // 6. List excludes deleted session
      const listRes = await app.request("/v1/sessions");
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { sessions: Array<{ id: number }> };
      const sessionIds = listBody.sessions.map((s) => s.id);
      expect(!sessionIds.includes(s1Id)).toBeTruthy() /* "deleted session must not be present in session list" */;
      expect(sessionIds.includes(s2Id)).toBeTruthy() /* "session 2 must remain in session list" */;

      // 7. Another existing session remains readable
      const s2GetRes = await app.request(`/v1/sessions/${s2Id}`);
      expect(s2GetRes.status).toBe(200);
      const s2Body = (await s2GetRes.json()) as { id: number };
      expect(s2Body.id).toBe(s2Id);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await tmp.cleanup();
  }
});

test("invalid session IDs return 404 without crashing", async () => {
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

      const invalidIds = ["abc", "0", "-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1)];

      for (const id of invalidIds) {
        // GET detail
        const getRes = await app.request(`/v1/sessions/${id}`);
        expect(getRes.status).toBe(404) /* `GET /v1/sessions/${id} should return 404` */;
        const getBody = (await getRes.json()) as { error: string };
        expect(getBody.error).toBe("no such session");

        // DELETE
        const delRes = await app.request(`/v1/sessions/${id}`, { method: "DELETE" });
        expect(delRes.status).toBe(404) /* `DELETE /v1/sessions/${id} should return 404` */;
        const delBody = (await delRes.json()) as { error: string };
        expect(delBody.error).toBe("no such session");
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await tmp.cleanup();
  }
});
