// Contract: a session can go through Wife cards with m57 and clean up other sessions through the wife tool,
// acting only on the ids it is given, with a reason for dismiss and confirm for destructive cards.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { AskDoc } from "../src/ask.js";
import { GoalDoc } from "../src/goal-doc.js";
import { SessionHandoffDoc, SessionReadDoc } from "../src/session-status.js";
import { TodoDoc } from "../src/todo.js";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";
import { createWifeExtension } from "../src/wife/tool.js";

type Result = { isError?: boolean; output: { text: string }[] };
type Tool = { execute(args: Record<string, unknown>, api: unknown, ctx: unknown): Promise<Result> };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "luna-wife-review-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const store = new WifeStore(":memory:");
  const wife = new WifeService({ store, conversations, analytics: () => ({ sessions: () => [] }) as never, config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }) as never });
  const archived: number[] = [];
  const ext = createWifeExtension({ wife: () => wife, sessionExists: id => conversations.exists(id), conversations: () => conversations, onArchive: async id => { archived.push(id); } });
  const tool = (ext as unknown as { tools: Tool[] }).tools[0]!;
  const api = { conversationId: 1, commit: (fn: never) => harness.commit(fn, context) };
  const run = async (args: Record<string, unknown>) => { const r = await tool.execute(args, api, context); return { error: !!r.isError, text: r.output[0]!.text }; };
  return { harness, conversations, store, wife, run, archived, async close() { store.close(); await harness.close(context); await rm(dir, { recursive: true, force: true }); } };
}
const card = (fp: string, extra: Record<string, unknown> = {}) => ({ kind: "feature_tip", fingerprint: fp, title: fp, body: "why", evidence: [{ sessionId: 3, note: "seen" }], payload: { tip: fp }, source: "detector", ...extra }) as never;

test("list shows id, evidence and payload; dismiss needs a reason; actions touch only the named ids", async () => {
  const f = await fixture();
  try {
    const a = f.store.file(card("a"))!, b = f.store.file(card("b"))!, c = f.store.file(card("c"))!;
    const list = (await f.run({ action: "list" })).text;
    assert.match(list, new RegExp(`#${a.id} a \\[open\\] a`));
    assert.match(list, /evidence: session 3: seen/);
    assert.match(list, /payload: \{"tip":"a"\}/);
    assert.equal((await f.run({ action: "dismiss", ids: [a.id] })).error, true);
    assert.equal((await f.run({ action: "dismiss", ids: [] , reason: "wrong" })).error, true);
    const r = await f.run({ action: "dismiss", ids: [a.id], reason: "wrong", note: "not my style" });
    assert.match(r.text, new RegExp(`#${a.id} dismissed`));
    assert.match((await f.run({ action: "snooze", ids: [b.id], days: 3 })).text, /snoozed/);
    assert.equal(f.store.get(c.id)!.status, "open");
    const again = await f.run({ action: "dismiss", ids: [a.id, 999], reason: "wrong" });
    assert.equal(again.error, true);
    assert.match(again.text, /suggestion is dismissed/);
    assert.match(again.text, /#999 error: no such suggestion/);
  } finally { await f.close(); }
});

test("agree on a delete card needs confirm", async () => {
  const f = await fixture();
  try {
    const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await f.conversations.update(Number(conv.id), { archived: true });
    const d = f.store.file({ kind: "delete_session", fingerprint: "delete_session:x", title: "Delete", body: "old", evidence: [], payload: { sessionId: Number(conv.id) }, source: "detector" })!;
    const no = await f.run({ action: "agree", ids: [d.id] });
    assert.equal(no.error, true);
    assert.match(no.text, /confirm:true/);
    assert.equal(f.conversations.exists(Number(conv.id)), true);
    const yes = await f.run({ action: "agree", ids: [d.id], confirm: true });
    assert.equal(yes.error, false, yes.text);
    assert.equal(f.conversations.exists(Number(conv.id)), false);
  } finally { await f.close(); }
});

test("session housekeeping: view, finish todos, cancel questions, clear status, goal, edit", async () => {
  const f = await fixture();
  try {
    const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const id = Number(conv.id);
    await f.harness.commit(async tx => {
      const t = await tx.doc(TodoDoc, conv.id);
      t.tasks.push({ id: 1, subject: "one", status: "pending" }, { id: 2, subject: "two", status: "in_progress" }, { id: 3, subject: "three", status: "completed" });
      t.nextId = 4;
      (await tx.doc(AskDoc, conv.id)).pending.push({ callId: "q1", purpose: "approval", questions: [{ question: "Merge?", header: "Merge", options: [] }] as never, at: 1 });
      (await tx.doc(SessionHandoffDoc, conv.id)).handoff = { status: "needs_input", reason: "which db?", boundary: 0 };
      (await tx.doc(GoalDoc, conv.id)).goal = { id: "g", objective: "ship it", mode: "regular", status: "active", tasks: [], audit: false, runs: 0, maxRuns: 5, baseTokens: 0, tokensUsed: 0, created: 1 };
    }, context);

    assert.equal((await f.run({ action: "session", session: 9999 })).error, true);
    const v = (await f.run({ action: "session", session: id })).text;
    assert.match(v, /1 \[pending\] one/);
    assert.match(v, /2 \[in_progress\] two/);
    assert.doesNotMatch(v, /three/);
    assert.match(v, /q1 \(approval\) Merge\?/);
    assert.match(v, /Goal \[active\] ship it/);
    assert.match(v, /needs_input: which db\?/);

    assert.equal((await f.run({ action: "todos_done", session: id })).error, true);   // needs ids or all
    assert.match((await f.run({ action: "todos_done", session: id, todo_ids: [2, 3] })).text, /Completed 2\. Not open: 3\./);
    assert.match((await f.run({ action: "todos_done", session: id, all: true })).text, /Completed 1\./);
    assert.match((await f.run({ action: "cancel_questions", session: id, note: "m57 said no" })).text, /Cancelled 1 question\./);
    assert.match((await f.run({ action: "clear_status", session: id })).text, /Cleared the handoff/);
    assert.match((await f.run({ action: "goal", session: id, goal: "pause" })).text, /Goal paused\./);
    assert.match((await f.run({ action: "goal", session: id, goal: "clear" })).text, /Goal cleared\./);
    assert.equal((await f.run({ action: "goal", session: id, goal: "clear" })).error, true);

    await f.harness.commit(async tx => {
      assert.deepEqual((await tx.doc(TodoDoc, conv.id)).tasks.map(t => t.status), ["completed", "completed", "completed"]);
      const ask = await tx.doc(AskDoc, conv.id);
      assert.equal(ask.answers.q1?.cancelled, true);
      assert.equal(ask.answers.q1?.globalNote, "m57 said no");
      assert.equal((await tx.doc(SessionHandoffDoc, conv.id)).handoff, null);
      assert.ok((await tx.doc(SessionReadDoc, conv.id)).at);
      assert.equal((await tx.doc(GoalDoc, conv.id)).goal, null);
    }, context);

    assert.equal((await f.run({ action: "edit_session", session: id })).error, true);
    assert.match((await f.run({ action: "edit_session", session: id, title: " Renamed ", archived: true })).text, /"Renamed", archived/);
    assert.deepEqual(f.archived, [id]);
    assert.deepEqual(f.conversations.get(id), { title: "Renamed", archived: true, pinned: false });
  } finally { await f.close(); }
});
