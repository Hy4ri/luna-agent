// Contract: the legacy SSE event stream is rebuilt from Pi 1.5 conversation watches without losing frames.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openSessionFeed } from "../src/session-feed.js";
import type { AgentEvent } from "../src/session-feed-types.js";

async function open(reply = "faux reply") {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText(reply)])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const model = faux.getModel();
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
  return { harness, conv };
}
const users = (events: readonly AgentEvent[]) => events.filter(e => e.type === "message_end" && e.entry.kind === "pi.user");

test("a real run is delivered in order: input entry, answer entry, then run end", async () => {
  const { harness, conv } = await open();
  const feed = await openSessionFeed(harness, conv, undefined, context);
  try {
    const events: AgentEvent[] = [];
    feed.start(async batch => { events.push(...batch); });
    const submission = await conv.submit({ type: "input", content: "hello" }, context);
    await submission.wait(context);
    await feed.flush();
    const kinds = events.flatMap(e => e.type === "message_end" ? [e.entry.kind] : e.type === "run_end" ? ["run_end"] : []);
    assert.deepEqual(kinds.filter(k => k !== "pi.system"), ["pi.user", "pi.assistant", "run_end"]);
  } finally { await feed.stop(); await harness.close(context); }
});

test("entries committed between attach and start are delivered exactly once", async () => {
  const { harness, conv } = await open();
  const feed = await openSessionFeed(harness, conv, undefined, context);
  try {
    await harness.commit(tx => tx.appendEntry(conv.id, { kind: "pi.user", model: [{ role: "user", content: "before start", timestamp: 1 }] }), context);
    const events: AgentEvent[] = [];
    feed.start(async batch => { events.push(...batch); });
    await feed.flush();
    assert.equal(users(events).length, 1);
  } finally { await feed.stop(); await harness.close(context); }
});

test("reconnecting from an old cursor outside the bounded window recovers every missed entry once", async () => {
  const { harness, conv } = await open();
  let first = 0;
  for (let i = 1; i <= 10; i++) {
    const entry = await harness.commit(tx => tx.appendEntry(conv.id, { kind: "pi.user", model: [{ role: "user", content: `m${i}`, timestamp: i }] }), context);
    if (i === 1) first = Number(entry.id);
  }
  const feed = await openSessionFeed(harness, conv, { from: first, minWindow: 2, maxWindow: 4 }, context);
  try {
    const ids = feed.snapshot.entries.map(entry => Number(entry.id));
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  } finally { await feed.stop(); await harness.close(context); }
});

test("stopping a viewer does not end the conversation", async () => {
  const { harness, conv } = await open("still works");
  const feed = await openSessionFeed(harness, conv, undefined, context);
  assert.equal((await feed.stop()).kind, "stopped");
  try {
    const answer = await (await conv.submit({ type: "input", content: "after viewer" }, context)).wait(context);
    assert.equal(answer.status, "done");
  } finally { await harness.close(context); }
});
