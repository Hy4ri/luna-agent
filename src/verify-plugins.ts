// Verifies the ported plugins end to end through the real harness and HTTP API with a scripted faux model:
// todo (rpiv-todo), ask_user_question (rpiv-ask-user-question) answered over HTTP, session_search
// (pi-session-recall) over earlier conversations, and goals (pi-goal-x): continuation, task gate, auditor.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { applyTodo, type TaskState } from "./todo.js";
import { checkAnswer, envelope, validateQuestions } from "./ask.js";
import { parseVerdict } from "./goal.js";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const ok = (m: string) => console.log("OK", m);
const d = mkdtempSync(join(process.cwd(), ".vpl-"));
const textOf = (m: any): string => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join(""));
const call = (name: string, args: unknown) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const say = (t: string) => fauxAssistantMessage([fauxText(t)]);

try {
  // ---- pure parts ----
  let s: TaskState = { tasks: [], nextId: 1 };
  s = applyTodo(s, { action: "create", subject: "a" }).state;
  s = applyTodo(s, { action: "create", subject: "b", blockedBy: [1] }).state;
  assert.equal(applyTodo(s, { action: "update", id: 1, addBlockedBy: [2] }).op.kind, "error", "cycle rejected");
  s = applyTodo(s, { action: "update", id: 1, status: "completed" }).state;
  assert.match(String((applyTodo(s, { action: "update", id: 1, status: "pending" }).op as { message?: string }).message), /illegal transition/);
  assert.equal((applyTodo(s, { action: "update", id: 1, status: "completed" }).op as { changed?: boolean }).changed, false, "no-op update");
  const qs = [{ question: "Which db?", header: "DB", options: [{ label: "Postgres", description: "x", preview: "pg" }, { label: "SQLite", description: "y" }] },
    { question: "Features?", header: "F", multiSelect: true, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  assert.match(String(validateQuestions({ questions: [{ ...qs[0]!, options: [{ label: "Other", description: "" }, { label: "x", description: "" }] }] })), /reserved/);
  const pending = { callId: "c", questions: qs, at: 0 };
  assert.equal(typeof checkAnswer(pending, { answers: [{ questionIndex: 0, kind: "option", answer: "MySQL" }] }), "string", "forged label rejected");
  assert.equal(typeof checkAnswer(pending, { answers: [{ questionIndex: 0, kind: "multi", selected: ["Postgres"] }] }), "string", "multi on single-select rejected");
  const good = checkAnswer(pending, { answers: [{ questionIndex: 0, kind: "option", answer: "Postgres", notes: "fast" }] });
  assert.equal(envelope(good as never, qs), 'User has answered your questions: "Which db?"="Postgres". selected preview: pg. user notes: fast. unanswered: "Features?". You can now continue with the user\'s answers in mind.');
  assert.equal(parseVerdict("looks fine\n<approved/>"), true);
  assert.equal(parseVerdict("I would emit <approved/> if...\n<disapproved/>"), false);
  ok("pure: todo reducer rules, question validation + forged answers rejected, envelope text, verdict parsing");

  // ---- full runtime ----
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel();
  const model = { provider: fm.provider, modelId: fm.id };
  const pushes: string[] = [];
  const fakeFetch = (async (_u: string, init: any) => { pushes.push(String(init.headers.Title)); return new Response("ok"); }) as typeof fetch;
  const cfg = parseConfig({ dataDir: join(d, "data"), cwd: d, cron: { notifyUrl: "http://notify.invalid/t" } }, d, {});
  const rt = await startRuntime(cfg, { models, model, fetch: fakeFetch, log: () => {} });
  const app = createApp({ harness: rt.harness, agent: { model }, models, memory: rt.memory, mcp: rt.mcp });
  const http = async (path: string, init?: RequestInit) => { const r = await app.request(path, { ...init, headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json() as any }; };
  const tools = (await (await rt.harness.root(context, { agent: { model } })).agent(context)).tools.map((t) => t.name);
  for (const t of ["todo", "ask_user_question", "session_search", "create_goal", "update_goal", "set_goal_tasks", "update_goal_task", "get_goal"]) assert.ok(tools.includes(t), "missing tool " + t);
  ok("runtime: todo, ask_user_question, session_search and goal tools installed by default");

  const newConv = async () => (await http("/v1/sessions", { method: "POST", body: "{}" })).body.id as number;
  const sendAndWait = async (id: number, content: string) => {
    const conv = (await rt.harness.conversation(id as never, context))!;
    return (await conv.submit({ type: "input", content }, context)).wait(context);
  };

  // todo
  const c1 = await newConv();
  faux.setResponses([
    call("todo", { action: "create", subject: "write the PINEAPPLE parser" }),
    call("todo", { action: "update", id: 1, status: "in_progress", activeForm: "writing parser" }),
    say("tracking it"),
  ]);
  assert.equal((await sendAndWait(c1, "plan the parser work")).status, "done");
  const s1 = (await http(`/v1/sessions/${c1}?limit=50`)).body;
  assert.deepEqual(s1.todos.map((t: any) => [t.id, t.status, t.activeForm]), [[1, "in_progress", "writing parser"]]);
  ok("todo: tool calls persist in the conversation document and show in GET /v1/sessions/:id");

  // ask_user_question answered over HTTP while the tool waits
  const c2 = await newConv();
  let seenResult = "";
  faux.setResponses([
    call("ask_user_question", { questions: qs }),
    (ctx: any) => { seenResult = textOf(ctx.messages.at(-1)); return say("thanks"); },
  ]);
  const waiting = sendAndWait(c2, "set up storage");
  let open: any[] = [];
  for (let i = 0; i < 100 && !open.length; i++) { await new Promise((r) => setTimeout(r, 50)); open = (await http(`/v1/sessions/${c2}?limit=1`)).body.questions; }
  assert.equal(open.length, 1, "question visible to the UI");
  assert.equal((await http(`/v1/sessions/${c2}/questions/${open[0].callId}`, { method: "POST", body: JSON.stringify({ answers: [{ questionIndex: 0, kind: "option", answer: "Nope" }] }) })).status, 400, "bad answer rejected");
  const ans = await http(`/v1/sessions/${c2}/questions/${open[0].callId}`, { method: "POST", body: JSON.stringify({ answers: [{ questionIndex: 0, kind: "option", answer: "SQLite" }, { questionIndex: 1, kind: "multi", selected: ["A", "B"] }] }) });
  assert.equal(ans.status, 200);
  assert.equal((await waiting).status, "done");
  assert.equal(seenResult, 'User has answered your questions: "Which db?"="SQLite". "Features?"="A, B". You can now continue with the user\'s answers in mind.');
  assert.equal((await http(`/v1/sessions/${c2}?limit=1`)).body.questions.length, 0, "question closed");
  assert.ok(pushes.some((p) => p.includes(`Luna is asking (session ${c2})`)), "push sent");
  ok("ask_user_question: tool waits, UI answers over HTTP (forged answer 400), model gets rpiv envelope, ntfy push sent");

  // session_search finds the todo conversation from another one
  const c3 = await newConv();
  let found = "", scrolled = "";
  faux.setResponses([
    call("session_search", { query: "PINEAPPLE parser" }),
    (ctx: any) => { found = textOf(ctx.messages.at(-1)); const m = /session (\d+) · message (\d+)/.exec(found); return call("session_search", { sessionId: Number(m?.[1]), aroundMessageId: Number(m?.[2]), window: 2 }); },
    (ctx: any) => { scrolled = textOf(ctx.messages.at(-1)); return say("found it"); },
  ]);
  assert.equal((await sendAndWait(c3, "what did we decide about parsing?")).status, "done");
  assert.match(found, new RegExp(`session ${c1} · message \\d+`), "hit points at the todo conversation: " + found);
  assert.match(found, /\[PINEAPPLE\]|\[pine|PINEAPPLE/i);
  assert.match(scrolled, /PINEAPPLE parser/);
  assert.ok(!new RegExp(`session ${c3} ·`).test(found), "current conversation excluded");
  ok("session_search: FTS5 discovery across conversations (current one excluded), scroll around the hit");

  // goal: create, auto-continue, task gate, auditor rejects then approves
  const c4 = await newConv();
  let auditPrompts = 0, continued = 0;
  const auditOrExec = (exec: (ctx: any) => any, verdict?: string) => (ctx: any) => {
    // The auditor's system prompt rides in the transcript's system messages.
    if (JSON.stringify(ctx.messages).includes("read-only completion auditor")) { auditPrompts++; return say(verdict ?? "<disapproved/>"); }
    if (textOf(ctx.messages.at(-1)).includes("<goal_continuation")) continued++;
    return exec(ctx);
  };
  faux.setResponses([
    auditOrExec(() => call("create_goal", { objective: "Ship the parser", max_runs: 5 })),
    auditOrExec(() => call("set_goal_tasks", { tasks: [{ title: "write parser" }, { title: "test parser" }] })),
    auditOrExec(() => say("plan set")), // final answer → goal continues automatically
    auditOrExec(() => call("update_goal", { status: "complete", completion_summary: "done" })), // blocked by task gate
    auditOrExec(() => call("update_goal_task", { task_id: "t1", status: "complete", evidence: "parser.ts exists" })),
    auditOrExec(() => call("update_goal_task", { task_id: "t2", status: "skipped", skip_reason: "covered elsewhere" })),
    auditOrExec(() => call("update_goal", { status: "complete", completion_summary: "done" })), // auditor rejects
    auditOrExec(() => say("unused"), "missing tests\n<disapproved/>"),
    auditOrExec(() => say("auditor said no; fixing")), // continue
    auditOrExec(() => call("update_goal", { status: "complete", completion_summary: "really done" })),
    auditOrExec(() => say("unused"), "verified\n<approved/>"),
    auditOrExec(() => say("goal finished")),
  ]);
  const r4 = await sendAndWait(c4, "make this a goal: ship the parser");
  assert.equal(r4.status, "done", JSON.stringify(r4).slice(0, 300));
  const g = (await http(`/v1/sessions/${c4}?limit=1`)).body.goal;
  assert.equal(g.status, "complete", JSON.stringify(g).slice(0, 400));
  assert.equal(g.lastAudit.approved, true);
  assert.equal(auditPrompts, 2, "two audits");
  assert.ok(continued >= 2, "automatic continuations: " + continued);
  const entries = (await http(`/v1/sessions/${c4}?limit=200`)).body.entries.map((e: any) => textOf(e.model?.[0])).join("\n");
  assert.match(entries, /task gate: t1, t2 still pending/);
  assert.match(entries, /Audit rejected/);
  assert.match(entries, /Audit approved/);
  const list = (await http("/v1/sessions")).body.sessions.map((x: any) => x.title);
  assert.ok(!list.some((t: string) => /independent completion auditor/.test(t)), "auditor child hidden from session list");
  ok("goal: auto-continuation, task gate, independent auditor in a child conversation (reject then approve)");

  // goal run allowance pauses; UI controls
  const c5 = await newConv();
  faux.setResponses([call("create_goal", { objective: "loop", max_runs: 2 }), say("1"), say("2"), say("3"), say("4")]);
  assert.equal((await sendAndWait(c5, "goal: loop")).status, "done");
  let g5 = (await http(`/v1/sessions/${c5}?limit=1`)).body.goal;
  assert.equal(g5.status, "paused"); assert.match(g5.statusReason, /run allowance 2/); assert.equal(g5.runs, 2);
  faux.setResponses([say("resumed"), say("again"), say("x"), say("y")]);
  assert.equal((await http(`/v1/sessions/${c5}/goal`, { method: "PATCH", body: JSON.stringify({ action: "pause" }) })).status, 200);
  assert.equal((await http(`/v1/sessions/${c5}/goal`, { method: "PATCH", body: JSON.stringify({ action: "clear" }) })).status, 200);
  assert.equal((await http(`/v1/sessions/${c5}?limit=1`)).body.goal, null);
  ok("goal: run allowance pauses the loop; PATCH goal pause/clear");

  // cron conversations never get ask_user_question
  const cronConv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, extensions: { remove: [] } } }, context);
  assert.ok((await cronConv.agent(context)).tools.some((t) => t.name === "ask_user_question"));
  rt.store!.addJob("probe", "* * * * *", "say hi");
  faux.setResponses([say("hi")]);
  const runConv = await (async () => {
    // Fire the scheduler's own conversation path through a due job.
    const job = rt.store!.listJobs().find((j) => j.name === "probe")!;
    const sched: any = rt.scheduler;
    const run = rt.store!.claim(job, Date.now() + 120_000)!;
    await sched.execute(job, rt.store!.getRun(run.id));
    return rt.store!.getRun(run.id)!.conversationId!;
  })();
  const cronTools = (await (await rt.harness.conversation(Number(runConv) as never, context))!.agent(context)).tools.map((t) => t.name);
  assert.ok(!cronTools.includes("ask_user_question") && cronTools.includes("todo"), cronTools.join(","));
  ok("cron: scheduled conversations exclude ask_user_question, keep the rest");

  await rt.close();
  console.log("PLUGINS_OK");
} finally {
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
