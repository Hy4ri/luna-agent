import { test, expect } from "bun:test";
import { dockTarget, parseMediaAnalysis, toolSummary } from "../../web/src/lib/tool-view.ts";

test("media_analyze summary prefers source over question and parses truncated or full analysis JSON", () => {
  expect(toolSummary("media_analyze", { source: "/tmp/screenshot.png", question: "what is in this?" })).toBe("/tmp/screenshot.png");
  expect(toolSummary("media_analyze", { question: "fallback question" })).toBe("fallback question");
  expect(toolSummary("vision_analyze", { image_url: "https://example.com/a.png", question: "q" })).toBe("https://example.com/a.png");

  const fullNative = parseMediaAnalysis(JSON.stringify({
    success: true, route: "native", width: 800, height: 600, inputWidth: 1600, inputHeight: 1200,
    region: { x: 10, y: 20, width: 100, height: 80 },
  }));
  expect(fullNative?.route).toBe("native");
  expect(fullNative?.dimensions).toBe("800×600 (from 1600×1200)");
  expect(fullNative?.region).toBe("region 10,20 100×80");

  const truncatedAux = parseMediaAnalysis('{"success":true,"analysis":"Line 1\\nLine 2\n\n… [truncated 9000 bytes] …\n\nend"}');
  expect(truncatedAux?.analysis).toContain("Line 1\nLine 2");

  const withWarning = parseMediaAnalysis(JSON.stringify({ success: true, analysis: "Done", warning: "Downsampled frame rate" }));
  expect(withWarning?.warning).toBe("Downsampled frame rate");
  expect(withWarning?.analysis).toBe("Done");
});

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
