import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { context, openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { localLauncher } from "../src/terminal/pty-host.js";
import { TerminalRegistry } from "../src/terminal/registry.js";
import { TerminalService } from "../src/terminal/service.js";
import { loadVt } from "../src/terminal/vt-model.js";

const TOKEN = "test-token";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "luna-terminal-http-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const state = { enabled: true, agent: false, now: 1_000_000 };
  const terminals = new TerminalService({
    registry: new TerminalRegistry({ launcher: localLauncher, env: { SHELL: "/bin/sh", PATH: process.env.PATH ?? "" }, vt: loadVt }),
    enabled: () => state.enabled,
    agentEnabled: () => state.agent,
    now: () => state.now,
    allowOrigin: (origin) => origin === "http://allowed.test",
  });
  conversations.subscribeDeleted(ids => { for (const id of ids) terminals.registry.closeSession(id); });
  const app = createApp({ harness, conversations, models, terminals, token: TOKEN, cwd: "/tmp", agent: { model: { provider: model.provider, modelId: model.id } } });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  terminals.attach(server as import("node:http").Server);
  await new Promise(r => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, init: RequestInit = {}, auth = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
    });
  const session = async () => ((await (await call("/v1/sessions", { method: "POST", body: "{}" })).json()) as { id: number }).id;
  return {
    state, terminals, call, session, port, conversations,
    async cleanup() {
      terminals.close();
      server.close();
      await harness.close(context).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

type Frames = { text: string; json: { type: string; [k: string]: unknown }[] };
function open(port: number, id: string, ticket: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/terminals/${id}/attach?ticket=${ticket}`, { headers });
  const frames: Frames = { text: "", json: [] };
  ws.on("message", (data, isBinary) => {
    if (isBinary) frames.text += (data as Buffer).toString("utf8");
    else frames.json.push(JSON.parse(String(data)));
  });
  const opened = new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
  return { ws, frames, opened };
}
async function until(fn: () => boolean, what: string) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); }
}
const create = async (t: Awaited<ReturnType<typeof setup>>, sid: number) =>
  (await (await t.call(`/v1/sessions/${sid}/terminals`, { method: "POST", body: JSON.stringify({ cols: 90, rows: 20 }) })).json()) as { id: string };
const ticket = async (t: Awaited<ReturnType<typeof setup>>, sid: number, id: string) =>
  ((await (await t.call(`/v1/sessions/${sid}/terminals/${id}/ticket`, { method: "POST" })).json()) as { ticket: string }).ticket;

test("terminals answer 403 and name the setting while terminal.user is off", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const id = (await create(t, sid)).id;
    t.state.enabled = false;
    const made = await t.call(`/v1/sessions/${sid}/terminals`, { method: "POST", body: "{}" });
    assert.equal(made.status, 403);
    assert.match(((await made.json()) as { error: string }).error, /terminal\.user/);
    assert.equal((await t.call(`/v1/sessions/${sid}/terminals/${id}/ticket`, { method: "POST" })).status, 403);
    const list = (await (await t.call(`/v1/sessions/${sid}/terminals`)).json()) as { enabled: boolean };
    assert.equal(list.enabled, false);
  } finally { await t.cleanup(); }
});

test("every terminal route needs the Bearer token", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    assert.equal((await t.call(`/v1/sessions/${sid}/terminals`, { method: "POST", body: "{}" }, false)).status, 401);
    assert.equal((await t.call(`/v1/sessions/${sid}/terminals`, {}, false)).status, 401);
  } finally { await t.cleanup(); }
});

test("a ticket opens one socket that carries input, output and resize, and it works only once", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const term = await create(t, sid);
    const tk = await ticket(t, sid, term.id);
    assert.ok(!tk.includes(TOKEN));
    const a = open(t.port, term.id, tk);
    await a.opened;
    await until(() => a.frames.json.some(f => f.type === "replay-end"), "replay-end");
    a.ws.send(Buffer.from("stty size; echo hello-$((6*7))\n"));
    await until(() => a.frames.text.includes("hello-42"), "shell output");
    assert.match(a.frames.text, /20 90/);
    a.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    a.ws.send(Buffer.from("stty size\n"));
    await until(() => a.frames.text.includes("30 100"), "resize");
    a.ws.close();

    await assert.rejects(open(t.port, term.id, tk).opened, /HTTP 401/);
  } finally { await t.cleanup(); }
});

test("an expired ticket, a missing ticket and a ticket for another terminal are refused", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const one = await create(t, sid), two = await create(t, sid);
    const old = await ticket(t, sid, one.id);
    t.state.now += 31_000;
    await assert.rejects(open(t.port, one.id, old).opened, /HTTP 401/);
    await assert.rejects(open(t.port, one.id, "").opened, /HTTP 401/);
    const forOne = await ticket(t, sid, one.id);
    await assert.rejects(open(t.port, two.id, forOne).opened, /HTTP 401/);
  } finally { await t.cleanup(); }
});

test("browser origins are checked and the setting is enforced at the socket", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const term = await create(t, sid);
    await assert.rejects(open(t.port, term.id, await ticket(t, sid, term.id), { origin: "http://evil.test" }).opened, /HTTP 403/);
    const ok = open(t.port, term.id, await ticket(t, sid, term.id), { origin: "http://allowed.test" });
    await ok.opened; ok.ws.close();
    const tk = await ticket(t, sid, term.id);
    t.state.enabled = false;
    await assert.rejects(open(t.port, term.id, tk).opened, /HTTP 403/);
  } finally { await t.cleanup(); }
});

test("another session cannot ticket or close this session's terminal", async () => {
  const t = await setup();
  try {
    const a = await t.session(), b = await t.session();
    const term = await create(t, a);
    assert.equal((await t.call(`/v1/sessions/${b}/terminals/${term.id}/ticket`, { method: "POST" })).status, 404);
    assert.equal((await t.call(`/v1/sessions/${b}/terminals/${term.id}`, { method: "DELETE" })).status, 404);
    assert.equal(t.terminals.registry.get(term.id)?.status, "running");
    assert.equal((await t.call(`/v1/sessions/${a}/terminals/${term.id}`, { method: "DELETE" })).status, 200);
    assert.equal(t.terminals.registry.get(term.id), undefined);
  } finally { await t.cleanup(); }
});

test("re-attaching replays earlier output exactly once and closing tells the client", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const term = await create(t, sid);
    const first = open(t.port, term.id, await ticket(t, sid, term.id));
    await first.opened;
    first.ws.send(Buffer.from("echo marker-$((1+1))\n"));
    await until(() => first.frames.text.includes("marker-2"), "first output");
    first.ws.close();
    await new Promise(r => first.ws.once("close", r));

    const second = open(t.port, term.id, await ticket(t, sid, term.id));
    await second.opened;
    await until(() => second.frames.json.some(f => f.type === "replay-end"), "replay-end");
    assert.equal(second.frames.text.split("marker-2").length - 1, 1, "output line once (the echoed command has $((1+1)))");
    assert.ok(second.frames.text.includes("echo marker-$((1+1))"));
    await t.call(`/v1/sessions/${sid}/terminals/${term.id}`, { method: "DELETE" });
    await until(() => second.frames.json.some(f => f.type === "closed"), "closed frame");
  } finally { await t.cleanup(); }
});

test("an exited shell is reported on the socket and deleting the session closes its terminals", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const term = await create(t, sid);
    const a = open(t.port, term.id, await ticket(t, sid, term.id));
    await a.opened;
    a.ws.send(Buffer.from("exit 4\n"));
    await until(() => a.frames.json.some(f => f.type === "exit" && f.exitCode === 4), "exit frame");
    const other = await create(t, sid);
    assert.equal((await t.call(`/v1/sessions/${sid}`, { method: "DELETE" })).status, 200);
    assert.equal(t.terminals.registry.get(other.id), undefined);
    assert.deepEqual(t.terminals.registry.list(sid), []);
  } finally { await t.cleanup(); }
});

test("control: m57 shares, gives, and takes back a terminal; the socket reports each change", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    const { id } = await create(t, sid);
    const control = (action: string) => t.call(`/v1/sessions/${sid}/terminals/${id}/control`, { method: "POST", body: JSON.stringify({ action }) });
    assert.equal((await control("share")).status, 403, "sharing needs terminal.agent");
    t.state.agent = true;
    assert.equal((await control("nope")).status, 400);
    assert.equal((await control("give")).status, 409, "give needs a shared terminal");
    const a = open(t.port, id, await ticket(t, sid, id));
    await a.opened;
    await until(() => a.frames.json.some(f => f.type === "replay-end"), "replay");
    assert.deepEqual(a.frames.json.find(f => f.type === "replay-start")?.controller, "user");
    const shared = await control("share");
    assert.equal(shared.status, 200);
    assert.deepEqual(((await shared.json()) as { shared: boolean }).shared, true);
    assert.equal((await control("give")).status, 200);
    await until(() => a.frames.json.some(f => f.type === "control" && f.controller === "agent"), "control frame");
    a.ws.send(Buffer.from("echo dropped-input\n"));
    t.terminals.registry.agentWrite(id, sid, "echo luna-$((40+2))\n");
    await until(() => a.frames.text.includes("luna-42"), "Luna's command");
    assert.ok(!a.frames.text.includes("dropped-input"), "m57's keys are dropped while Luna types");
    assert.equal((await control("take")).status, 200);
    await until(() => a.frames.json.some(f => f.type === "control" && f.controller === "user"), "take frame");
    assert.throws(() => t.terminals.registry.agentWrite(id, sid, "x"), /m57 has control/);
    assert.equal((await control("unshare")).status, 200);
    a.ws.close();
  } finally { await t.cleanup(); }
});

test("with only terminal.agent on, m57 can watch Luna's terminals but cannot open shells", async () => {
  const t = await setup();
  try {
    const sid = await t.session();
    t.state.enabled = false;
    t.state.agent = true;
    const mine = await t.terminals.registry.create({ session: sid, owner: "agent", worker: null, cwd: "/tmp", command: "cat" });
    const list = (await (await t.call(`/v1/sessions/${sid}/terminals`)).json()) as { enabled: boolean; agentEnabled: boolean; terminals: { id: string }[] };
    assert.equal(list.enabled, false);
    assert.equal(list.agentEnabled, true);
    assert.deepEqual(list.terminals.map(x => x.id), [mine.id]);
    assert.equal((await t.call(`/v1/sessions/${sid}/terminals`, { method: "POST", body: "{}" })).status, 403);
    const w = open(t.port, mine.id, await ticket(t, sid, mine.id));
    await w.opened;
    await until(() => w.frames.json.some(f => f.type === "replay-end"), "replay");
    w.ws.close();
    t.state.agent = false;
    assert.equal((await t.call(`/v1/sessions/${sid}/terminals/${mine.id}/ticket`, { method: "POST" })).status, 403);
  } finally { await t.cleanup(); }
});
