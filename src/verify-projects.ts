import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const dir = mkdtempSync(join(process.cwd(), ".projects-test-"));
try {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel();
  const rt = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
  try {
    const app = createApp({ harness: rt.harness, models: rt.models, providers: rt.providers, settings: rt.settings, conversations: rt.conversations, projectExtensions: rt.projectExtensions,
      agent: { model: { provider: m.provider, modelId: m.id } }, token: "t" });
    const headers = { authorization: "Bearer t", "content-type": "application/json" };
    const call = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const proj = join(dir, "proj-a"), other = join(dir, "proj-b"); mkdirSync(proj); mkdirSync(other);

    const initial = await (await call("/v1/projects")).json() as { projects: { id: number; name: string; general?: boolean }[] };
    const general = initial.projects.find(p => p.general);
    assert.ok(general, "General project exists without user setup");
    assert.equal(general.name, "General");

    assert.equal(general.id, 0, "General uses the reserved, stable ID");
    assert.equal((await call(`/v1/projects/${general.id}`, "DELETE")).status, 409);
    assert.equal((await call(`/v1/projects/${general.id}`, "PATCH", { name: "Changed" })).status, 409);
    assert.equal((await call("/v1/projects/not-an-id/board")).status, 404);
    assert.equal((await call("/v1/projects/-1/board")).status, 404);
    assert.equal((await call("/v1/projects", "POST", { name: "general", cwd: proj })).status, 409);

    // Validation
    assert.equal((await call("/v1/projects", "POST", { name: "", cwd: proj })).status, 400);
    assert.equal((await call("/v1/projects", "POST", { name: "x", cwd: "relative/dir" })).status, 400);
    assert.equal((await call("/v1/projects", "POST", { name: "x", cwd: join(dir, "missing") })).status, 400);
    assert.equal((await call("/v1/projects", "POST", { name: "x", cwd: configPath })).status, 400);

    // Create, duplicate, list
    const created = await call("/v1/projects", "POST", { name: "Alpha", cwd: proj });
    assert.equal(created.status, 201);
    const a = await created.json() as { id: number; cwd: string };
    assert.equal(a.cwd, proj);
    assert.equal((await call("/v1/projects", "POST", { name: "alpha", cwd: other })).status, 409);
    assert.equal(((await (await call("/v1/projects")).json()) as { projects: unknown[] }).projects.length, 2);

    // A session in the project starts in the project directory; a normal session is unaffected.
    const normal = await (await call("/v1/sessions", "POST", {})).json() as { id: number };
    const inProj = await (await call("/v1/sessions", "POST", { project: a.id })).json() as { id: number };
    const cwdOf = async (id: number) => ((await (await call(`/v1/sessions/${id}`)).json()) as { agent: { cwd: string | null } }).agent.cwd;
    assert.equal(await cwdOf(inProj.id), proj);
    assert.notEqual(await cwdOf(normal.id), proj);
    // An explicit cwd wins over the project default.
    const explicit = await (await call("/v1/sessions", "POST", { project: a.id, cwd: other })).json() as { id: number };
    assert.equal(await cwdOf(explicit.id), other);
    assert.equal((await call("/v1/sessions", "POST", { project: 999 })).status, 400);

    // The session list reports the link.
    const list = (await (await call("/v1/sessions")).json() as { sessions: { id: number; project: number | null }[] }).sessions;
    assert.equal(list.find(s => s.id === inProj.id)?.project, a.id);
    assert.equal(list.find(s => s.id === normal.id)?.project, general.id);

    // Editing a project changes new sessions only.
    assert.equal((await call(`/v1/projects/${a.id}`, "PATCH", { cwd: other })).status, 200);
    assert.equal(await cwdOf(inProj.id), proj);
    const later = await (await call("/v1/sessions", "POST", { project: a.id })).json() as { id: number };
    assert.equal(await cwdOf(later.id), other);
    assert.equal((await call("/v1/projects/999", "PATCH", { name: "z" })).status, 404);

    // Deleting a project keeps its sessions and their directory, and clears the link.
    assert.equal((await call(`/v1/projects/${a.id}`, "DELETE")).status, 200);
    assert.equal((await call(`/v1/projects/${a.id}`, "DELETE")).status, 404);
    assert.equal(await cwdOf(inProj.id), proj);
    const after = (await (await call("/v1/sessions")).json() as { sessions: { id: number; project: number | null }[] }).sessions;
    assert.equal(after.find(s => s.id === inProj.id)?.project, general.id);

    // ---- board ----
    const toolsOf = async (id: number) => ((await (await call(`/v1/sessions/${id}`)).json()) as { agent: { tools: string[] } }).agent.tools;
    const b1 = await (await call("/v1/projects", "POST", { name: "Board One", cwd: proj })).json() as { id: number };
    const b2 = await (await call("/v1/projects", "POST", { name: "Board Two", cwd: other })).json() as { id: number };
    const bs = await (await call("/v1/sessions", "POST", { project: b1.id })).json() as { id: number };
    const plain = await (await call("/v1/sessions", "POST", {})).json() as { id: number };
    assert.ok((await toolsOf(bs.id)).includes("board"), "project session gets the board tool");
    assert.ok((await toolsOf(plain.id)).includes("board"), "plain session gets General board");
    assert.ok((await toolsOf(normal.id)).includes("board"));

    assert.ok((await toolsOf(inProj.id)).includes("board"), "deleted-project session falls back to General");
    const detail = await (await call(`/v1/sessions/${plain.id}`)).json() as { project: number };
    assert.equal(detail.project, general.id, "session detail exposes General without a list fetch");
    const explicitGeneral = await (await call("/v1/sessions", "POST", { project: general.id, cwd: other })).json() as { id: number };
    assert.equal(await cwdOf(explicitGeneral.id), other, "General keeps explicit session cwd");
    const defaultGeneral = await (await call("/v1/sessions", "POST", { project: general.id })).json() as { id: number };
    assert.equal(await cwdOf(defaultGeneral.id), await cwdOf(normal.id), "General keeps the daemon cwd default");

    // A legacy/unlinked conversation uses the shared General board through the actual model tool path.
    let generalStep = 0, generalPrompt = "";
    faux.setResponses([
      (c: any) => {
        generalPrompt = c.messages.filter((m: any) => m.role === "system").map((m: any) => Object.values(m.sections ?? {}).join("\n")).join("\n");
        return fauxAssistantMessage([fauxToolCall("board", { action: "create", subject: "Shared general card", description: "General specification" })], { stopReason: "toolUse" });
      },
      () => { generalStep++; return fauxAssistantMessage([fauxText("created")]); },
    ]);
    assert.ok((await call(`/v1/sessions/${normal.id}/messages`, "POST", { content: "create a general card" })).status < 300);
    for (let i = 0; i < 100 && !generalStep; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(generalStep, 1);
    assert.match(generalPrompt, /Project "General"/);
    assert.doesNotMatch(generalPrompt, /Project "Board One"/);
    const generalCards = rt.conversations.board.list(general.id);
    assert.equal(generalCards.length, 1);
    const generalCard = generalCards[0]!;
    let sharedPrompt = "", sharedStep = 0;
    faux.setResponses([
      (c: any) => {
        sharedPrompt = c.messages.filter((m: any) => m.role === "system").map((m: any) => Object.values(m.sections ?? {}).join("\n")).join("\n");
        return fauxAssistantMessage([fauxToolCall("board", { action: "update", id: generalCard.id, status: "in_progress" })], { stopReason: "toolUse" });
      },
      () => { sharedStep++; return fauxAssistantMessage([fauxText("updated")]); },
    ]);
    assert.ok((await call(`/v1/sessions/${plain.id}/messages`, "POST", { content: `Work on #${generalCard.id}` })).status < 300);
    for (let i = 0; i < 100 && !sharedStep; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(sharedStep, 1);
    assert.match(sharedPrompt, /description: General specification/);
    assert.equal(rt.conversations.board.get(general.id, generalCard.id)?.owner, `session ${plain.id}`);
    assert.equal((await call(`/v1/projects/${b1.id}/cards/${generalCard.id}`, "PATCH", { status: "done" })).status, 404);
    assert.equal((await call(`/v1/projects/${b1.id}/cards`, "POST", { subject: "Cross-board dependency", blockedBy: [generalCard.id] })).status, 400);

    // User CRUD and validation
    const mk = async (body: object) => call(`/v1/projects/${b1.id}/cards`, "POST", body);
    assert.equal((await mk({})).status, 400);
    assert.equal((await mk({ subject: "x", priority: "huge" })).status, 400);
    assert.equal((await mk({ subject: "x", status: "nope" })).status, 400);
    const c1 = await (await mk({ subject: "Write docs", description: "README", priority: "low", labels: ["docs"] })).json() as { id: number; status: string; priority: string };
    assert.equal(c1.status, "backlog"); assert.equal(c1.priority, "low");
    assert.equal((await call(`/v1/projects/${general.id}/cards/${c1.id}`, "PATCH", { status: "done" })).status, 404, "General cannot edit a named project card");
    const c2 = await (await mk({ subject: "Fix crash", priority: "urgent", blockedBy: [c1.id] })).json() as { id: number };
    assert.equal((await mk({ subject: "bad dep", blockedBy: [9999] })).status, 400);
    assert.equal((await call(`/v1/projects/${b1.id}/cards/${c1.id}`, "PATCH", { addBlockedBy: [c2.id] })).status, 400, "cycle rejected");
    assert.equal((await call(`/v1/projects/${b1.id}/cards/${c1.id}`, "PATCH", { addBlockedBy: [c1.id] })).status, 400, "self block rejected");
    const listed = (await (await call(`/v1/projects/${b1.id}/board`)).json() as { cards: { id: number }[] }).cards;
    assert.deepEqual(listed.map(c => c.id), [c2.id, c1.id], "urgent sorts first");
    // Cards are private to their project.
    assert.equal((await call(`/v1/projects/${b2.id}/cards/${c1.id}`, "PATCH", { status: "done" })).status, 404);
    assert.equal(((await (await call(`/v1/projects/${b2.id}/board`)).json()) as { cards: unknown[] }).cards.length, 0);
    assert.equal((await call("/v1/projects/9999/board")).status, 404);

    // The model uses the board tool; the prompt carries a compact summary.
    let prompt = "";
    let step = 0;
    faux.setResponses([
      (c: any) => { prompt = c.messages.filter((m: any) => m.role === "system").map((m: any) => Object.values(m.sections ?? {}).join("\n")).join("\n"); return fauxAssistantMessage([
        fauxToolCall("board", { action: "create", subject: "Model card", priority: "high", description: "found while working" }),
        fauxToolCall("board", { action: "update", id: c1.id, status: "in_progress" }),
        fauxToolCall("board", { action: "archive", id: c2.id }),
        fauxToolCall("board", { action: "get", id: 9999 }),
      ], { stopReason: "toolUse" }); },
      () => { step++; return fauxAssistantMessage([fauxText("done")]); },
    ]);
    const sent = await call(`/v1/sessions/${bs.id}/messages`, "POST", { content: "use the board" });
    assert.ok(sent.status < 300, "message accepted " + sent.status);
    for (let i = 0; i < 100 && !step; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(step, 1, "model finished its turn");
    assert.match(prompt, /Project "Board One"/); assert.match(prompt, /backlog 2/); assert.match(prompt, /#\d+ \[backlog\|urgent\] Fix crash/);
    const cards = (await (await call(`/v1/projects/${b1.id}/board`)).json() as { cards: { id: number; subject: string; status: string; owner: string | null }[] }).cards;
    assert.ok(cards.some(c => c.subject === "Model card"), "model created a card");
    const moved = cards.find(c => c.id === c1.id)!;
    assert.equal(moved.status, "in_progress"); assert.equal(moved.owner, `session ${bs.id}`);
    assert.ok(!cards.some(c => c.id === c2.id), "archived card leaves the active board");
    const archived = (await (await call(`/v1/projects/${b1.id}/board?archived=1`)).json() as { cards: { id: number }[] }).cards;
    assert.deepEqual(archived.map(c => c.id), [c2.id]);

    // Mentioning #<id> in a user message injects full details of that board item (even low-priority backlog/done items) into the board prompt section.
    const cLowTodo = await (await mk({ subject: "Low todo item", description: "Detailed spec for low todo", status: "todo", priority: "low", labels: ["ui"] })).json() as { id: number };
    let mentionPrompt = "";
    let mentionStep = 0;
    faux.setResponses([
      (c: any) => {
        mentionPrompt = c.messages.filter((m: any) => m.role === "system").map((m: any) => Object.values(m.sections ?? {}).join("\n")).join("\n");
        mentionStep++;
        return fauxAssistantMessage([fauxText("got mention")]);
      },
    ]);
    const sentMention = await call(`/v1/sessions/${bs.id}/messages`, "POST", { content: `Please implement #${cLowTodo.id} right now` });
    assert.ok(sentMention.status < 300, "mention message accepted " + sentMention.status);
    for (let i = 0; i < 100 && !mentionStep; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(mentionStep, 1, "model finished mention turn");
    assert.match(mentionPrompt, /Referenced board items:/);
    assert.match(mentionPrompt, new RegExp(`#${cLowTodo.id} \\[todo\\|low\\] Low todo item \\{ui\\}`));
    assert.match(mentionPrompt, /description: Detailed spec for low todo/);

    // The user can hard-delete; the model cannot (no delete action).
    assert.equal((await call(`/v1/projects/${b1.id}/cards/${c2.id}`, "DELETE")).status, 200);
    assert.equal((await call(`/v1/projects/${b1.id}/cards/${c2.id}`, "DELETE")).status, 404);
    // Deleting a project removes its cards.
    assert.equal((await call(`/v1/projects/${b1.id}`, "DELETE")).status, 200);
    assert.equal((rt.conversations.board.list(b1.id).length), 0);

    // Auth
    assert.equal((await app.request("/v1/projects")).status, 401);
    console.log("PROJECTS_OK");
  } finally { await rt.close?.(); }
  const reopened = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
  try {
    assert.equal(reopened.conversations.projects.list().filter(p => p.general).length, 1);
    assert.equal(reopened.conversations.board.list(0)[0]?.subject, "Shared general card", "General board survives runtime restart");
    console.log("GENERAL_BOARD_RESTART_OK");
  } finally { await reopened.close(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(0);
