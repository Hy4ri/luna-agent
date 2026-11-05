// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { segments, MAX_WIDGETS } from "../../web/src/lib/segments.ts";
import { parseWidget } from "../../web/src/lib/widgets/schema.ts";

const fence = (lang: string, body: string, close = true) => `\`\`\`${lang}\n${body}\n${close ? "```\n" : ""}`;

test("rich fences become blocks in order", () => {
  const text = `intro\n${fence("mermaid", "graph TD; A-->B")}mid\n${fence("math", "e^{i\\pi}+1=0")}${fence("html", "<b>x</b>")}${fence("ts", "const a = 1")}`;
  const blocks = segments(text).filter(s => s.kind === "block");
  assert.deepEqual(blocks.map(b => b.kind === "block" && [b.lang, b.source, b.closed]), [
    ["mermaid", "graph TD; A-->B", true],
    ["math", "e^{i\\pi}+1=0", true],
    ["html", "<b>x</b>", true],
  ]);
  assert.ok(segments(text).some(s => s.kind === "md" && s.text.includes("const a = 1")), "other languages stay markdown");
});

test("an unclosed fence is reported as open", () => {
  const [, block] = segments(`a\n${fence("mermaid", "graph TD", false)}`);
  assert.equal(block?.kind === "block" && block.closed, false);
});

test("only ui and html count toward the preview limit", () => {
  const many = Array.from({ length: MAX_WIDGETS + 1 }, () => fence("html", "<i>x</i>")).join("") + fence("mermaid", "graph TD") + fence("math", "x");
  const blocks = segments(many).flatMap(s => (s.kind === "block" ? [s] : []));
  assert.deepEqual(blocks.map(b => b.excess === true), [...new Array(MAX_WIDGETS).fill(false), true, false, false]);
});

test("chart kinds and stacked", () => {
  const chart = (extra: object) => JSON.stringify({ type: "chart", x: ["a", "b"], series: [{ name: "s", data: [1, 2] }], ...extra });
  for (const kind of ["line", "area", "bar", "pie", "donut"]) assert.equal(parseWidget(chart({ kind })).ok, true, kind);
  assert.equal(parseWidget(chart({ kind: "radar" })).ok, false);

  const bar = parseWidget(chart({ kind: "bar", stacked: true }));
  assert.ok(bar.ok && bar.widget.type === "chart" && bar.widget.stacked === true);
  const line = parseWidget(chart({ kind: "line", stacked: true }));
  assert.ok(line.ok && line.widget.type === "chart" && line.widget.stacked === false, "stacked is ignored for line");
  assert.equal(parseWidget(chart({ kind: "bar", stacked: "yes" })).ok, false);
});

test("pie and donut validation", () => {
  const two = JSON.stringify({ type: "chart", kind: "pie", x: ["a", "b"], series: [{ name: "s", data: [1, 2] }, { name: "t", data: [3, 4] }] });
  assert.equal(parseWidget(two).ok, false, "one series only");
  const negative = JSON.stringify({ type: "chart", kind: "donut", x: ["a", "b"], series: [{ name: "s", data: [-1, 2] }] });
  assert.equal(parseWidget(negative).ok, false);
  const zero = JSON.stringify({ type: "chart", kind: "pie", x: ["a", "b"], series: [{ name: "s", data: [0, 0] }] });
  assert.equal(parseWidget(zero).ok, false);
  const x = Array.from({ length: 13 }, (_, i) => `s${i}`);
  const big = JSON.stringify({ type: "chart", kind: "pie", x, series: [{ name: "s", data: x.map(() => 1) }] });
  assert.equal(parseWidget(big).ok, false, "at most 12 slices");
});
