// Contract: the memory prompt section is sent with every model call. It must stay within its budget, keep a stable
// order (a reordered section breaks the prompt cache), show facts before notes, and say when entries are hidden.
import { afterAll as after, test, expect } from "bun:test";
import { MemoryStore } from "../src/memory.js";

const stores: MemoryStore[] = [];
const open = (opts?: ConstructorParameters<typeof MemoryStore>[1]) => { const s = new MemoryStore(":memory:", opts); stores.push(s); return s; };
after(() => { for (const s of stores) s.close(); });

test("facts upsert by key; notes append", () => {
  const m = open();
  m.remember({ key: "printer.ip", content: "192.168.1.36" });
  m.remember({ key: "printer.ip", content: "192.168.1.37" });
  m.remember({ content: "first note" });
  m.remember({ content: "first note" });
  const text = m.render()!;
  expect(text.match(/printer\.ip/g)?.length).toBe(1);
  expect(text).toMatch(/printer\.ip: 192\.168\.1\.37/);
  expect(text.match(/first note/g)?.length).toBe(2);
  expect(() => m.remember({ kind: "fact", content: "x" })).toThrow(/needs a key/);
  expect(() => m.remember({ content: "   " })).toThrow(/empty/);
});

test("render: facts sorted by key, then newest notes first, independent of insertion order", () => {
  const a = open(), b = open();
  a.remember({ key: "b.key", content: "B" }); a.remember({ key: "a.key", content: "A" });
  b.remember({ key: "a.key", content: "A" }); b.remember({ key: "b.key", content: "B" });
  for (const m of [a, b]) { m.remember({ content: "older" }); m.remember({ content: "newer" }); }
  const text = a.render()!;
  expect(text.replace(/#\d+/g, "#")).toBe(b.render()!.replace(/#\d+/g, "#"));
  expect(a.render()).toBe(text) /* "rendering twice gives the same bytes" */;
  const order = ["Facts:", "a.key", "b.key", "Recent notes:", "newer", "older"].map(s => text.indexOf(s));
  expect(order).toEqual([...order].sort((x, y) => x - y)) /* text */;
});

const fill = () => {
  const m = open({ budget: 500, maxNotes: 1000 });
  for (let i = 0; i < 50; i++) m.remember({ content: `note ${i} ${"x".repeat(40)}` });
  return m.render()!;
};

test("render stays within the budget and drops the oldest notes first", () => {
  const text = fill();
  expect(text.length <= 500).toBeTruthy() /* `${text.length} chars` */;
  expect(text).toMatch(/note 49 /) /* "the newest note is kept" */;
  expect(text).not.toMatch(/note 0 /) /* "the oldest note is dropped first" */;
});

test("render reports hidden entries even when the notes fill the budget", () => {
  const text = fill();
  expect(text).toMatch(/more entries not shown; use the memory tool action=search/);
  expect(text.length <= 500).toBeTruthy() /* `${text.length} chars` */;
});

test("render reports hidden entries when facts and digest consume the budget", () => {
  const m = open({ budget: 300, maxNotes: 100 });
  m.remember({ key: "fact.heavy", content: "f".repeat(250) });
  m.remember({ content: "note 1" });
  m.remember({ content: "note 2" });
  const text = m.render()!;
  expect(text).toMatch(/more entries not shown; use the memory tool action=search/);
  expect(text.length <= 300).toBeTruthy() /* `${text.length} chars` */;
});

test("long entries are cut to one line", () => {
  const m = open();
  m.remember({ key: "k", content: `line one\nline two ${"y".repeat(400)}` });
  const line = m.render()!.split("\n").find(l => l.startsWith("- k:"))!;
  expect(line.endsWith("…") && line.length <= 300 + "- k: ".length).toBeTruthy() /* line */;
});

test("compact folds the oldest notes into a bounded digest and keeps newer ones", () => {
  const m = open({ budget: 1000, maxNotes: 8 });
  for (let i = 0; i < 20; i++) m.remember({ content: `n${i} ${"z".repeat(30)}` });
  m.compact();
  const text = m.render()!;
  expect(text).toMatch(/Older notes \(digest\):/);
  const recent = text.slice(text.indexOf("Recent notes:"));
  expect(recent.match(/^- \[#/gm)?.length).toBe(8); /* "maxNotes live notes remain" */
  expect(recent).toMatch(/n19 /);
  const digest = text.slice(text.indexOf("Older notes"), text.indexOf("Recent notes:"));
  expect(digest.length <= 1000 / 2 + "Older notes (digest):\n".length).toBeTruthy(); /* `${digest.length}` */
});

test("an empty store renders no section", () => {
  expect(open().render()).toBe(undefined);
});
