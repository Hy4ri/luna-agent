// The three merged browser tools must route every action to the matching provider method and validate arguments.
import { test, expect } from "bun:test";
import { createBrowserToolsExtension, type BrowserProvider } from "../src/browser-tools.js";
import { rejectsWith } from "./support/expect-error.js";

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

test("browser tools are browser and browser_act", () => {
  expect([...setup().tools.keys()].sort()).toStrictEqual(["browser", "browser_act"]);
});

test("every browser action reaches its provider method", async () => {
  const { seen, call } = setup();
  await call("browser", { action: "open", url: "https://x.test/" });
  await call("browser", { action: "navigate", tabId: "t1", url: "https://x.test/b" });
  const snap = await call("browser", { action: "snapshot", tabId: "t1", offset: 5 });
  const shot = await call("browser", { action: "screenshot", tabId: "t1" });
  await call("browser_act", { action: "click", tabId: "t1", ref: "e1" });
  await call("browser_act", { action: "type", tabId: "t1", selector: "#q", text: "hi", pressEnter: true });
  await call("browser_act", { action: "scroll", tabId: "t1", direction: "down" });
  const closed = await call("browser", { action: "close", tabId: "t1" });
  expect(seen).toStrictEqual([
    ["open", { url: "https://x.test/" }],
    ["navigate", { tabId: "t1", url: "https://x.test/b" }],
    ["snapshot", { tabId: "t1", offset: 5 }],
    ["screenshot", { tabId: "t1" }],
    ["click", { tabId: "t1", ref: "e1" }],
    ["type", { tabId: "t1", selector: "#q", text: "hi", pressEnter: true }],
    ["scroll", { tabId: "t1", direction: "down", amount: 500 }],
    ["close", { tabId: "t1" }],
  ]);
  expect(snap.output[0]!.text!).toMatch(/"content":"page"/);
  expect(shot.output[1]!.type).toBe("image");
  expect(closed.output[0]!.text!).toMatch(/"closed":true/);
});

test("browser actions reject missing or conflicting arguments before any provider call", async () => {
  const { seen, call } = setup();
  await rejectsWith(call("browser", { action: "open" }), /URL is required/);
  await rejectsWith(call("browser", { action: "close" }), /Tab ID is required/);
  await rejectsWith(call("browser_act", { action: "click", tabId: "t1", ref: "e1", selector: "#a" }), /exactly one/);
  await rejectsWith(call("browser_act", { action: "type", tabId: "t1", ref: "e1" }), /Text is required/);
  await rejectsWith(call("browser_act", { action: "scroll", tabId: "t1" }), /direction is required/);
  await rejectsWith(call("browser_act", { action: "scroll", tabId: "t1", direction: "up", amount: 1.5 }), /amount must be an integer/);
  expect(seen).toStrictEqual([]);
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
  expect((await call("browser", { action: "back", tabId: "t1" })).url).toBe("https://x.test/prev");
  await call("browser_act", { action: "press", tabId: "t1", keys: "Escape" });
  await call("browser_act", { action: "press", tabId: "t1", selector: "#q", keys: "Control+A" });
  await call("browser_act", { action: "click", tabId: "t1", x: 10, y: 20, clickCount: 2 });
  await call("browser_act", { action: "hover", tabId: "t1", x: 5, y: 6 });
  await call("browser_act", { action: "hover", tabId: "t1", ref: "e3" });
  await call("browser_act", { action: "drag", tabId: "t1", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  expect((await call("browser_act", { action: "select", tabId: "t1", selector: "select", values: ["B"] })).value).toStrictEqual(["b"]);
  await call("browser_act", { action: "uncheck", tabId: "t1", ref: "e4" });
  await call("browser_act", { action: "upload", tabId: "t1", selector: "input", files: ["/tmp/a.png"] });
  expect((await call("browser_act", { action: "dialog", tabId: "t1", accept: true, text: "yes" })).armed).toBe("accept");
  await call("browser", { action: "wait", tabId: "t1", text: "Done", timeout: 3 });
  expect((await call("browser", { action: "logs", tabId: "t1", clear: true })).console[0].text).toBe("boom");
  expect((await call("browser_act", { action: "evaluate", tabId: "t1", script: "document.title" })).value).toStrictEqual({ title: "X" });
  expect(seen).toStrictEqual([
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
  expect((await call("browser_act", { action: "click", tabId: "t1", ref: "e1" })).dialogs).toStrictEqual([{ type: "confirm", message: "Sure?", answer: "dismissed" }]);
});

test("richer actions validate first, page scripts need the setting, and a basic provider says what it lacks", async () => {
  const { seen, call } = richSetup(false);
  await rejectsWith(call("browser_act", { action: "click", tabId: "t1", x: 1 }), /both x and y/);
  await rejectsWith(call("browser_act", { action: "click", tabId: "t1", x: 1, y: 2, ref: "e1" }), /not both/);
  await rejectsWith(call("browser_act", { action: "drag", tabId: "t1", path: [{ x: 1, y: 2 }] }), /at least two/);
  await rejectsWith(call("browser_act", { action: "press", tabId: "t1" }), /Keys is required/);
  await rejectsWith(call("browser_act", { action: "upload", tabId: "t1", selector: "input", files: ["a.png"] }), /absolute/);
  await rejectsWith(call("browser", { action: "wait", tabId: "t1" }), /text, selector, or state/);
  await rejectsWith(call("browser_act", { action: "evaluate", tabId: "t1", script: "1" }), /browser\.evaluate/);
  expect(seen).toStrictEqual([]);
  const basic = setup();
  await rejectsWith(basic.call("browser_act", { action: "press", tabId: "t1", keys: "Enter" }), /cannot press\. Nothing ran/);
  await rejectsWith(basic.call("browser", { action: "reload", tabId: "t1" }), /cannot history/);
});
