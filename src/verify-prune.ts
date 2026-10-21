import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context, ProcessOwner } from "./luna.js";
import { DatabaseSync } from "node:sqlite";
import { SideCommands } from "./side-commands.js";
import { SessionCreated } from "./session-activity.js";

const dir = mkdtempSync(join(tmpdir(), "luna-prune-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux", processes: { enabled: true } }, dir, {}), { models, model });
try {
  const sideCommands = new SideCommands({ harness: rt.harness, models });
  const app = createApp({ sideCommands, harness: rt.harness, conversations: rt.conversations, agent: { model }, token: "test" });
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  const request = (path: string, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const old = Date.now() - 10 * 86400000;
  const create = async (archived = false) => {
    const response = await request("/v1/sessions", {});
    assert.equal(response.status, 201);
    const { id } = await response.json() as { id: number };
    await rt.harness.commit(async tx => { (await tx.doc(SessionCreated, id as never)).at = old; }, context);
    if (archived) await rt.conversations.update(id, { archived });
    return id;
  };
  const stale = await create(), archived = await create(true), current = await create(), recent = await create();
  await rt.harness.commit(tx => tx.appendEntry(recent as never, { kind: "pi.user", model: [{ role: "user", content: "recent", timestamp: Date.now() }] }), context);
  const body = { days: 7, includeArchived: false, excludeIds: [current] };
  const preview = await request("/v1/sessions/prune/preview", body);
  assert.equal(preview.status, 200, "prune preview must exist");
  const { ids } = await preview.json() as { ids: number[] };
  assert.deepEqual(ids, [stale]);
  assert.equal((await app.request(`/v1/sessions/${stale}`, { headers })).status, 200, "preview does not delete");
  const deleted = await request("/v1/sessions/prune", { ...body, ids });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json() as { deleted: number[] }).deleted, [stale]);
  assert.equal((await app.request(`/v1/sessions/${stale}`, { headers })).status, 404);
  for (const id of [archived, current, recent]) assert.equal((await app.request(`/v1/sessions/${id}`, { headers })).status, 200);
  // Confirmation must recheck activity and metadata, and must not pick up new unpreviewed sessions.
  const changed = await create(), newlyArchived = await create(), notConfirmed = await create();
  await rt.harness.commit(tx => tx.appendEntry(changed as never, { kind: "pi.user", model: [{ role: "user", content: "new activity", timestamp: Date.now() }] }), context);
  await rt.conversations.update(newlyArchived, { archived: true });
  const rechecked = await request("/v1/sessions/prune", { ...body, ids: [changed, newlyArchived] });
  assert.deepEqual((await rechecked.json() as { deleted: number[] }).deleted, []);
  assert.equal((await app.request(`/v1/sessions/${notConfirmed}`, { headers })).status, 200);
  const inclusive = await request("/v1/sessions/prune/preview", { ...body, includeArchived: true });
  assert.ok((await inclusive.json() as { ids: number[] }).ids.includes(archived));
  // Unknown timestamps are not invented. Recent creation protects a new fork with inherited old messages.
  const unknown = await create();
  await rt.harness.commit(tx => tx.retireDoc(SessionCreated, unknown as never), context);
  const parentId = await create();
  const parent = (await rt.harness.conversation(parentId as never, context))!;
  const entry = await parent.commit(tx => tx.appendEntry(parent.id, { kind: "pi.user", model: [{ role: "user", content: "old message", timestamp: old }] }), context);
  const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
  const previewIds = async (extra = {}) => {
    const r = await request("/v1/sessions/prune/preview", { ...body, ...extra });
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json() as { ids: number[] }).ids;
  };
  assert.ok(!(await previewIds()).includes(unknown));
  assert.ok(!(await previewIds()).includes(Number(fork.id)), "new fork is protected");
  assert.ok(!(await previewIds()).includes(parentId), "parent cannot cascade through a protected fork");
  await fork.commit(async tx => { (await tx.doc(SessionCreated, fork.id)).at = old; }, context);
  assert.ok((await previewIds()).includes(parentId));
  assert.ok(!(await previewIds({ excludeIds: [current, Number(fork.id)] })).includes(parentId));
  await rt.conversations.update(Number(fork.id), { archived: true });
  assert.ok(!(await previewIds()).includes(parentId), "archived fork protects its parent");
  await rt.conversations.update(Number(fork.id), { archived: false });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("done"); }]);
  const active = await fork.submit({ type: "input", content: "busy" }, context);
  await started;
  try {
    assert.ok(!(await previewIds()).includes(parentId), "busy descendant protects parent");
    const r = await request("/v1/sessions/prune", { ...body, ids: [parentId, Number(fork.id)] });
    assert.deepEqual((await r.json() as { deleted: number[] }).deleted, []);
  } finally { release(); await active.wait(context); await rt.harness.waitForIdle(context); }
  // Side questions run without source tasks. Their running state must still protect the source.
  const sideId = await create();
  const source = (await rt.harness.conversation(sideId as never, context))!;
  await source.commit(tx => tx.appendEntry(source.id, { kind: "pi.user", model: [{ role: "user", content: "seed", timestamp: old }] }), context);
  let releaseSide!: () => void, enteredSide!: () => void;
  const sideGate = new Promise<void>(r => { releaseSide = r; }), sideStarted = new Promise<void>(r => { enteredSide = r; });
  faux.setResponses([async () => { enteredSide(); await sideGate; return fauxAssistantMessage("side done"); }]);
  await sideCommands.start(source, "btw", "question", "question"); await sideStarted;
  try { assert.ok(!(await previewIds()).includes(sideId), "running side question protects source"); }
  finally { releaseSide(); await sideCommands.close(); }
  // A real OS process outlives its foreground task. Background execution alone must protect the session.
  const processId = await create(), releasePath = join(dir, "release-process");
  const processSource = (await rt.harness.conversation(processId as never, context))!;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("process_start", { command: `while [ ! -f '${releasePath}' ]; do sleep 0.05; done`, cwd: dir })], { stopReason: "toolUse" }),
    fauxAssistantMessage("started"),
  ]);
  try {
    const sub = await processSource.submit({ type: "input", content: "start scratch process" }, context);
    assert.equal((await sub.wait(context)).status, "done"); await rt.harness.waitForIdle(context);
    const owner = (await rt.harness.snapshot(ProcessOwner, processSource.id, context))!.token;
    assert.ok(rt.harness.busyTools.sessionProcesses(processSource.id, owner).some(p => p.status === "running"));
    await processSource.commit(tx => tx.appendEntry(processSource.id, { kind: "pi.user", model: [{ role: "user", content: "aged activity fixture", timestamp: old }] }), context);
    assert.ok(!(await previewIds()).includes(processId), "running OS process protects idle source");
  } finally {
    faux.setResponses([fauxAssistantMessage("background completion")]);
    writeFileSync(releasePath, "done");
    const owner = (await rt.harness.snapshot(ProcessOwner, processSource.id, context))!.token;
    const deadline = Date.now() + 10000;
    while (rt.harness.busyTools.sessionProcesses(processSource.id, owner).some(p => p.status === "running")) {
      assert.ok(Date.now() < deadline, "scratch process must finish");
      await new Promise(r => setTimeout(r, 20));
    }
    await rt.harness.waitForIdle(context);
  }
  // Strict validation, authorization, zero matches, and no deletion outside the confirmed set.
  for (const payload of [null, [], {}, { ...body, days: 0 }, { ...body, days: -1 }, { ...body, days: 1.2 },
    { ...body, days: "7" }, { ...body, includeArchived: "false" }, { ...body, excludeIds: ["1"] }, { ...body, extra: true }]) {
    assert.equal((await request("/v1/sessions/prune/preview", payload)).status, 400);
  }
  assert.equal((await request("/v1/sessions/prune", body)).status, 400);
  assert.equal((await app.request("/v1/sessions/prune/preview", { method: "POST", body: JSON.stringify(body) })).status, 401);
  assert.deepEqual((await (await request("/v1/sessions/prune", { ...body, ids: [] })).json() as { deleted: number[] }).deleted, []);
  const firstBulk = await create(), secondBulk = await create();
  const bulk = await request("/v1/sessions/prune", { ...body, ids: [firstBulk, secondBulk] });
  assert.deepEqual((await bulk.json() as { deleted: number[] }).deleted, [firstBulk, secondBulk]);
  // A storage fault closes the harness. Check rollback through a separate connection, as in verify-conversations.
  const rollbackIds = [await create(), await create()];
  const db = new DatabaseSync(join(dir, "luna.db"));
  db.exec("CREATE TRIGGER block_prune BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'prune failure'); END;");
  const before = db.prepare("SELECT count(*) AS n FROM documents WHERE retired_at IS NULL").get();
  try {
    const failed = await request("/v1/sessions/prune", { ...body, ids: rollbackIds });
    assert.equal(failed.status, 500);
    for (const id of rollbackIds) assert.ok(db.prepare("SELECT id FROM conversations WHERE id=?").get(id));
    assert.deepEqual(db.prepare("SELECT count(*) AS n FROM documents WHERE retired_at IS NULL").get(), before);
  } finally { db.exec("DROP TRIGGER block_prune"); db.close(); }
  console.log("PRUNE_OK: preview, age, archive/current protection, permanent deletion");
} finally { await rt.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
