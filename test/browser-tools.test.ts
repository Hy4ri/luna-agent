// The three merged browser tools must route every action to the matching provider method and validate arguments.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createBrowserToolsExtension, type BrowserProvider } from "../src/browser-tools.js";

function setup() {
  const seen: [string, unknown][] = [];
  const rec = (m: string) => async (req: unknown) => { seen.push([m, req]); };
  const fake: BrowserProvider = {
    open: async req => { seen.push(["open", req]); return { tabId: "t1", url: req.url }; },
    navigate: async req => { seen.push(["navigate", req]); return req; },
    close: rec("close") as BrowserProvider["close"],
    snapshot: async req => { seen.push(["snapshot", req]); return { tabId: req.tabId, url: "https://x.test/", content: "page", hasMore: false }; },
    click: rec("click") as BrowserProvider["click"],
    type: rec("type") as BrowserProvider["type"],
    scroll: rec("scroll") as BrowserProvider["scroll"],
    screenshot: async req => { seen.push(["screenshot", req]); return { data: "AA==", mimeType: "image/png" }; },
  };
  const ext = createBrowserToolsExtension(() => ({ provider: "fake" }), new Map([["fake", fake]]));
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    return (tool.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ output: { type: string; text?: string }[] }>)(prepared, {}, {});
  };
  return { seen, tools, call };
}

test("browser tools are browser_tab, browser_inspect, browser_act", () => {
  assert.deepEqual([...setup().tools.keys()].sort(), ["browser_act", "browser_inspect", "browser_tab"]);
});

test("every browser action reaches its provider method", async () => {
  const { seen, call } = setup();
  await call("browser_tab", { action: "open", url: "https://x.test/" });
  await call("browser_tab", { action: "navigate", tabId: "t1", url: "https://x.test/b" });
  const snap = await call("browser_inspect", { action: "snapshot", tabId: "t1", offset: 5 });
  const shot = await call("browser_inspect", { action: "screenshot", tabId: "t1" });
  await call("browser_act", { action: "click", tabId: "t1", ref: "e1" });
  await call("browser_act", { action: "type", tabId: "t1", selector: "#q", text: "hi", pressEnter: true });
  await call("browser_act", { action: "scroll", tabId: "t1", direction: "down" });
  const closed = await call("browser_tab", { action: "close", tabId: "t1" });
  assert.deepEqual(seen, [
    ["open", { url: "https://x.test/" }],
    ["navigate", { tabId: "t1", url: "https://x.test/b" }],
    ["snapshot", { tabId: "t1", offset: 5 }],
    ["screenshot", { tabId: "t1" }],
    ["click", { tabId: "t1", ref: "e1" }],
    ["type", { tabId: "t1", selector: "#q", text: "hi", pressEnter: true }],
    ["scroll", { tabId: "t1", direction: "down", amount: 500 }],
    ["close", { tabId: "t1" }],
  ]);
  assert.match(snap.output[0]!.text!, /"content":"page"/);
  assert.equal(shot.output[1]!.type, "image");
  assert.match(closed.output[0]!.text!, /"closed":true/);
});

test("browser actions reject missing or conflicting arguments before any provider call", async () => {
  const { seen, call } = setup();
  await assert.rejects(call("browser_tab", { action: "open" }), /URL is required/);
  await assert.rejects(call("browser_tab", { action: "close" }), /Tab ID is required/);
  await assert.rejects(call("browser_act", { action: "click", tabId: "t1", ref: "e1", selector: "#a" }), /exactly one/);
  await assert.rejects(call("browser_act", { action: "type", tabId: "t1", ref: "e1" }), /Text is required/);
  await assert.rejects(call("browser_act", { action: "scroll", tabId: "t1" }), /direction is required/);
  await assert.rejects(call("browser_act", { action: "scroll", tabId: "t1", direction: "up", amount: 1.5 }), /amount must be an integer/);
  assert.deepEqual(seen, []);
});

function richSetup(evaluate = false) {
  const seen: [string, unknown][] = [];
  let pending: { type: string; message: string; answer: "accepted" | "dismissed" }[] = [];
  const rec = (m: string, value?: unknown) => async (req: unknown) => { seen.push([m, req]); return value; };
  const fake: BrowserProvider = {
    open: async req => ({ tabId: "t1", url: req.url }), navigate: async req => req, close: async () => {},
    snapshot: async req => ({ tabId: req.tabId, url: "https://x.test/", content: "", hasMore: false }),
    click: async req => { seen.push(["click", req]); pending = [{ type: "confirm", message: "Sure?", answer: "dismissed" }]; },
    type: rec("type") as BrowserProvider["type"], scroll: rec("scroll") as BrowserProvider["scroll"],
    screenshot: async () => ({ data: "AA==", mimeType: "image/png" }),
    history: async req => { seen.push(["history", req]); return { tabId: req.tabId, url: "https://x.test/prev" }; },
    press: rec("press") as BrowserProvider["press"], pointer: rec("pointer") as BrowserProvider["pointer"], hover: rec("hover") as BrowserProvider["hover"],
    select: rec("select", ["b"]) as BrowserProvider["select"], check: rec("check") as BrowserProvider["check"], upload: rec("upload") as BrowserProvider["upload"],
    dialog: rec("dialog") as BrowserProvider["dialog"],
    wait: async req => { seen.push(["wait", req]); return { tabId: req.tabId, url: "https://x.test/" }; },
    logs: async req => { seen.push(["logs", req]); return { console: [{ type: "error", text: "boom" }], network: [], dialogs: [] }; },
    dialogs: async () => { const out = pending; pending = []; return out; },
    evaluate: async req => { seen.push(["evaluate", req]); return { title: "X" }; },
  };
  const ext = createBrowserToolsExtension(() => ({ provider: "fake", evaluate }), new Map([["fake", fake]]));
  const tools = new Map((ext.tools ?? []).map(t => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    const out = await (tool.execute as (a: unknown, api: unknown, c: unknown) => Promise<{ output: { type: string; text?: string }[] }>)(prepared, {}, {});
    return JSON.parse(out.output[0]!.text!);
  };
  return { seen, call };
}

test("richer actions reach their provider methods", async () => {
  const { seen, call } = richSetup(true);
  assert.equal((await call("browser_tab", { action: "back", tabId: "t1" })).url, "https://x.test/prev");
  await call("browser_act", { action: "press", tabId: "t1", keys: "Escape" });
  await call("browser_act", { action: "press", tabId: "t1", selector: "#q", keys: "Control+A" });
  await call("browser_act", { action: "click", tabId: "t1", x: 10, y: 20, clickCount: 2 });
  await call("browser_act", { action: "hover", tabId: "t1", x: 5, y: 6 });
  await call("browser_act", { action: "hover", tabId: "t1", ref: "e3" });
  await call("browser_act", { action: "drag", tabId: "t1", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  assert.deepEqual((await call("browser_act", { action: "select", tabId: "t1", selector: "select", values: ["B"] })).value, ["b"]);
  await call("browser_act", { action: "uncheck", tabId: "t1", ref: "e4" });
  await call("browser_act", { action: "upload", tabId: "t1", selector: "input", files: ["/tmp/a.png"] });
  assert.equal((await call("browser_act", { action: "dialog", tabId: "t1", accept: true, text: "yes" })).armed, "accept");
  await call("browser_inspect", { action: "wait", tabId: "t1", text: "Done", timeout: 3 });
  assert.equal((await call("browser_inspect", { action: "logs", tabId: "t1", clear: true })).console[0].text, "boom");
  assert.deepEqual((await call("browser_act", { action: "evaluate", tabId: "t1", script: "document.title" })).value, { title: "X" });
  assert.deepEqual(seen, [
    ["history", { tabId: "t1", action: "back" }],
    ["press", { tabId: "t1", keys: "Escape" }],
    ["press", { tabId: "t1", selector: "#q", keys: "Control+A" }],
    ["pointer", { tabId: "t1", action: "click", points: [{ x: 10, y: 20 }], clickCount: 2 }],
    ["pointer", { tabId: "t1", action: "hover", points: [{ x: 5, y: 6 }] }],
    ["hover", { tabId: "t1", ref: "e3" }],
    ["pointer", { tabId: "t1", action: "drag", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    ["select", { tabId: "t1", selector: "select", values: ["B"] }],
    ["check", { tabId: "t1", ref: "e4", checked: false }],
    ["upload", { tabId: "t1", selector: "input", files: ["/tmp/a.png"] }],
    ["dialog", { tabId: "t1", accept: true, promptText: "yes" }],
    ["wait", { tabId: "t1", timeoutMs: 3000, text: "Done" }],
    ["logs", { tabId: "t1", clear: true }],
    ["evaluate", { tabId: "t1", script: "document.title" }],
  ]);
});

test("a dialog an action raised comes back with its result", async () => {
  const { call } = richSetup();
  assert.deepEqual((await call("browser_act", { action: "click", tabId: "t1", ref: "e1" })).dialogs, [{ type: "confirm", message: "Sure?", answer: "dismissed" }]);
});

test("richer actions validate first, page scripts need the setting, and a basic provider says what it lacks", async () => {
  const { seen, call } = richSetup(false);
  await assert.rejects(call("browser_act", { action: "click", tabId: "t1", x: 1 }), /both x and y/);
  await assert.rejects(call("browser_act", { action: "click", tabId: "t1", x: 1, y: 2, ref: "e1" }), /not both/);
  await assert.rejects(call("browser_act", { action: "drag", tabId: "t1", path: [{ x: 1, y: 2 }] }), /at least two/);
  await assert.rejects(call("browser_act", { action: "press", tabId: "t1" }), /Keys is required/);
  await assert.rejects(call("browser_act", { action: "upload", tabId: "t1", selector: "input", files: ["a.png"] }), /absolute/);
  await assert.rejects(call("browser_inspect", { action: "wait", tabId: "t1" }), /text, selector, or state/);
  await assert.rejects(call("browser_act", { action: "evaluate", tabId: "t1", script: "1" }), /browser\.evaluate/);
  assert.deepEqual(seen, []);
  const basic = setup();
  await assert.rejects(basic.call("browser_act", { action: "press", tabId: "t1", keys: "Enter" }), /cannot press\. Nothing ran/);
  await assert.rejects(basic.call("browser_tab", { action: "reload", tabId: "t1" }), /cannot history/);
});
