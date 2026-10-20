// Session titles: instant title, then one auxiliary call per user message (up to turn 3), thinking off, user titles win. Faux models only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { UsageDoc } from "@earendil-works/pi-durable";
import { context, openLuna } from "./luna.js";
import { ConversationStore } from "./conversations.js";
import { RecallIndex } from "./recall.js";
import { SessionTitler, cleanTitle, parseTitle, deriveTitle } from "./titles.js";
import { createApp } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "luna-titles-"));
const faux = fauxProvider({ models: [{ id: "big", reasoning: true }, { id: "small" }] });
const models = createModels(); models.setProvider(faux.provider);
const big = { provider: faux.models[0].provider, modelId: "big" }, small = { provider: faux.models[0].provider, modelId: "small" };
const harness = await openLuna({ models, dbPath: join(dir, "luna.db"), cwd: dir, coding: false, memory: false });
const recall = new RecallIndex(join(dir, "recall.db"));
const conversations = new ConversationStore(harness, recall);
let route: typeof small | undefined = small;
const titler = new SessionTitler({ harness, conversations, models, route: () => route });
titler.start();
recall.titles(id => conversations.get(id).title);
const app = createApp({ harness, models, conversations, titler, agent: { model: big }, token: "t" });
const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: "Bearer t", "content-type": "application/json" } });

type Call = { model: string; reasoning: unknown; maxTokens: unknown; body: string };
const calls: Call[] = [];
const titleReply = (text: string, wait?: Promise<void>) => async (ctx: any, options: any, _s: unknown, model: { id: string }) => {
  calls.push({ model: model.id, reasoning: options?.reasoning, maxTokens: options?.maxTokens, body: JSON.stringify(ctx.messages) });
  if (wait) await wait;
  return fauxAssistantMessage(text);
};
// Responses by model: the title call runs in parallel with the turn, so one shared queue would race.
type Resp = ReturnType<typeof fauxAssistantMessage> | ((...a: any[]) => any);
const respond = (main: Resp[], title: Resp[] = []) => {
  const m = [...main], t = [...title];
  const pick = (ctx: any, options: any, s: unknown, model: { id: string }) => {
    const r = model.id === "small" ? t.shift() : m.shift();
    if (!r) throw new Error("no faux response for " + model.id);
    return typeof r === "function" ? r(ctx, options, s, model) : r;
  };
  faux.setResponses(Array.from({ length: m.length + t.length }, () => pick));
};
const newSession = () => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: big, thinkingLevel: "high" } }, context);
const turn = async (conv: Awaited<ReturnType<typeof newSession>>, input: string) => (await conv.submit({ type: "input", content: input }, context)).wait(context);
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("timed out: " + label); await new Promise(r => setTimeout(r, 10)); }
}
const settle = () => new Promise(r => setTimeout(r, 100));

try {
  assert.equal(cleanTitle('Title: "Fix the Docker build."\nextra'), "Fix the Docker build");
  assert.equal(cleanTitle("  «إصلاح بناء دوكر»؟ "), "إصلاح بناء دوكر");
  assert.equal(cleanTitle("**Kotlin coroutines**"), "Kotlin coroutines");
  assert.equal(cleanTitle("\n\n"), "");
  assert.ok(cleanTitle("x".repeat(200)).length <= 80);
  assert.equal(parseTitle('{"title": "Fix docker build"}'), "Fix docker build");
  assert.equal(parseTitle('```json\n{"title": "Cron tab redesign"}\n```'), "Cron tab redesign");
  assert.equal(parseTitle('Sure! {"title": "Loose scan works"}'), "Loose scan works");
  assert.equal(parseTitle('{"tit'), "", "cut-off JSON is not a title");
  assert.equal(parseTitle("Plain prose title"), "Plain prose title");
  assert.equal(parseTitle("It looks like your title is all the information you provided, please send the error message"), "", "an answer is not a title");
  assert.equal(parseTitle('{"title": "Fix login button on mobile"}'), "Fix login button on mobile", "JSON is trusted");
  assert.equal(parseTitle("Code changes"), "", "prompt example echo rejected");
  assert.equal(deriveTitle("\n  fix the   docker build\nmore"), "fix the docker build");
  assert.ok(deriveTitle("word ".repeat(40)).length <= 49 && deriveTitle("word ".repeat(40)).endsWith("…"));
  console.log("OK title parsing");

  // 1. The title call starts when the message is stored: a held turn still gets the title.
  //    It uses the small route, thinking off, the user's message only, and a JSON prompt.
  let releaseTurn!: () => void; const turnHeld = new Promise<void>(r => releaseTurn = r);
  const a = await newSession();
  let releaseTitle!: () => void; const titleHeld = new Promise<void>(r => releaseTitle = r);
  respond([async () => { await turnHeld; return fauxAssistantMessage("Use a multi-stage Dockerfile."); }], [titleReply('{"title": "Docker build caching"}', titleHeld)]);
  const aTurn = turn(a, "my docker build is slow, " + "x".repeat(5000));
  await until(() => conversations.titleSource(Number(a.id)) !== null, "instant title");
  assert.ok(conversations.get(Number(a.id)).title!.startsWith("my docker build is slow"), "instant title from the message");
  assert.equal(conversations.titleSource(Number(a.id)), "derived");
  releaseTitle();
  await until(() => conversations.titleSource(Number(a.id)) === "auto", "auto title while the turn still runs");
  releaseTurn(); await aTurn;
  assert.equal(conversations.get(Number(a.id)).title, "Docker build caching");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "small", "title call never uses the session model");
  assert.equal(calls[0]!.reasoning, undefined, "thinking is off despite the session's high level");
  assert.equal(calls[0]!.maxTokens, 512);
  assert.ok(calls[0]!.body.length < 2600 && calls[0]!.body.includes("x".repeat(900)) && !calls[0]!.body.includes("x".repeat(1100)), "input is the bounded user message");
  assert.ok(!calls[0]!.body.includes("multi-stage"), "the answer is not sent");
  assert.ok(Object.keys((await harness.snapshot(UsageDoc, a.id, context))!.models).some(k => k.endsWith("/small")), "title usage is recorded");
  console.log("OK instant title, then model title from the user message; small route, thinking off, usage recorded");

  // 2. A model title is final: later turns do not retitle.
  respond([fauxAssistantMessage("second answer")], [titleReply("SHOULD NOT APPEAR")]);
  await turn(a, "another question"); await settle();
  assert.equal(conversations.get(Number(a.id)).title, "Docker build caching");
  assert.equal(calls.length, 1);
  console.log("OK no retitle on later turns");

  // 3. A rename during the title call wins.
  let release!: () => void; const held = new Promise<void>(r => release = r);
  const b = await newSession();
  respond([fauxAssistantMessage("answer b")], [titleReply("Generated B", held)]);
  const bTurn = turn(b, "question b");
  await until(() => calls.length === 2, "title call started");
  assert.equal((await req(`/v1/sessions/${b.id}/metadata`, { method: "PATCH", body: JSON.stringify({ title: "My name" }) })).status, 200);
  release(); await bTurn; await settle();
  assert.equal(conversations.get(Number(b.id)).title, "My name");
  console.log("OK user rename during generation is kept");

  // 4. An earlier user title is never replaced automatically.
  const c = await newSession();
  await conversations.update(Number(c.id), { title: "Kept" });
  respond([fauxAssistantMessage("answer c")], [titleReply("Replaced")]);
  await turn(c, "question c"); await settle();
  assert.equal(conversations.get(Number(c.id)).title, "Kept");
  assert.equal(calls.length, 2, "titled sessions make no title call");
  await conversations.update(Number(a.id), { pinned: true });
  assert.equal(conversations.titleSource(Number(a.id)), "auto", "metadata edits keep the source");
  console.log("OK existing user titles are preserved; metadata edits keep the source");

  // 5. No route: no model call, the instant title still appears.
  route = undefined;
  const d = await newSession();
  respond([fauxAssistantMessage("answer d")], []);
  await turn(d, "question d without route"); await settle();
  assert.equal(conversations.get(Number(d.id)).title, "question d without route");
  assert.equal(conversations.titleSource(Number(d.id)), "derived");
  assert.equal(calls.length, 2);
  assert.deepEqual(await (await req("/v1/session-titles")).json(), { available: false });
  assert.equal((await req(`/v1/sessions/${d.id}/title`, { method: "POST", body: "{}" })).status, 409);
  console.log("OK no route: instant title only, menu action unavailable");

  // 6. A failed or answer-shaped reply keeps the instant title; the next turn retries with that message.
  route = small;
  const e = await newSession();
  respond([fauxAssistantMessage("answer e")], [async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
  await turn(e, "question e"); await settle();
  assert.equal(conversations.get(Number(e.id)).title, "question e");
  respond([fauxAssistantMessage("answer e2")], [titleReply("It looks like you did not give me enough detail, please share the full error output")]);
  await turn(e, "question e2"); await settle();
  assert.equal(conversations.get(Number(e.id)).title, "question e", "answer-shaped reply rejected");
  respond([fauxAssistantMessage("answer e3")], [titleReply('{"title": "Retried title"}')]);
  await turn(e, "question e3");
  await until(() => conversations.titleSource(Number(e.id)) === "auto", "retry title");
  assert.equal(conversations.get(Number(e.id)).title, "Retried title");
  assert.ok(calls.at(-1)!.body.includes("question e3"), "a retry names the latest message");
  const used = calls.length;
  respond([fauxAssistantMessage("answer e4")], []);
  await turn(e, "question e4"); await settle();
  assert.equal(calls.length, used);
  console.log("OK failures and answers keep the instant title; turns 2-3 retry");

  // 6b. A greeting is a placeholder: the next substantive turn upgrades it.
  const g = await newSession();
  respond([fauxAssistantMessage("hello!")], [titleReply('{"title": "Friendly greeting"}')]);
  await turn(g, "hi"); await settle();
  assert.equal(conversations.get(Number(g.id)).title, "Friendly greeting");
  assert.equal(conversations.titleSource(Number(g.id)), "derived");
  respond([fauxAssistantMessage("mockups")], [titleReply('{"title": "Cron tab redesign"}')]);
  await turn(g, "redesign the cron tab");
  await until(() => conversations.titleSource(Number(g.id)) === "auto", "greeting upgrade");
  assert.equal(conversations.get(Number(g.id)).title, "Cron tab redesign");
  console.log("OK greeting placeholder upgrades on the next turn");

  // 6c. A turn that only calls tools still gets its title, from the message.
  const t = await newSession();
  respond([fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")], [titleReply('{"title": "Session autoname fix"}')]);
  await turn(t, "the autoname of session thing doesnt work");
  await until(() => conversations.titleSource(Number(t.id)) === "auto", "title with tool turn");
  assert.equal(conversations.get(Number(t.id)).title, "Session autoname fix");
  console.log("OK tool-only turns get a title");

  // 7. Explicit regenerate replaces even a user title; it needs a message.
  assert.deepEqual(await (await req("/v1/session-titles")).json(), { available: true });
  respond([], [titleReply('{"title": "Regenerated title"}')]);
  const r = await req(`/v1/sessions/${c.id}/title`, { method: "POST", body: "{}" });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { title: "Regenerated title" });
  assert.equal(conversations.get(Number(c.id)).title, "Regenerated title");
  const fresh = await newSession();
  assert.equal((await req(`/v1/sessions/${fresh.id}/title`, { method: "POST", body: "{}" })).status, 409);
  console.log("OK manual regenerate");

  // 8. session_search shows stored titles.
  await harness.commit(tx => recall.sync(tx), context);
  assert.equal(recall.search("Dockerfile")[0]!.title, "Docker build caching");
  assert.equal(recall.search("question b")[0]!.title, "My name");
  assert.equal(recall.browse(10).find(x => x.id === Number(d.id))!.title, "question d without route");
  console.log("OK session_search uses stored titles");
} catch (e) { console.error("FAIL", e); process.exitCode = 1; } finally {
  await titler.close();
  await harness.close(context).catch(() => {});
  recall.close();
  rmSync(dir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("session titles: all checks passed");
