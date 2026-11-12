import { test, expect } from "bun:test";
import { dockTarget } from "../../web/src/lib/tool-view.ts";

test("browser calls target the tab named in the arguments", () => {
  expect(dockTarget("browser_act", { action: "click", tabId: "tab_1" }, "")).toEqual({ pane: "browser", id: "tab_1" });
  expect(dockTarget("browser", { action: "snapshot", tabId: "tab_2" }, "page text")).toEqual({ pane: "browser", id: "tab_2" });
});

test("browser open targets the tab handle in its result", () => {
  expect(dockTarget("browser", { action: "open", url: "https://example.com/" }, '{"tabId":"tab_3","url":"https://example.com/"}')).toEqual({ pane: "browser", id: "tab_3" });
});

test("browser calls without a handle open the pane only", () => {
  expect(dockTarget("browser_tab", { action: "list" }, "[]")).toEqual({ pane: "browser" });
  expect(dockTarget("browser_tab", { action: "open" }, "not json")).toEqual({ pane: "browser" });
});

test("terminal calls target the terminal id from the arguments or the screen header", () => {
  expect(dockTarget("terminal", { action: "send", id: "t1" }, "")).toEqual({ pane: "terminal", id: "t1" });
  expect(dockTarget("terminal", { action: "start" }, "terminal term_9 | running | 80x24\n$ ")).toEqual({ pane: "terminal", id: "term_9" });
  expect(dockTarget("terminal", { action: "list" }, "no terminals")).toEqual({ pane: "terminal" });
});

test("other tools have no dock target", () => {
  expect(dockTarget("bash", { command: "ls" }, "")).toBe(undefined);
  expect(dockTarget("read", { path: "a" }, "terminal t1 | x")).toBe(undefined);
});
