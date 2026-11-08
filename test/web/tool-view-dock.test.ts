import assert from "node:assert/strict";
import { test } from "bun:test";
import { dockTarget } from "../../web/src/lib/tool-view.ts";

test("browser calls target the tab named in the arguments", () => {
  assert.deepEqual(dockTarget("browser_act", { action: "click", tabId: "tab_1" }, ""), { pane: "browser", id: "tab_1" });
  assert.deepEqual(dockTarget("browser_inspect", { action: "snapshot", tabId: "tab_2" }, "page text"), { pane: "browser", id: "tab_2" });
});

test("browser_tab open targets the tab handle in its result", () => {
  assert.deepEqual(dockTarget("browser_tab", { action: "open", url: "https://example.com/" }, '{"tabId":"tab_3","url":"https://example.com/"}'), { pane: "browser", id: "tab_3" });
});

test("browser calls without a handle open the pane only", () => {
  assert.deepEqual(dockTarget("browser_tab", { action: "list" }, "[]"), { pane: "browser" });
  assert.deepEqual(dockTarget("browser_tab", { action: "open" }, "not json"), { pane: "browser" });
});

test("terminal calls target the terminal id from the arguments or the screen header", () => {
  assert.deepEqual(dockTarget("terminal", { action: "send", id: "t1" }, ""), { pane: "terminal", id: "t1" });
  assert.deepEqual(dockTarget("terminal", { action: "start" }, "terminal term_9 | running | 80x24\n$ "), { pane: "terminal", id: "term_9" });
  assert.deepEqual(dockTarget("terminal", { action: "list" }, "no terminals"), { pane: "terminal" });
});

test("other tools have no dock target", () => {
  assert.equal(dockTarget("bash", { command: "ls" }, ""), undefined);
  assert.equal(dockTarget("read", { path: "a" }, "terminal t1 | x"), undefined);
});
