// Board events through the real runtime + HTTP API (faux model). A user change reaches the owner session; an agent change does not.
// Covers: user move sends one line, agent move sends none, owner set on in_progress, busy session queues, dead session
// clears the owner, done releases the owner (final event, then silence), owner change notifies old and new owner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { cardEvents, ownerSession } from "./board-events.js";
import { loadConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const dir = mkdtempSync(join(process.cwd(), ".board-events-test-"));
const textOf = (m: any): string => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("");
try {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
  const rt = await startRuntime(loadConfig(join(dir, "config.json")), { models, model, log: () => {} });
  const h = rt.harness;
  const app = createApp({ harness: h, models: rt.models, providers: rt.providers, settings: rt.settings, conversations: rt.conversations, projectExtensions: rt.projectExtensions, agent: { model }, token: "t" });
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const call = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
  try {
    assert.equal(ownerSession("session 12"), 12);
    assert.equal(ownerSession("m57"), undefined);
    assert.equal(ownerSession(null), undefined);

    const make = async () => Number((await h.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context)).id);
    const A = await make();
    const users = async (id: number) => h.commit(async tx => (await tx.scanEntries({ conversationId: id as ConversationId, order: "ascending" }, 500)).items
      .flatMap(e => (e.model ?? []).filter(m => m.role === "user").map(textOf)), context);
    const events = async (id: number) => (await users(id)).filter(t => t.startsWith("[board event"));
    const idle = async (id: number) => (await h.conversation(id as never, context))!.waitForIdle(context);
    faux.setResponses(Array(100).fill(() => fauxAssistantMessage([fauxText("ok")])));

    // The agent moves a card to in_progress through the board tool: it becomes the owner and gets no event.
    const card = rt.conversations.board.create(0, { subject: "Wire events", status: "review" });
    let step = 0;
    faux.setResponses([
      () => (step++, fauxAssistantMessage([fauxToolCall("board", { action: "update", id: card.id, status: "in_progress" })], { stopReason: "toolUse" })),
      () => fauxAssistantMessage([fauxText("moved")]),
      ...Array(50).fill(() => fauxAssistantMessage([fauxText("ok")])),
    ]);
    await (await h.conversation(A as never, context))!.submit({ type: "input", content: "pick it" }, context);
    for (let i = 0; i < 100 && !step; i++) await new Promise(r => setTimeout(r, 50));
    await idle(A);
    assert.equal(rt.conversations.board.get(0, card.id)?.owner, `session ${A}`);
    assert.equal((await events(A)).length, 0, "agent change sends no event");

    // The user moves it: the owner gets one line. Priority edits send nothing.
    assert.equal((await call(`/v1/projects/0/cards/${card.id}`, "PATCH", { priority: "high" })).status, 200);
    await idle(A);
    assert.equal((await events(A)).length, 0, "priority edit sends nothing");
    assert.equal((await call(`/v1/projects/0/cards/${card.id}`, "PATCH", { status: "review" })).status, 200);
    await idle(A);
    let got = await events(A);
    assert.equal(got.length, 1);
    assert.match(got[0]!, /#\d+ "Wire events" moved in_progress -> review by user/);
    assert.equal(rt.conversations.board.get(0, card.id)?.owner, `session ${A}`, "review keeps the owner");

    // Done: final event, then the owner is released and later changes send nothing.
    assert.equal((await call(`/v1/projects/0/cards/${card.id}`, "PATCH", { status: "done" })).status, 200);
    await idle(A);
    got = await events(A);
    assert.equal(got.length, 2);
    assert.match(got[1]!, /moved review -> done by user/);
    assert.doesNotMatch(got[1]!, /owner/);
    assert.equal(rt.conversations.board.get(0, card.id)?.owner, null, "done releases the owner");
    assert.equal((await call(`/v1/projects/0/cards/${card.id}`, "PATCH", { status: "review" })).status, 200);
    await idle(A);
    assert.equal((await events(A)).length, 2, "released card sends nothing");

    // Busy session: the event waits in the queue and the turn is not interrupted.
    const B = await make();
    let release!: () => void; const hold = new Promise<void>(r => { release = r; });
    let started!: () => void; const begun = new Promise<void>(r => { started = r; });
    faux.setResponses([async () => { started(); await hold; return fauxAssistantMessage([fauxText("held")]); }, ...Array(50).fill(() => fauxAssistantMessage([fauxText("ok")]))]);
    const busyCard = rt.conversations.board.create(0, { subject: "Busy card", status: "in_progress", owner: `session ${B}` });
    await (await h.conversation(B as never, context))!.submit({ type: "input", content: "HOLD" }, context);
    await begun;
    assert.equal((await call(`/v1/projects/0/cards/${busyCard.id}`, "PATCH", { status: "review" })).status, 200);
    release(); await idle(B);
    for (let i = 0; i < 100 && (await events(B)).length < 1; i++) { await new Promise(r => setTimeout(r, 50)); await idle(B); }
    const queued = await events(B);
    assert.equal(queued.length, 1);
    assert.match(queued[0]!, /moved in_progress -> review/);

    // Owner change: old and new owner both hear about it.
    const C = await make();
    const swap = rt.conversations.board.create(0, { subject: "Swap", status: "in_progress", owner: `session ${B}` });
    assert.equal((await call(`/v1/projects/0/cards/${swap.id}`, "PATCH", { owner: `session ${C}` })).status, 200);
    await idle(B); await idle(C);
    assert.match((await events(B)).at(-1)!, /owner session \d+ -> session \d+ by user/);
    assert.match((await events(C)).at(-1)!, /owner session \d+ -> session \d+ by user/);

    // Dead owner session: nothing is delivered and the owner is cleared.
    const ghost = rt.conversations.board.create(0, { subject: "Ghost", status: "in_progress", owner: "session 999999" });
    assert.equal((await call(`/v1/projects/0/cards/${ghost.id}`, "PATCH", { status: "review" })).status, 200);
    assert.equal(rt.conversations.board.get(0, ghost.id)?.owner, null, "dead owner is cleared");

    // Non-session owners (free text) and archive: archive sends the final event and releases.
    const arch = rt.conversations.board.create(0, { subject: "Archive me", status: "review", owner: `session ${C}` });
    const before = rt.conversations.board.get(0, arch.id)!;
    await call(`/v1/projects/0/cards/${arch.id}`, "PATCH", { archived: true });
    await idle(C);
    assert.match((await events(C)).at(-1)!, /archived by user/);
    assert.equal(rt.conversations.board.get(0, arch.id)?.owner, null);
    assert.equal(cardEvents({ ...before, owner: "m57" }, { ...before, owner: "m57", status: "done" }).length, 0, "free-text owner gets no event");
    console.log("BOARD_EVENTS_OK");
  } finally { await rt.close?.(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
