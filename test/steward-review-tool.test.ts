// Contract: a session can go through Steward cards with m57 and clean up other sessions through the steward tool,
// acting only on the ids it is given, with a reason for dismiss and confirm for destructive cards.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { AskDoc } from "../src/ask.js";
import { GoalDoc } from "../src/goal-doc.js";
import { SessionHandoffDoc, SessionReadDoc } from "../src/session-status.js";
import { TodoDoc } from "../src/todo.js";
import { StewardStore } from "../src/steward/store.js";
import { StewardService } from "../src/steward/service.js";
import { createStewardExtension } from "../src/steward/tool.js";

type Result = { isError?: boolean; output: { text: string }[] };
type Tool = { execute(args: Record<string, unknown>, api: unknown, ctx: unknown): Promise<Result> };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "luna-steward-review-"));
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models: createModels(), memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const store = new StewardStore(":memory:");
  const steward = new StewardService({ store, conversations, analytics: () => ({ sessions: () => [] }) as never, config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }) as never });
  const archived: number[] = [];
  const ext = createStewardExtension({ steward: () => steward, sessionExists: id => conversations.exists(id), conversations: () => conversations, onArchive: async id => { archived.push(id); } });
  const tool = (ext as unknown as { tools: Tool[] }).tools[0]!;
  const api = { conversationId: 1, commit: (fn: never) => harness.commit(fn, context) };
  const run = async (args: Record<string, unknown>) => { const r = await tool.execute(args, api, context); return { error: !!r.isError, text: r.output[0]!.text }; };
  return { harness, conversations, store, steward, run, archived, async close() { store.close(); await harness.close(context); await rm(dir, { recursive: true, force: true }); } };
}
const card = (fp: string, extra: Record<string, unknown> = {}) => ({ kind: "feature_tip", fingerprint: fp, title: fp, body: "why", evidence: [{ sessionId: 3, note: "seen" }], payload: { tip: fp }, source: "detector", ...extra }) as never;

test("list shows id, evidence and payload; dismiss needs a reason; actions touch only the named ids", async () => {
  const f = await fixture();
  try {
    const a = f.store.file(card("a"))!, b = f.store.file(card("b"))!, c = f.store.file(card("c"))!;
    const list = (await f.run({ action: "list" })).text;
    expect(list).toMatch(new RegExp(`#${a.id} a \\[open\\] a`));
    expect(list).toMatch(/evidence: session 3: seen/);
    expect(list).toMatch(/payload: \{"tip":"a"\}/);
    expect((await f.run({ action: "dismiss", ids: [a.id] })).error).toBe(true);
    expect((await f.run({ action: "dismiss", ids: [] , reason: "wrong" })).error).toBe(true);
    const r = await f.run({ action: "dismiss", ids: [a.id], reason: "wrong", note: "not my style" });
    expect(r.text).toMatch(new RegExp(`#${a.id} dismissed`));
    expect((await f.run({ action: "snooze", ids: [b.id], days: 3 })).text).toMatch(/snoozed/);
    expect(f.store.get(c.id)!.status).toBe("open");
    const again = await f.run({ action: "dismiss", ids: [a.id, 999], reason: "wrong" });
    expect(again.error).toBe(true);
    expect(again.text).toMatch(/suggestion is dismissed/);
    expect(again.text).toMatch(/#999 error: no such suggestion/);
  } finally { await f.close(); }
});

test("agree on a delete card needs confirm", async () => {
  const f = await fixture();
  try {
    const conv = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await f.conversations.update(Number(conv.id), { archived: true });
    const d = f.store.file({ kind: "delete_session", fingerprint: "delete_session:x", title: "Delete", body: "old", evidence: [], payload: { sessionId: Number(conv.id) }, source: "detector" })!;
    const no = await f.run({ action: "agree", ids: [d.id] });
    expect(no.error).toBe(true);
    expect(no.text).toMatch(/confirm:true/);
    expect(f.conversations.exists(Number(conv.id))).toBe(true);
    const yes = await f.run({ action: "agree", ids: [d.id], confirm: true });
    expect(yes.error).toBe(false) /* yes.text */;
    expect(f.conversations.exists(Number(conv.id))).toBe(false);
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

    expect((await f.run({ action: "session", session: 9999 })).error).toBe(true);
    const v = (await f.run({ action: "session", session: id })).text;
    expect(v).toMatch(/1 \[pending\] one/);
    expect(v).toMatch(/2 \[in_progress\] two/);
    expect(v).not.toMatch(/three/);
    expect(v).toMatch(/q1 \(approval\) Merge\?/);
    expect(v).toMatch(/Goal \[active\] ship it/);
    expect(v).toMatch(/needs_input: which db\?/);

    expect((await f.run({ action: "todos_done", session: id })).error).toBe(true);   // needs ids or all
    expect((await f.run({ action: "todos_done", session: id, todo_ids: [2, 3] })).text).toMatch(/Completed 2\. Not open: 3\./);
    expect((await f.run({ action: "todos_done", session: id, all: true })).text).toMatch(/Completed 1\./);
    expect((await f.run({ action: "cancel_questions", session: id, note: "m57 said no" })).text).toMatch(/Cancelled 1 question\./);
    expect((await f.run({ action: "clear_status", session: id })).text).toMatch(/Cleared the handoff/);
    expect((await f.run({ action: "goal", session: id, goal: "pause" })).text).toMatch(/Goal paused\./);
    expect((await f.run({ action: "goal", session: id, goal: "clear" })).text).toMatch(/Goal cleared\./);
    expect((await f.run({ action: "goal", session: id, goal: "clear" })).error).toBe(true);

    await f.harness.commit(async tx => {
      expect((await tx.doc(TodoDoc, conv.id)).tasks.map(t => t.status)).toEqual(["completed", "completed", "completed"]);
      const ask = await tx.doc(AskDoc, conv.id);
      expect(ask.answers.q1?.cancelled).toBe(true);
      expect(ask.answers.q1?.globalNote).toBe("m57 said no");
      expect((await tx.doc(SessionHandoffDoc, conv.id)).handoff).toBe(null);
      expect((await tx.doc(SessionReadDoc, conv.id)).at).toBeTruthy();
      expect((await tx.doc(GoalDoc, conv.id)).goal).toBe(null);
    }, context);

    expect((await f.run({ action: "edit_session", session: id })).error).toBe(true);
    expect((await f.run({ action: "edit_session", session: id, title: " Renamed ", archived: true })).text).toMatch(/"Renamed".*archived/);
    expect(f.archived).toEqual([id]);
    expect(f.conversations.get(id)).toEqual({ title: "Renamed", archived: true, pinned: false });
  } finally { await f.close(); }
});
