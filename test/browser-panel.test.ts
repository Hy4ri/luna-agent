// The browser panel: session-owned tabs, the control lock, the HTTP routes, and the live stream.
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
import { BrowserPanel, LOCK_MESSAGE, parseInput, pngSize } from "../src/browser/panel.js";
import { createBrowserToolsExtension, type BrowserInput, type BrowserProvider } from "../src/browser-tools.js";

const TOKEN = "test-token";
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function fakeProvider(extra: Partial<BrowserProvider> = {}) {
  const calls: string[] = [];
  let n = 0;
  const provider: BrowserProvider = {
    open: async req => { calls.push("open"); return { tabId: `t${++n}`, url: req.url }; },
    navigate: async req => { calls.push("navigate"); return req; },
    close: async () => { calls.push("close"); },
    snapshot: async req => ({ tabId: req.tabId, url: "https://x.test/", content: "page", hasMore: false }),
    click: async () => { calls.push("click"); },
    type: async () => { calls.push("type"); },
    scroll: async () => { calls.push("scroll"); },
    screenshot: async () => { calls.push("screenshot"); return { data: PNG.toString("base64"), mimeType: "image/png" }; },
    ...extra,
  };
  return { provider, calls };
}

async function setup(extra: Partial<BrowserProvider> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "luna-browser-panel-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  const conversations = new ConversationStore(harness);
  const fake = fakeProvider(extra);
  const state = { enabled: true, now: 1_000_000 };
  const panel = new BrowserPanel({ enabled: () => state.enabled, resolve: async () => fake.provider, now: () => state.now, pollMs: 20, allowOrigin: origin => origin === "http://allowed.test" });
  const app = createApp({ harness, conversations, models, browserPanel: panel, token: TOKEN, cwd: "/tmp", agent: { model: { provider: model.provider, modelId: model.id } } });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  panel.attach(server as import("node:http").Server);
  await new Promise(r => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init.headers } });
  const session = async () => ((await (await call("/v1/sessions", { method: "POST", body: "{}" })).json()) as { id: number }).id;
  return {
    panel, state, fake, call, session, port,
    async cleanup() { panel.closeAll(); server.close(); await harness.close(context).catch(() => {}); await rm(dir, { recursive: true, force: true }); },
  };
}

async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}
function attach(port: number, tab: string, ticket: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/browser/${tab}/attach?ticket=${ticket}`, { headers });
  const got = { json: [] as { type: string; [k: string]: unknown }[], binary: 0 };
  ws.on("message", (d, isBinary) => { if (isBinary) got.binary++; else got.json.push(JSON.parse(String(d))); });
  const opened = new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
  return { ws, got, opened };
}
const ticket = async (s: Awaited<ReturnType<typeof setup>>, sid: number, tab: string) =>
  ((await (await s.call(`/v1/sessions/${sid}/browser/${tab}/ticket`, { method: "POST" })).json()) as { ticket: string }).ticket;

test("pngSize reads the IHDR chunk", () => { assert.deepEqual(pngSize(PNG), { width: 1, height: 1 }); assert.deepEqual(pngSize(Buffer.from("nope")), { width: 0, height: 0 }); });

test("parseInput accepts panel events and rejects the rest", () => {
  assert.deepEqual(parseInput({ kind: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 9 }), { kind: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 3 });
  assert.equal(parseInput({ kind: "mouse", type: "down", x: "1", y: 2 }), undefined);
  assert.equal(parseInput({ kind: "key", type: "down", key: "" }), undefined);
  assert.equal(parseInput({ kind: "nav", action: "goto", url: "file:///etc/passwd" }), undefined);
  assert.deepEqual(parseInput({ kind: "nav", action: "goto", url: "https://x.test/" }), { kind: "nav", action: "goto", url: "https://x.test/" });
  assert.equal(parseInput({ kind: "eval", code: "1" }), undefined);
});

test("tabs the tools open belong to the session and drop on close", async () => {
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => fakeProvider().provider });
  const { provider } = fakeProvider();
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = (name: string, args: Record<string, unknown>, conversationId = "7") =>
    (tools.get(name)!.execute as (a: unknown, api: unknown, c: unknown) => Promise<unknown>)(args, { conversationId }, {});
  await run("browser_tab", { action: "open", url: "https://x.test/" });
  assert.deepEqual(panel.list(7).map(t => [t.tabId, t.owner, t.controller]), [["t1", "agent", "agent"]]);
  assert.deepEqual(panel.list(8), []);
  await run("browser_tab", { action: "navigate", tabId: "t1", url: "https://x.test/b" });
  assert.equal(panel.list(7)[0]!.url, "https://x.test/b");
  await run("browser_tab", { action: "close", tabId: "t1" });
  assert.deepEqual(panel.list(7), []);
});

test("while m57 holds a tab, Luna's actions on it fail and inspection still works", async () => {
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => fakeProvider().provider });
  const { provider, calls } = fakeProvider({ input: async () => undefined });
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = (name: string, args: Record<string, unknown>) => (tools.get(name)!.execute as (a: unknown, api: unknown, c: unknown) => Promise<unknown>)(args, { conversationId: "7" }, {});
  await run("browser_tab", { action: "open", url: "https://x.test/" });
  panel.control(7, "t1", "take");
  await assert.rejects(run("browser_act", { action: "click", tabId: "t1", selector: "a" }), new RegExp(LOCK_MESSAGE.slice(0, 20)));
  await assert.rejects(run("browser_tab", { action: "navigate", tabId: "t1", url: "https://x.test/c" }), /m57 is using this tab/);
  await assert.rejects(run("browser_tab", { action: "close", tabId: "t1" }), /m57 is using this tab/);
  assert.deepEqual(calls, ["open"]);
  await run("browser_inspect", { action: "screenshot", tabId: "t1" });
  panel.control(7, "t1", "give");
  await run("browser_act", { action: "click", tabId: "t1", selector: "a" });
  assert.deepEqual(calls, ["open", "screenshot", "click"]);
});

test("a view-only tab cannot be taken", async () => {
  const s = await setup();
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const r = await s.call(`/v1/sessions/${sid}/browser/t1/control`, { method: "POST", body: JSON.stringify({ action: "take" }) });
    assert.equal(r.status, 409);
  } finally { await s.cleanup(); }
});

test("list route is scoped to the session and reports when the panel is off", async () => {
  const s = await setup();
  try {
    const a = await s.session(), b = await s.session();
    s.panel.opened({ session: a, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const listA = (await (await s.call(`/v1/sessions/${a}/browser`)).json()) as { enabled: boolean; tabs: { tabId: string; live: boolean; input: boolean }[] };
    assert.equal(listA.enabled, true);
    assert.deepEqual(listA.tabs.map(t => [t.tabId, t.live, t.input]), [["t1", false, false]]);
    assert.deepEqual(((await (await s.call(`/v1/sessions/${b}/browser`)).json()) as { tabs: unknown[] }).tabs, []);
    assert.equal((await s.call(`/v1/sessions/${b}/browser/t1/ticket`, { method: "POST" })).status, 404);
    s.state.enabled = false;
    assert.deepEqual(await (await s.call(`/v1/sessions/${a}/browser`)).json(), { enabled: false, tabs: [] });
    assert.equal((await s.call(`/v1/sessions/${a}/browser`, { method: "POST", body: JSON.stringify({ url: "https://x.test/" }) })).status, 403);
    assert.equal((await s.call("/v1/sessions/999/browser")).status, 404);
  } finally { await s.cleanup(); }
});

test("m57 opens, takes, gives and closes a tab from the panel", async () => {
  const s = await setup({ input: async () => undefined });
  try {
    const sid = await s.session();
    assert.equal((await s.call(`/v1/sessions/${sid}/browser`, { method: "POST", body: JSON.stringify({ url: "file:///etc/passwd" }) })).status, 400);
    const open = await s.call(`/v1/sessions/${sid}/browser`, { method: "POST", body: JSON.stringify({ url: "https://x.test/" }) });
    assert.equal(open.status, 201);
    const tab = (await open.json()) as { tabId: string; controller: string; owner: string; input: boolean };
    assert.deepEqual([tab.controller, tab.owner, tab.input], ["user", "user", true]);
    const given = await s.call(`/v1/sessions/${sid}/browser/${tab.tabId}/control`, { method: "POST", body: JSON.stringify({ action: "give" }) });
    assert.equal(((await given.json()) as { controller: string }).controller, "agent");
    assert.equal((await s.call(`/v1/sessions/${sid}/browser/${tab.tabId}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(s.panel.list(sid), []);
    assert.deepEqual(s.fake.calls, ["open", "close"]);
  } finally { await s.cleanup(); }
});

test("a ticket works once, expires, and the origin policy applies", async () => {
  const s = await setup();
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const t1 = await ticket(s, sid, "t1");
    const first = attach(s.port, "t1", t1);
    await first.opened;
    first.ws.close();
    await assert.rejects(attach(s.port, "t1", t1).opened, /HTTP 401/);
    const stale = await ticket(s, sid, "t1");
    s.state.now += 31_000;
    await assert.rejects(attach(s.port, "t1", stale).opened, /HTTP 401/);
    await assert.rejects(attach(s.port, "t1", await ticket(s, sid, "t1"), { origin: "http://evil.test" }).opened, /HTTP 403/);
    const ok = attach(s.port, "t1", await ticket(s, sid, "t1"), { origin: "http://allowed.test" });
    await ok.opened;
    ok.ws.close();
  } finally { await s.cleanup(); }
});

test("without watch, the stream polls screenshots and sends meta then image frames", async () => {
  const s = await setup();
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const c = attach(s.port, "t1", await ticket(s, sid, "t1"));
    await c.opened;
    await until(() => c.got.binary >= 2, "two polled frames");
    const meta = c.got.json.filter(m => m.type === "meta").at(-1)!;
    assert.deepEqual([meta.width, meta.height, meta.url, meta.controller, meta.input, meta.live], [1, 1, "https://x.test/", "agent", false, false]);
    c.ws.close();
    await until(() => s.fake.calls.filter(x => x === "screenshot").length >= 2, "screenshots");
    const seen = s.fake.calls.length;
    await new Promise(r => setTimeout(r, 120));
    assert.ok(s.fake.calls.length <= seen + 1, "polling stops after the last socket leaves");
  } finally { await s.cleanup(); }
});

test("with watch, pushed frames reach every socket and the feed stops after the last one leaves", async () => {
  let aborted = false;
  let push: ((data: Buffer) => void) | undefined;
  const s = await setup({
    watch: (_req, onFrame, signal) => new Promise<void>(resolve => {
      push = data => onFrame({ data, width: 800, height: 600, url: "https://x.test/live" });
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    }),
  });
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const a = attach(s.port, "t1", await ticket(s, sid, "t1")), b = attach(s.port, "t1", await ticket(s, sid, "t1"));
    await Promise.all([a.opened, b.opened]);
    await until(() => !!push, "watch started");
    push!(PNG);
    await until(() => a.got.binary >= 1 && b.got.binary >= 1, "frames on both sockets");
    const meta = a.got.json.filter(m => m.type === "meta").at(-1)!;
    assert.deepEqual([meta.width, meta.height, meta.url, meta.live], [800, 600, "https://x.test/live", true]);
    assert.ok(!s.fake.calls.includes("screenshot"));
    a.ws.close();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(aborted, false);
    b.ws.close();
    await until(() => aborted, "feed stop");
  } finally { await s.cleanup(); }
});

test("input reaches the provider only while m57 drives", async () => {
  const events = [] as BrowserInput[];
  const s = await setup({ input: async ({ event }) => { events.push(event); return event.kind === "nav" ? { url: "https://x.test/next" } : undefined; } });
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const c = attach(s.port, "t1", await ticket(s, sid, "t1"));
    await c.opened;
    const click = JSON.stringify({ type: "input", event: { kind: "mouse", type: "down", x: 5, y: 6 } });
    c.ws.send(click);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(events, [], "dropped while Luna drives");
    await s.call(`/v1/sessions/${sid}/browser/t1/control`, { method: "POST", body: JSON.stringify({ action: "take" }) });
    await until(() => c.got.json.some(m => m.type === "meta" && m.controller === "user"), "meta shows m57 driving");
    c.ws.send(click);
    c.ws.send(JSON.stringify({ type: "input", event: { kind: "nav", action: "goto", url: "https://x.test/next" } }));
    c.ws.send(JSON.stringify({ type: "input", event: { kind: "nav", action: "goto", url: "javascript:alert(1)" } }));
    await until(() => events.length === 2, "two events");
    assert.deepEqual((events as BrowserInput[]).map(e => e.kind), ["mouse", "nav"]);
    await until(() => c.got.json.some(m => m.type === "meta" && m.url === "https://x.test/next"), "url update");
    c.ws.close();
  } finally { await s.cleanup(); }
});

test("a closed tab tells the socket and ends the feed", async () => {
  const s = await setup();
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const c = attach(s.port, "t1", await ticket(s, sid, "t1"));
    await c.opened;
    s.panel.closed("t1");
    await until(() => c.got.json.some(m => m.type === "closed"), "closed message");
  } finally { await s.cleanup(); }
});

test("browser_tab list shows the session's tabs, including the ones m57 opens and closes", async () => {
  const { provider } = fakeProvider();
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => provider });
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = async (args: Record<string, unknown>, conversationId = "7") =>
    JSON.parse(((await (tools.get("browser_tab")!.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ output: { text: string }[] }>)(args, { conversationId }, {})).output[0]!.text));
  await run({ action: "open", url: "https://x.test/" });
  const mine = await panel.open(7, null, "https://m57.test/", new AbortController().signal);
  await panel.open(8, null, "https://other.test/", new AbortController().signal);
  assert.deepEqual((await run({ action: "list" })).tabs.map((t: { tabId: string; url: string; openedBy: string; driving: string }) => [t.tabId, t.url, t.openedBy, t.driving]),
    [["t1", "https://x.test/", "Luna", "Luna"], [mine.tabId, "https://m57.test/", "m57", "m57"]]);
  await panel.close(7, mine.tabId);
  assert.deepEqual((await run({ action: "list" })).tabs.map((t: { tabId: string }) => t.tabId), ["t1"]);
});

test("browser_tab list without the panel says how to turn it on", async () => {
  const { provider } = fakeProvider();
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]));
  const tab = (ext.tools ?? []).find(t => t.name === "browser_tab")!;
  await assert.rejects((tab.execute as (a: unknown, api: unknown, c: unknown) => Promise<unknown>)({ action: "list" }, { conversationId: "7" }, {}), /browser\.panel/);
});
