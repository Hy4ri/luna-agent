// Automatic card runs: a todo card with auto on and owner "agent" starts its own project session, claims the card,
// and the run moves it on. Agent changes cannot arm a card; a cap limits parallel runs; a run that ends without moving the card
// sends it to review; a blocked or waiting card does not start.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { BoardError, parseAuto, type Card } from "../src/board.js";
import { armed, autoBrief, working } from "../src/board-auto.js";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";

const card = (over: Partial<Card>): Card => ({
  id: 1, project: 1, subject: "s", description: "", priority: "medium", status: "todo", blockedBy: [], owner: "agent", blocked: null,
  labels: [], archived: false, created: 0, updated: 0, auto: { model: null, thinking: null }, attachments: [], ...over,
});

test("parseAuto accepts off, defaults, a model, and a thinking level; rejects the rest", () => {
  expect(parseAuto(null)).toBe(null);
  expect(parseAuto(true)).toEqual({ model: null, thinking: null });
  expect(parseAuto({ model: "openai/gpt-5", thinking: "high" })).toEqual({ model: "openai/gpt-5", thinking: "high" });
  expect(() => parseAuto({ model: "nomodel" })).toThrow(BoardError);
  expect(() => parseAuto({ thinking: "huge" })).toThrow(BoardError);
  expect(() => parseAuto({ extra: 1 })).toThrow(BoardError);
  expect(() => parseAuto("yes")).toThrow(BoardError);
});

test("armed needs auto, todo, owner agent, no block, and finished blockers", () => {
  const none = new Set<number>();
  expect(armed(card({}), none)).toBe(true);
  expect(armed(card({ auto: null }), none)).toBe(false);
  expect(armed(card({ status: "backlog" }), none)).toBe(false);
  expect(armed(card({ owner: "session 5" }), none)).toBe(false);
  expect(armed(card({ blocked: "why" }), none)).toBe(false);
  expect(armed(card({ blockedBy: [9] }), none)).toBe(false);
  expect(armed(card({ blockedBy: [9] }), new Set([9]))).toBe(true);
  expect(working(card({ status: "in_progress", owner: "session 5" }))).toBe(true);
  expect(working(card({ status: "in_progress", owner: "session 5", blocked: "x" }))).toBe(false);
  const brief = autoBrief(card({ subject: "Ship it", description: "Do X." }), "proj");
  expect(brief).toMatch(/Nobody watches this session/);
  expect(brief).toMatch(/Do X\./);
  expect(brief).toMatch(/only when the card description explicitly says so/);
});

async function harness(responses: ReturnType<typeof fauxAssistantMessage>[], extra: Record<string, unknown> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "luna-board-auto-")));
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
  const dataDir = join(base, "data");
  mkdirSync(dataDir);
  const rt = await startRuntime(parseConfig({ dataDir, cwd: base, extensions: [], ...extra }), { models, model: ref });
  const project = rt.conversations.projects.create("p", base);
  const app = createApp({ harness: rt.harness, conversations: rt.conversations, models, agent: { model: ref, cwd: base }, cwd: base });
  const req = (method: string, path: string, body?: unknown) => app.fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const board = rt.conversations.board;
  const until = async (fn: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) { if (fn()) return; await Bun.sleep(25); }
    (() => { throw new Error(`timed out waiting for ${what}`); })();
  };
  return { rt, project, req, board, until, async close() { await rt.close(); rmSync(base, { recursive: true, force: true }); } };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("auto on in todo starts a project session that claims and finishes the card", async () => {
  // Card ids start at 1 in a fresh data dir.
  const h = await harness([call("board", { action: "update", id: 1, status: "done" }), fauxAssistantMessage([fauxText("done")])]);
  try {
    const created = await (await h.req("POST", `/v1/projects/${h.project.id}/cards`, { subject: "Write the doc", status: "backlog" })).json() as Card;
    expect(created.id).toBe(1);
    // The agent's board tool cannot arm a card; only a user change can.
    const armedRes = await (await h.req("PATCH", `/v1/projects/${h.project.id}/cards/1`, { auto: { model: null, thinking: "low" } })).json() as Card;
    expect(armedRes.owner).toBe("agent");
    expect(armedRes.status).toBe("backlog");
    await Bun.sleep(100);
    expect(h.board.get(h.project.id, 1)!.status).toBe("backlog") /* "backlog cards do not start" */;
    await h.req("PATCH", `/v1/projects/${h.project.id}/cards/1`, { status: "todo" });
    await h.until(() => h.board.get(h.project.id, 1)!.status === "done", "card done");
    const activity = h.board.activity(h.project.id, 1).map(a => a.text).join("\n");
    expect(activity).toMatch(/auto run started \(default model, low\)/);
    const sid = Number(/session (\d+)/.exec(activity)![1]);
    expect(h.rt.conversations.projects.projectOf(sid)).toBe(h.project.id);
    expect(h.rt.conversations.get(sid).title).toBe("#1 Write the doc");
  } finally { await h.close(); }
});

test("the cap holds extra cards in todo; a run that ends without moving its card sends it to review", async () => {
  const h = await harness([
    fauxAssistantMessage([fauxText("finished without moving the card")]),
    call("board", { action: "update", id: 2, status: "done" }), fauxAssistantMessage([fauxText("done")]),
  ], { boardAuto: { maxConcurrent: 1 } });
  try {
    const pid = h.project.id;
    for (const subject of ["first", "second"]) await h.req("POST", `/v1/projects/${pid}/cards`, { subject, status: "todo", priority: subject === "first" ? "high" : "low", auto: true });
    await h.until(() => h.board.get(pid, 1)!.status !== "todo", "first card claimed");
    expect(h.board.get(pid, 2)!.status).toBe("todo") /* "second card waits for a free slot" */;
    await h.until(() => h.board.get(pid, 1)!.status === "review", "first card in review");
    await h.until(() => h.board.get(pid, 2)!.status === "done", "second card done");
  } finally { await h.close(); }
});

test("a waiting or blocked card does not start", async () => {
  const h = await harness([]);
  try {
    const pid = h.project.id;
    await h.req("POST", `/v1/projects/${pid}/cards`, { subject: "dep", status: "backlog" });
    await h.req("POST", `/v1/projects/${pid}/cards`, { subject: "waits", status: "todo", blockedBy: [1], auto: true });
    await h.req("POST", `/v1/projects/${pid}/cards`, { subject: "blocked", status: "todo", blocked: "needs a key", auto: true });
    await Bun.sleep(150);
    expect(h.board.get(pid, 2)!.status).toBe("todo");
    expect(h.board.get(pid, 3)!.status).toBe("todo");
    expect(h.board.get(pid, 3)!.blocked).toBe("needs a key");
    expect(h.board.get(pid, 2)!.owner).toBe("agent");
  } finally { await h.close(); }
});

test("the agent cannot arm a card; a finished blocker starts the card that waited on it", async () => {
  const h = await harness([
    call("board", { action: "create", subject: "from agent", status: "todo", auto: true }),
    call("board", { action: "update", id: 1, status: "done" }), fauxAssistantMessage([fauxText("first done")]),
    call("board", { action: "update", id: 3, status: "done" }), fauxAssistantMessage([fauxText("second done")]),
  ]);
  try {
    const pid = h.project.id;
    await h.req("POST", `/v1/projects/${pid}/cards`, { subject: "first", status: "backlog" });
    await h.req("POST", `/v1/projects/${pid}/cards`, { subject: "placeholder", status: "backlog" });
    await h.req("POST", `/v1/projects/${pid}/cards`, { subject: "after first", status: "todo", blockedBy: [1], auto: true });
    await h.req("PATCH", `/v1/projects/${pid}/cards/2`, { archived: true });
    await h.req("PATCH", `/v1/projects/${pid}/cards/1`, { status: "todo", auto: true });
    await h.until(() => h.board.get(pid, 3)!.status === "done", "waiting card done");
    expect(h.board.get(pid, 1)!.status).toBe("done");
    const made = h.board.list(pid).find(c => c.subject === "from agent")!;
    expect(made.auto).toBe(null);
    expect(made.status).toBe("todo");
  } finally { await h.close(); }
});
