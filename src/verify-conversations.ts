import { DatabaseSync } from "node:sqlite";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { SessionCreated } from "./session-activity.js";
import { RecallIndex } from "./recall.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const dir = mkdtempSync(join(process.cwd(), ".conversations-test-"));
try {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  
  const faux = fauxProvider({ models: [{ id: "main" }] });
  faux.setResponses([() => fauxAssistantMessage([fauxText("hello from faux")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const m = faux.getModel();

  const rt = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
  try {
    const app = createApp({
      harness: rt.harness,
      models: rt.models,
      providers: rt.providers,
      settings: rt.settings,
      conversations: rt.conversations,
      agent: { model: { provider: m.provider, modelId: m.id } },
      token: "secret-token"
    });

    const headers = { authorization: "Bearer secret-token", "content-type": "application/json" };

    // 1. Auth check
    const unauthRes = await app.request("/v1/sessions");
    assert.equal(unauthRes.status, 401);

    // 2. Create some conversations and check listing & sorting (pinned first, last message activity, descending ID for ties)
    const creationStart = Date.now();
    const s1Res = await app.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({}) });
    assert.equal(s1Res.status, 201);
    const s1 = await s1Res.json() as { id: number };

    const s2Res = await app.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({}) });
    assert.equal(s2Res.status, 201);
    const s2 = await s2Res.json() as { id: number };

    const emptyList = (await (await app.request("/v1/sessions", { headers })).json() as { sessions: any[] }).sessions;
    assert.deepEqual(emptyList.map(s => s.id), [s2.id, s1.id], "empty sessions use descending ID ties");
    assert.ok(emptyList.every(s => s.lastActivity === null), "empty sessions have no message activity");
    assert.ok(emptyList.every(s => typeof s.createdAt === "number" && s.createdAt >= creationStart && s.createdAt <= Date.now()));
    const s2CreatedAt = emptyList.find(s => s.id === s2.id).createdAt;

    // Pin s1
    const pinRes = await app.request(`/v1/sessions/${s1.id}/metadata`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ pinned: true, title: "Session One" })
    });
    assert.equal(pinRes.status, 200);

    // Set title for s2 and archive it
    const s2MetaRes = await app.request(`/v1/sessions/${s2.id}/metadata`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ archived: true, title: "Session Two" })
    });
    assert.equal(s2MetaRes.status, 200);

    // List sessions
    const listRes = await app.request("/v1/sessions", { headers });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json() as { sessions: any[] };
    assert.ok(listBody.sessions.length >= 2);
    // Pinned session should be first
    assert.equal(listBody.sessions[0].id, s1.id);
    assert.equal(listBody.sessions[0].pinned, true);
    assert.equal(listBody.sessions[0].title, "Session One");

    // Message activity is durable and independent of metadata and later bookkeeping entries.
    const conv2 = (await rt.harness.conversation(s2.id as never, context))!;
    const activityStart = Date.now();
    const sent = await app.request(`/v1/sessions/${s2.id}/messages`, { method: "POST", headers, body: JSON.stringify({ content: "activity test" }) });
    assert.equal(sent.status, 200);
    assert.equal((await sent.json() as { status: string }).status, "done");
    const entries = (await conv2.entries({ order: "descending" }, 50, undefined, context)).items;
    const times = entries.filter(e => e.kind === "pi.user" || e.kind === "pi.assistant")
      .flatMap(e => (e.model ?? []).filter(m => m.role === "user" || m.role === "assistant").map(m => m.timestamp));
    assert.ok(times.length >= 2, "both user and assistant messages must exist");
    const expectedActivity = Math.max(...times);
    assert.ok(expectedActivity >= activityStart);
    const sessions = async () => (await (await app.request("/v1/sessions", { headers })).json() as { sessions: any[] }).sessions;
    assert.equal((await sessions()).find(s => s.id === s2.id).lastActivity, expectedActivity);
    assert.equal((await sessions())[0].id, s1.id, "pin outranks more recent activity");
    for (const metadata of [{ title: "Activity rename" }, { pinned: true }, { archived: false }]) {
      assert.equal((await app.request(`/v1/sessions/${s2.id}/metadata`, { method: "PATCH", headers, body: JSON.stringify(metadata) })).status, 200);
      assert.equal((await sessions()).find(s => s.id === s2.id).lastActivity, expectedActivity, "metadata must not change last activity");
      assert.equal((await sessions()).find(s => s.id === s2.id).createdAt, s2CreatedAt, "metadata must not change creation time");
    }
    // Restore the original fixture state for the persistence and deletion scenarios below.
    assert.equal((await app.request(`/v1/sessions/${s2.id}/metadata`, { method: "PATCH", headers, body: JSON.stringify({ title: "Session Two", pinned: false, archived: true }) })).status, 200);
    await conv2.commit(async tx => {
      for (let i = 0; i < 205; i++) await tx.appendEntry(conv2.id, { kind: "test.bookkeeping", data: { timestamp: expectedActivity + 10000, i } });
    }, context);
    assert.equal((await sessions()).find(s => s.id === s2.id).lastActivity, expectedActivity, "message scan must continue beyond the first page and ignore bookkeeping times");

    // A newly created empty session sorts above older message activity, but below pins.
    const emptyStart = Date.now();
    const newEmpty = await (await app.request("/v1/sessions", { method: "POST", headers, body: "{}" })).json() as { id: number };
    const withEmpty = await sessions();
    assert.deepEqual(withEmpty.slice(0, 2).map(s => s.id), [s1.id, newEmpty.id]);
    const emptyMeta = withEmpty.find(s => s.id === newEmpty.id);
    assert.equal(emptyMeta.lastActivity, null);
    assert.ok(emptyMeta.createdAt >= emptyStart && emptyMeta.createdAt <= Date.now());
    // Simulate an older database without a recorded creation time. A GET must not invent one.
    await rt.harness.commit(tx => tx.retireDoc(SessionCreated, newEmpty.id as never), context);
    assert.equal((await sessions()).find(s => s.id === newEmpty.id).createdAt, null);
    assert.equal((await sessions()).find(s => s.id === newEmpty.id).createdAt, null);
    assert.equal((await app.request(`/v1/sessions/${newEmpty.id}`, { method: "DELETE", headers })).status, 200);
    const forkStart = Date.now();
    const activityFork = await conv2.fork(entries[0]!.id, { ownership: { kind: "ownerless" } }, context);
    const forkMeta = (await sessions()).find(s => s.id === activityFork.id);
    assert.ok(forkMeta.createdAt >= forkStart && forkMeta.createdAt <= Date.now(), "fork has its own creation time");
    assert.notEqual(forkMeta.createdAt, s2CreatedAt);
    assert.equal((await app.request(`/v1/sessions/${activityFork.id}`, { method: "DELETE", headers })).status, 200);

    // 3. Invalid metadata payload tests
    const badMeta1 = await app.request(`/v1/sessions/${s1.id}/metadata`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ unknownKey: true })
    });
    assert.equal(badMeta1.status, 400);

    const badMeta2 = await app.request(`/v1/sessions/${s1.id}/metadata`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "" })
    });
    assert.equal(badMeta2.status, 400);

    const badMeta3 = await app.request(`/v1/sessions/${s1.id}/metadata`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "a".repeat(201) })
    });
    assert.equal(badMeta3.status, 400);

    const badMeta4 = await app.request(`/v1/sessions/${s1.id}/metadata`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ archived: "yes" })
    });
    assert.equal(badMeta4.status, 400);

    const missingSessionMeta = await app.request("/v1/sessions/999999/metadata", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ pinned: true })
    });
    assert.equal(missingSessionMeta.status, 404);

    // 4. Persistence after runtime restart
    await rt.close();

    const rt2 = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
    try {
      const app2 = createApp({
        harness: rt2.harness,
        models: rt2.models,
        providers: rt2.providers,
        settings: rt2.settings,
        conversations: rt2.conversations,
        token: "secret-token"
      });
      const listRes2 = await app2.request("/v1/sessions", { headers });
      const listBody2 = await listRes2.json() as { sessions: any[] };
      const persistedS1 = listBody2.sessions.find(s => s.id === s1.id);
      assert.ok(persistedS1);
      assert.equal(persistedS1.pinned, true);
      assert.equal(persistedS1.title, "Session One");

      const persistedS2 = listBody2.sessions.find(s => s.id === s2.id);
      assert.ok(persistedS2);
      assert.equal(persistedS2.archived, true);
      assert.equal(persistedS2.title, "Session Two");
      assert.equal(persistedS2.lastActivity, expectedActivity, "message activity survives runtime restart");
      assert.equal(persistedS2.createdAt, s2CreatedAt, "creation time survives runtime restart");

      // 5. Hard deletion tests (including fork/child rows, recall data, busy rejection, unrelated preservation, repeated delete 404)
      const unrelatedRes = await app2.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({}) });
      const unrelated = await unrelatedRes.json() as { id: number };

      // Delete s2
      const delS2 = await app2.request(`/v1/sessions/${s2.id}`, { method: "DELETE", headers });
      assert.equal(delS2.status, 200);

      // Repeated delete should be 404
      const delS2Again = await app2.request(`/v1/sessions/${s2.id}`, { method: "DELETE", headers });
      assert.equal(delS2Again.status, 404);

      // GET individual deleted session should be 404
      const getS2 = await app2.request(`/v1/sessions/${s2.id}`, { headers });
      assert.equal(getS2.status, 404);

      // Unrelated conversation must still work
      const getUnrelated = await app2.request(`/v1/sessions/${unrelated.id}`, { headers });
      assert.equal(getUnrelated.status, 200);

      // Prove the listing does not silently truncate older pinned conversations.
      for (let i = 0; i < 105; i++) {
        const r = await app2.request("/v1/sessions", { method: "POST", headers, body: "{}" });
        assert.equal(r.status, 201);
      }
      const many = await (await app2.request("/v1/sessions", { headers })).json() as { sessions: any[] };
      assert.equal(many.sessions.length, 107);
      assert.equal(many.sessions[0].id, s1.id);
      for (const payload of [{}, [], null, { pinned: 1 }, { title: "  " }, { title: false }]) {
        const res = await app2.request(`/v1/sessions/${s1.id}/metadata`, { method: "PATCH", headers, body: JSON.stringify(payload) });
        assert.equal(res.status, 400);
      }
      assert.equal((await app2.request(`/v1/sessions/${s1.id}`, { method: "DELETE" })).status, 401);
      assert.equal((await app2.request(`/v1/sessions/${s1.id}/metadata`, { method: "PATCH", body: '{"pinned":false}' })).status, 401);
      const parent = (await rt2.harness.conversation(s1.id as never, context))!;
      // Real delegate tools create real owned descendants and terminal task/submission records.
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("delegate_task", { action: "spawn", task: "child searchable deletionneedle" })], { stopReason: "toolUse" }),
        ...Array(6).fill(fauxAssistantMessage("deletionneedle response")),
      ]);
      const sub = await parent.submit({ type: "input", content: "parent deletionneedle" }, context);
      assert.equal((await sub.wait(context)).status, "done"); await rt2.harness.waitForIdle(context);
      const entry = (await parent.entries({}, 1, undefined, context)).items[0]!;
      const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
      const nested = await fork.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
      await rt2.conversations.update(fork.id, { title: "Fork to purge", pinned: true });
      const Doc = defineDoc({ kind: "test.delete-cache", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ text: "" }) });
      const Family = defineDocFamily({ kind: "test.delete-family", version: 1, scope: "conversation", history: "rewindable", fork: "asOf", family: true, initial: () => ({ text: "" }) });
      await parent.commit(async tx => {
        (await tx.doc(Doc, parent.id)).text = "cached deletionneedle";
        (await tx.doc(Family, parent.id, "key", null)).text = "family deletionneedle";
      }, context);
      assert.equal((await rt2.harness.snapshot(Doc, parent.id, context))?.text, "cached deletionneedle");
      const index = new RecallIndex(join(dir, "recall.db"));
      const db = new DatabaseSync(join(dir, "luna.db"));
      try {
        await rt2.harness.commit(tx => index.sync(tx), context);
        assert.ok(index.search("deletionneedle").length > 0);
        const owned = db.prepare("SELECT conversation_id AS id FROM entries WHERE json_extract(record, '$.kind')='delegate.child' AND json_extract(record, '$.data.parent')=?").all(parent.id) as { id: number }[];
        assert.ok(owned.length > 0, "real delegated child required");
        const ids = [parent.id, fork.id, nested.id, ...owned.map(r => r.id)];
        const placeholders = ids.map(() => "?").join(",");
        const docIds = (db.prepare(`SELECT id FROM documents WHERE (scope_kind='conversation' AND owner_id IN (${placeholders})) OR (scope_kind='task' AND owner_id IN (SELECT id FROM tasks WHERE conversation_id IN (${placeholders})))`).all(...ids, ...ids) as { id: number }[]).map(r => r.id);
        assert.ok(docIds.length > 0);
        // Keep a fork actively generating: parent deletion must reject the entire tree without changing its records.
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>(r => release = r), entered = new Promise<void>(r => started = r);
        faux.setResponses([async () => { started(); await gate; return fauxAssistantMessage("finished"); }]);
        const active = await fork.submit({ type: "input", content: "busy fork" }, context); await entered;
        const before = db.prepare("SELECT count(*) AS n FROM documents").get();
        const rejected = await app2.request(`/v1/sessions/${parent.id}`, { method: "DELETE", headers });
        assert.equal(rejected.status, 409);
        assert.deepEqual(db.prepare("SELECT count(*) AS n FROM documents").get(), before);
        assert.equal((await app2.request(`/v1/sessions/${fork.id}`, { headers })).status, 200);
        release(); await active.wait(context); await rt2.harness.waitForIdle(context);
        const deleted = await app2.request(`/v1/sessions/${parent.id}`, { method: "DELETE", headers });
        assert.equal(deleted.status, 200, await deleted.clone().text());
        const receipt = await deleted.json() as { deleted: number[] };
        assert.deepEqual(new Set(receipt.deleted), new Set(ids));
        for (const id of ids) {
          assert.equal((await app2.request(`/v1/sessions/${id}`, { headers })).status, 404);
          for (const [table, column] of [["conversations", "id"], ["entries", "conversation_id"], ["tasks", "conversation_id"], ["submissions", "conversation_id"], ["luna_conversations", "id"]]) {
            assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(id) as { n: number }).n, 0, `${table} for ${id}`);
          }
          assert.equal(index.messages(id).total, 0);
        }
        for (const id of docIds) {
          assert.equal(db.prepare("SELECT id FROM documents WHERE id=?").get(id), undefined);
          assert.equal(db.prepare("SELECT document_id FROM document_revisions WHERE document_id=?").get(id), undefined);
          assert.equal(db.prepare("SELECT id FROM record_ids WHERE id=?").get(id), undefined);
        }
        assert.equal(await rt2.harness.snapshot(Doc, parent.id, context), undefined, "deleted cache must not survive");
        assert.equal(await rt2.harness.snapshot(Family, parent.id, "key", context), undefined);
        assert.deepEqual(index.search("deletionneedle"), []);
        // Crash recovery: an orphaned search row must be pruned on the next sync.
        index.db.prepare("INSERT INTO convs(id,title,last_entry) VALUES (?,?,0)").run(parent.id, "stale index");
        await rt2.harness.commit(tx => index.sync(tx), context);
        assert.equal(index.db.prepare("SELECT id FROM convs WHERE id=?").get(parent.id), undefined);
        await assert.rejects(() => parent.submit({ type: "input", content: "cannot revive" }, context));
      } finally { db.close(); index.close(); }
      // A subsequent runtime cannot restore deleted history, but unrelated history remains usable.
      await rt2.close();
      const rt3 = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
      try {
        const app3 = createApp({ harness: rt3.harness, conversations: rt3.conversations });
        assert.equal((await app3.request(`/v1/sessions/${s1.id}`)).status, 404);
        faux.setResponses([fauxAssistantMessage("unrelated still works")]);
        const other = (await rt3.harness.conversation(unrelated.id as never, context))!;
        const s = await other.submit({ type: "input", content: "unrelated retained" }, context);
        assert.equal((await s.wait(context)).status, "done");
      } finally { await rt3.close(); }
      // The reserved CLI root can be recreated, but its old cached context and documents must not return.
      const rt4 = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
      try {
        const root = await rt4.harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });
        faux.setResponses([fauxAssistantMessage("root old text")]);
        const old = await root.submit({ type: "input", content: "oldrootsecret" }, context); await old.wait(context);
        await rt4.harness.waitForIdle(context);
        await rt4.conversations.delete(root.id);
        const fresh = await rt4.harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });
        faux.setResponses([(ctx) => {
          assert.ok(!JSON.stringify(ctx.messages).includes("oldrootsecret"));
          return fauxAssistantMessage("fresh root");
        }]);
        const again = await fresh.submit({ type: "input", content: "new root" }, context);
        const againState = await again.wait(context); assert.equal(againState.status, "done", JSON.stringify(againState));
        // Force a failure during the final purge. Retirement and SQL deletion must roll back together.
        const check = new DatabaseSync(join(dir, "luna.db"));
        check.exec("CREATE TRIGGER block_conversation_purge BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'purge test failure'); END;");
        const before = check.prepare("SELECT count(*) AS n FROM documents WHERE retired_at IS NULL").get();
        await assert.rejects(() => rt4.conversations.delete(fresh.id), /purge test failure/);
        assert.ok(check.prepare("SELECT id FROM conversations WHERE id=?").get(fresh.id));
        assert.deepEqual(check.prepare("SELECT count(*) AS n FROM documents WHERE retired_at IS NULL").get(), before);
        check.exec("DROP TRIGGER block_conversation_purge"); check.close();
      } finally { try { await rt4.close(); } catch {} }
      console.log("CONVERSATIONS_OK: metadata, validation, auth, 100+ listing, restart, real descendants/forks, busy rejection, hard purge, cache/index cleanup");
    } finally {
      try { await rt2.close(); } catch {}
    }
  } finally {
    try { await rt.close(); } catch {}
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
