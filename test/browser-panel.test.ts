// The browser panel: session-owned tabs, the control lock, the HTTP routes, and the live stream.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { context, openLuna } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { BrowserPanel, parseInput, pngSize, type BrowserWsData } from "../src/browser/panel.js";
import { createBrowserToolsExtension, type BrowserInput, type BrowserProvider } from "../src/browser-tools.js";
import { rejectsWith } from "./support/expect-error.js";

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
  const server = Bun.serve<BrowserWsData>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req, srv) {
      const r = panel.tryUpgrade(req, srv);
      if (r !== undefined) return r ?? undefined;
      return app.fetch(req);
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws) { panel.wsOpen(ws); },
      message(ws, msg) { panel.wsMessage(ws, msg); },
      close(ws) { panel.wsClose(ws); },
    },
  });
  const port = server.port!;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init.headers } });
  const session = async () => ((await (await call("/v1/sessions", { method: "POST", body: "{}" })).json()) as { id: number }).id;
  return {
    panel, state, fake, call, session, port,
    async cleanup() { panel.closeAll(); await server.stop(true); await harness.close(context).catch(() => {}); await rm(dir, { recursive: true, force: true }); },
  };
}

async function until(fn: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); }
  expect.unreachable(`timed out waiting for ${what}`);
}
function attach(port: number, tab: string, ticket: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/browser/${tab}/attach?ticket=${ticket}`, { headers } as unknown as string);
  ws.binaryType = "arraybuffer";
  const got = { json: [] as { type: string; [k: string]: unknown }[], binary: 0 };
  ws.addEventListener("message", event => { if (typeof event.data !== "string") got.binary++; else got.json.push(JSON.parse(event.data)); });
  const opened = new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", e => {
      const msg = (e as ErrorEvent).message || "HTTP error";
      const m = /status code:\s*(\d+)/.exec(msg);
      rej(new Error(m ? `HTTP ${m[1]}` : msg));
    }, { once: true });
  });
  return { ws, got, opened };
}
const ticket = async (s: Awaited<ReturnType<typeof setup>>, sid: number, tab: string) =>
  ((await (await s.call(`/v1/sessions/${sid}/browser/${tab}/ticket`, { method: "POST" })).json()) as { ticket: string }).ticket;

test("pngSize reads the IHDR chunk", () => { expect(pngSize(PNG)).toStrictEqual({ width: 1, height: 1 }); expect(pngSize(Buffer.from("nope"))).toStrictEqual({ width: 0, height: 0 }); });

test("parseInput accepts panel events and rejects the rest", () => {
  expect(parseInput({ kind: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 9 })).toStrictEqual({ kind: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 3 });
  expect(parseInput({ kind: "mouse", type: "down", x: "1", y: 2 })).toBe(undefined);
  expect(parseInput({ kind: "key", type: "down", key: "" })).toBe(undefined);
  expect(parseInput({ kind: "nav", action: "goto", url: "file:///etc/passwd" })).toBe(undefined);
  expect(parseInput({ kind: "nav", action: "goto", url: "https://x.test/" })).toStrictEqual({ kind: "nav", action: "goto", url: "https://x.test/" });
  expect(parseInput({ kind: "eval", code: "1" })).toBe(undefined);
});

test("tabs the tools open belong to the session and drop on close", async () => {
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => fakeProvider().provider });
  const { provider } = fakeProvider();
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = (name: string, args: Record<string, unknown>, conversationId = "7") =>
    (tools.get(name)!.execute as (a: unknown, api: unknown, c: unknown) => Promise<unknown>)(args, { conversationId }, {});
  await run("browser", { action: "open", url: "https://x.test/" });
  expect(panel.list(7).map(t => [t.tabId, t.owner])).toStrictEqual([["t1", "agent"]]);
  expect(panel.list(8)).toStrictEqual([]);
  await run("browser", { action: "navigate", tabId: "t1", url: "https://x.test/b" });
  expect(panel.list(7)[0]!.url).toBe("https://x.test/b");
  await run("browser", { action: "close", tabId: "t1" });
  expect(panel.list(7)).toStrictEqual([]);
});

test("browser tabs are two-way always: Luna and the user can both act without locking", async () => {
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => fakeProvider().provider });
  const { provider, calls } = fakeProvider({ input: async () => undefined });
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = (name: string, args: Record<string, unknown>) => (tools.get(name)!.execute as (a: unknown, api: unknown, c: unknown) => Promise<unknown>)(args, { conversationId: "7" }, {});
  await run("browser", { action: "open", url: "https://x.test/" });
  await run("browser_act", { action: "click", tabId: "t1", selector: "a" });
  await run("browser", { action: "navigate", tabId: "t1", url: "https://x.test/c" });
  await run("browser", { action: "screenshot", tabId: "t1" });
  expect(calls).toStrictEqual(["open", "click", "navigate", "screenshot"]);
});

test("list route is scoped to the session and reports when the panel is off", async () => {
  const s = await setup();
  try {
    const a = await s.session(), b = await s.session();
    s.panel.opened({ session: a, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const listA = (await (await s.call(`/v1/sessions/${a}/browser`)).json()) as { enabled: boolean; tabs: { tabId: string; live: boolean; input: boolean }[] };
    expect(listA.enabled).toBe(true);
    expect(listA.tabs.map(t => [t.tabId, t.live, t.input])).toStrictEqual([["t1", false, false]]);
    expect(((await (await s.call(`/v1/sessions/${b}/browser`)).json()) as { tabs: unknown[] }).tabs).toStrictEqual([]);
    expect((await s.call(`/v1/sessions/${b}/browser/t1/ticket`, { method: "POST" })).status).toBe(404);
    s.state.enabled = false;
    expect(await (await s.call(`/v1/sessions/${a}/browser`)).json()).toStrictEqual({ enabled: false, tabs: [] });
    expect((await s.call(`/v1/sessions/${a}/browser`, { method: "POST", body: JSON.stringify({ url: "https://x.test/" }) })).status).toBe(403);
    expect((await s.call("/v1/sessions/999/browser")).status).toBe(404);
  } finally { await s.cleanup(); }
});

test("the user opens and closes a tab from the panel", async () => {
  const s = await setup({ input: async () => undefined });
  try {
    const sid = await s.session();
    expect((await s.call(`/v1/sessions/${sid}/browser`, { method: "POST", body: JSON.stringify({ url: "file:///etc/passwd" }) })).status).toBe(400);
    const open = await s.call(`/v1/sessions/${sid}/browser`, { method: "POST", body: JSON.stringify({ url: "https://x.test/" }) });
    expect(open.status).toBe(201);
    const tab = (await open.json()) as { tabId: string; owner: string; input: boolean };
    expect([tab.owner, tab.input]).toStrictEqual(["user", true]);
    expect((await s.call(`/v1/sessions/${sid}/browser/${tab.tabId}`, { method: "DELETE" })).status).toBe(200);
    expect(s.panel.list(sid)).toStrictEqual([]);
    expect(s.fake.calls).toStrictEqual(["open", "close"]);
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
    await rejectsWith(attach(s.port, "t1", t1).opened, /HTTP 401/);
    const stale = await ticket(s, sid, "t1");
    s.state.now += 31_000;
    await rejectsWith(attach(s.port, "t1", stale).opened, /HTTP 401/);
    await rejectsWith(attach(s.port, "t1", await ticket(s, sid, "t1"), { origin: "http://evil.test" }).opened, /HTTP 403/);
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
    expect([meta.width, meta.height, meta.url, meta.input, meta.live]).toStrictEqual([1, 1, "https://x.test/", false, false]);
    c.ws.close();
    await until(() => s.fake.calls.filter(x => x === "screenshot").length >= 2, "screenshots");
    const seen = s.fake.calls.length;
    await new Promise(r => setTimeout(r, 120));
    expect(s.fake.calls.length <= seen + 1, "polling stops after the last socket leaves").toBeTruthy();
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
    expect([meta.width, meta.height, meta.url, meta.live]).toStrictEqual([800, 600, "https://x.test/live", true]);
    expect(!s.fake.calls.includes("screenshot")).toBeTruthy();
    a.ws.close();
    await new Promise(r => setTimeout(r, 50));
    expect(aborted).toBe(false);
    b.ws.close();
    await until(() => aborted, "feed stop");
  } finally { await s.cleanup(); }
});

test("input reaches the provider immediately without taking control", async () => {
  const events = [] as BrowserInput[];
  const s = await setup({ input: async ({ event }) => { events.push(event); return event.kind === "nav" ? { url: "https://x.test/next" } : undefined; } });
  try {
    const sid = await s.session();
    s.panel.opened({ session: sid, worker: null, tabId: "t1", url: "https://x.test/", provider: s.fake.provider });
    const c = attach(s.port, "t1", await ticket(s, sid, "t1"));
    await c.opened;
    const click = JSON.stringify({ type: "input", event: { kind: "mouse", type: "down", x: 5, y: 6 } });
    c.ws.send(click);
    c.ws.send(JSON.stringify({ type: "input", event: { kind: "nav", action: "goto", url: "https://x.test/next" } }));
    c.ws.send(JSON.stringify({ type: "input", event: { kind: "nav", action: "goto", url: "javascript:alert(1)" } }));
    await until(() => events.length === 2, "two events");
    expect((events as BrowserInput[]).map(e => e.kind)).toStrictEqual(["mouse", "nav"]);
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

test("browser list shows the session's tabs, including the ones the user opens and closes", async () => {
  const { provider } = fakeProvider();
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => provider });
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = async (args: Record<string, unknown>, conversationId = "7") =>
    JSON.parse(((await (tools.get("browser")!.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ output: { text: string }[] }>)(args, { conversationId }, {})).output[0]!.text));
  await run({ action: "open", url: "https://x.test/" });
  const mine = await panel.open(7, null, "https://example.test/", new AbortController().signal);
  await panel.open(8, null, "https://other.test/", new AbortController().signal);
  expect((await run({ action: "list" })).tabs.map((t: { tabId: string; url: string; openedBy: string }) => [t.tabId, t.url, t.openedBy])).toStrictEqual([["t1", "https://x.test/", "Luna"], [mine.tabId, "https://example.test/", "the user"]]);
  await panel.close(7, mine.tabId);
  expect((await run({ action: "list" })).tabs.map((t: { tabId: string }) => t.tabId)).toStrictEqual(["t1"]);
});

test("browser list drops tabs the provider lost, and tells Luna once", async () => {
  const alive = new Set<string>();
  const { provider } = fakeProvider({ has: id => alive.has(id) });
  const opened = provider.open;
  provider.open = async (req, s) => { const tab = await opened(req, s); alive.add(tab.tabId); return tab; };
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => provider });
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = async (args: Record<string, unknown>) =>
    (await (tools.get("browser")!.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ output: { text: string }[] }>)(args, { conversationId: "7" }, {})).output.map(o => o.text);
  await run({ action: "open", url: "https://x.test/" });
  await run({ action: "open", url: "https://y.test/" });
  alive.clear(); alive.add("t2"); // the browser restarted and only t2 came back, say
  const [list, note] = await run({ action: "list" });
  expect(JSON.parse(list!).tabs.map((t: { tabId: string }) => t.tabId)).toStrictEqual(["t2"]);
  expect(note!).toMatch(/t1 is gone \(the page closed or the browser restarted\)/);
  expect((await run({ action: "list" })).length, "the notice comes once").toBe(1);
  expect(panel.get("t1")).toBe(undefined);
});

test("browser list without the panel says how to turn it on", async () => {
  const { provider } = fakeProvider();
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]));
  const tab = (ext.tools ?? []).find(t => t.name === "browser")!;
  await rejectsWith((tab.execute as (a: unknown, api: unknown, c: unknown) => Promise<unknown>)({ action: "list" }, { conversationId: "7" }, {}), /browser\.panel/);
});

test("what the user does in the panel reaches Luna once, on her next browser call", async () => {
  const { provider } = fakeProvider({ input: async () => undefined });
  const panel = new BrowserPanel({ enabled: () => true, resolve: async () => provider });
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", provider]]), { panel });
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const run = async (name: string, args: Record<string, unknown>) =>
    (await (tools.get(name)!.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ output: { text?: string }[] }>)(args, { conversationId: "7" }, {})).output.map(o => o.text ?? "").join("\n");
  await run("browser", { action: "open", url: "https://x.test/" });
  const mine = await panel.open(7, null, "https://example.test/", new AbortController().signal);
  await panel.close(7, mine.tabId);
  await panel.open(8, null, "https://other.test/", new AbortController().signal);
  const first = await run("browser", { action: "snapshot", tabId: "t1" });
  expect(first).toMatch(new RegExp(`the user opened ${mine.tabId} at https://example.test/; the user closed ${mine.tabId}`));
  expect(first).not.toMatch(/other\.test/);
  expect(await run("browser", { action: "snapshot", tabId: "t1" })).not.toMatch(/in the panel/);
});
