// Session titles: one auxiliary call after the first answer, thinking off, user titles always win. Faux models only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { UsageDoc } from "@earendil-works/pi-durable";
import { context, openLuna } from "./luna.js";
import { ConversationStore } from "./conversations.js";
import { RecallIndex } from "./recall.js";
import { SessionTitler, cleanTitle, TITLE_INSTRUCTION } from "./titles.js";
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
  console.log("OK title cleanup");

  // 1. A high-reasoning big-model session: the title call uses the small route with thinking off and bounded output.
  const a = await newSession();
  faux.setResponses([fauxAssistantMessage("Use a multi-stage Dockerfile."), titleReply("Docker build caching")]);
  await turn(a, "my docker build is slow, " + "x".repeat(5000));
  await until(() => conversations.get(Number(a.id)).title !== null, "auto title");
  assert.equal(conversations.get(Number(a.id)).title, "Docker build caching");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "small", "title call never uses the session model");
  assert.equal(calls[0]!.reasoning, undefined, "thinking is off despite the session's high level");
  assert.equal(calls[0]!.maxTokens, 40);
  assert.ok(calls[0]!.body.includes(TITLE_INSTRUCTION.slice(0, 40)), "title instruction sent");
  assert.ok(calls[0]!.body.includes("multi-stage Dockerfile") && calls[0]!.body.length < 2900, "input is the bounded first exchange");
  assert.ok(Object.keys((await harness.snapshot(UsageDoc, a.id, context))!.models).some(k => k.endsWith("/small")), "title usage is recorded");
  console.log("OK auto title: small route, thinking off, bounded input/output, usage recorded");

  // 2. Once per session: later turns do not retitle.
  faux.setResponses([fauxAssistantMessage("second answer"), titleReply("SHOULD NOT APPEAR")]);
  await turn(a, "another question"); await settle();
  assert.equal(conversations.get(Number(a.id)).title, "Docker build caching");
  assert.equal(calls.length, 1);
  console.log("OK no retitle on later turns");

  // 3. A rename during the title call wins.
  let release!: () => void; const held = new Promise<void>(r => release = r);
  const b = await newSession();
  faux.setResponses([fauxAssistantMessage("answer b"), titleReply("Generated B", held)]);
  await turn(b, "question b");
  await until(() => calls.length === 2, "title call started");
  assert.equal((await req(`/v1/sessions/${b.id}/metadata`, { method: "PATCH", body: JSON.stringify({ title: "My name" }) })).status, 200);
  release(); await settle();
  assert.equal(conversations.get(Number(b.id)).title, "My name");
  console.log("OK user rename during generation is kept");

  // 4. An earlier user title (no stored source) is never replaced automatically.
  const c = await newSession();
  await conversations.update(Number(c.id), { title: "Kept" });
  faux.setResponses([fauxAssistantMessage("answer c"), titleReply("Replaced")]);
  await turn(c, "question c"); await settle();
  assert.equal(conversations.get(Number(c.id)).title, "Kept");
  assert.equal(calls.length, 2, "titled sessions make no title call");
  // Pinning after an auto title keeps the generated title and its source.
  await conversations.update(Number(a.id), { pinned: true });
  const src = conversations["db"].prepare("SELECT title_source FROM luna_conversations WHERE id=?").get(Number(a.id)) as { title_source: string };
  assert.equal(src.title_source, "auto");
  console.log("OK existing user titles are preserved; metadata edits keep the source");

  // 5. No route: no model call, the first-message fallback stays.
  route = undefined;
  const d = await newSession();
  faux.setResponses([fauxAssistantMessage("answer d")]);
  await turn(d, "question d without route"); await settle();
  assert.equal(conversations.get(Number(d.id)).title, null);
  assert.equal(calls.length, 2);
  const list = await (await req("/v1/sessions")).json() as { sessions: { id: number; title: string }[] };
  assert.equal(list.sessions.find(s => s.id === Number(d.id))!.title, "question d without route");
  assert.deepEqual(await (await req("/v1/session-titles")).json(), { available: false });
  assert.equal((await req(`/v1/sessions/${d.id}/title`, { method: "POST", body: "{}" })).status, 409);
  console.log("OK no route: off, fallback title, menu action unavailable");

  // 6. A failed call leaves the fallback.
  route = small;
  const e = await newSession();
  faux.setResponses([fauxAssistantMessage("answer e"), async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
  await turn(e, "question e"); await settle();
  assert.equal(conversations.get(Number(e.id)).title, null);
  console.log("OK failed title call keeps the fallback");

  // 7. Explicit regenerate replaces even a user title; it needs a finished answer.
  assert.deepEqual(await (await req("/v1/session-titles")).json(), { available: true });
  faux.setResponses([titleReply("Regenerated title")]);
  const r = await req(`/v1/sessions/${c.id}/title`, { method: "POST", body: "{}" });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { title: "Regenerated title" });
  assert.equal(conversations.get(Number(c.id)).title, "Regenerated title");
  const fresh = await newSession();
  assert.equal((await req(`/v1/sessions/${fresh.id}/title`, { method: "POST", body: "{}" })).status, 409);
  console.log("OK manual regenerate");

  // 8. session_search shows stored titles (renames and generated), not the first-message text.
  await harness.commit(tx => recall.sync(tx), context);
  assert.equal(recall.search("Dockerfile")[0]!.title, "Docker build caching");
  assert.equal(recall.search("question b")[0]!.title, "My name");
  assert.equal(recall.browse(10).find(x => x.id === Number(d.id))!.title, "question d without route");
  console.log("OK session_search uses stored titles");
} finally {
  await titler.close();
  await harness.close(context).catch(() => {});
  recall.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log("session titles: all checks passed");
