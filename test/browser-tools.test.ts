// The three merged browser tools must route every action to the matching provider method and validate arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
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
