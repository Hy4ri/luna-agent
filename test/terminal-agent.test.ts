// Luna's terminal: the headless screen, shared control, and the deferred `terminal` tool end to end.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Context as AiContext } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { bareShell, highlights, keyBytes, renderScreen, textBytes } from "../src/terminal/agent-tools.js";
import { localLauncher } from "../src/terminal/pty-host.js";
import { TerminalError, TerminalRegistry } from "../src/terminal/registry.js";
import { loadVt } from "../src/terminal/vt-model.js";
import { createVtRuntime } from "../src/terminal/vt-core.js";
import { rejectsWith, throwsWith } from "./support/expect-error.js";

const SH = { SHELL: "/bin/sh", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" };
const made: TerminalRegistry[] = [];
afterEach(() => { for (const r of made.splice(0)) r.closeAll(); });
const registry = () => { const r = new TerminalRegistry({ launcher: localLauncher, env: SH, vt: loadVt }); made.push(r); return r; };
const screenText = (r: TerminalRegistry, id: string, session = 1) => r.agentScreen(id, session).screen.lines.join("\n");

async function until(fn: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

test("the screen model renders overwrites, wide text, the alternate screen, and answers queries", async () => {
  const vt = await (await loadVt())(20, 4);
  try {
    vt.write(Buffer.alloc(0)); // a terminal shared before its first output replays nothing
    vt.write(Buffer.from("hello\r\nprog 10%\rprog 99%\r\n\x1b[6nمرحبا 你好"));
    const s = vt.screen();
    expect(s.lines).toStrictEqual(["hello", "prog 99%", "مرحبا 你好", ""]);
    expect(s.alternate).toBe(false);
    expect(vt.responses()).toBe("\x1b[3;1R");
    expect(vt.responses()).toBe("");
    vt.write(Buffer.from("\x1b[?1049h\x1b[?1h\x1b[HALT"));
    expect(vt.screen().alternate).toBe(true);
    expect(vt.mode(1)).toBe(true);
    expect(vt.screen().lines[0]).toBe("ALT");
    vt.write(Buffer.from("\x1b[?1049l"));
    expect(vt.screen().lines[0]).toBe("hello");
  } finally { vt.dispose(); }
  // A second terminal created in the same WASM instance after freeing the first stays clean and supports scrollback.
  const f = await loadVt();
  const vt2 = await f(10, 2);
  const vt3 = await f(16, 3);
  try {
    vt2.write(Buffer.from("0123456789ABCDEF\r\nsecond\r\nthird"));
    vt3.write(Buffer.from("\x1b[?2004hisolated"));
    expect(vt2.scrollback(10)).toStrictEqual(["0123456789", "ABCDEF"]);
    expect(vt2.screen().lines).toStrictEqual(["second", "third"]);
    expect(vt2.mode(2004)).toBe(false);
    expect(vt3.mode(2004)).toBe(true);
    expect(vt3.screen().lines).toStrictEqual(["isolated", "", ""]);
  } finally { vt2.dispose(); vt3.dispose(); }
});

// These are ABI contracts owned by our binding, not browser/UI tests. The headless snapshot
// tests cannot catch a uint64 scrollbar, by-value mouse struct, or malformed native selection.
test("the shared VT core returns styled dirty rows without losing headless updates", async () => {
  const runtime = await createVtRuntime(readFileSync(new URL("../src/terminal/ghostty-vt-1.0.1-small.wasm", import.meta.url)));
  const vt = runtime.create(10, 3);
  try {
    vt.setTheme(0xeeeeee, 0x121212, 0xff0000);
    const first = vt.frame(true);
    expect(first.lines.length).toBe(3);
    expect(first.scrollOffset).toBe(0);
    expect(vt.frame().lines.length).toBe(0);
    vt.write(Buffer.from("\x1b[38;2;17;34;51;48;2;68;85;102;1;3;4m你\x1b[0m"));
    expect(vt.screen().lines[0]).toBe("你");
    const frame = vt.frame(); // screen() must not consume the browser's dirty state.
    const cells = frame.lines.find(l => l.row === 0)!.cells;
    expect(cells.slice(0, 2).map(c => [c.text, c.width])).toStrictEqual([["你", 2], ["", 0]]);
    expect(cells[0]!.fg).toBe(0x112233);
    expect(cells[0]!.bg).toBe(0x445566);
    expect(cells[0]!.flags & 3).toBe(3);
    expect(cells[0]!.underline).toBe(1);
    expect(vt.frame().lines.length).toBe(0);
    vt.write(Buffer.from("\x1b[31mX\x1b[0m"));
    vt.frame();
    vt.write(Buffer.from("\x1b]4;1;#abcdef\x07")); // Global palette dirtiness does not mark individual rows dirty.
    expect(vt.frame().lines.find(l => l.row === 0)?.cells[2]?.fg).toBe(0xabcdef);
    vt.write(Buffer.from("\r\n1\r\n2\r\n3\r\n4"));
    expect(vt.frame().scrollOffset).toBe(0);
    vt.scroll(-2);
    expect(vt.frame().scrollOffset).toBe(2);
    vt.scrollToBottom();
    expect(vt.frame().scrollOffset).toBe(0);
    vt.resize(8, 4);
    expect([vt.frame(true).cols, vt.screen().rows]).toStrictEqual([8, 4]);
  } finally { vt.dispose(); }
});

test("the shared VT core encodes mode-aware input and copies native wrapped selections", async () => {
  const runtime = await createVtRuntime(readFileSync(new URL("../src/terminal/ghostty-vt-1.0.1-small.wasm", import.meta.url)));
  const vt = runtime.create(10, 3);
  const key = (key: string, code = key, ctrl = false, alt = false, shift = false) => vt.key({ key, code, ctrl, alt, shift, meta: false });
  const mouse = (button: number, action: "press" | "release" | "motion" = "press", buttons = 1) => vt.mouse({ action, button, buttons, x: 16, y: 17, mods: 0, cellWidth: 8, cellHeight: 17 });
  try {
    expect(key("ArrowUp")).toBe("\x1b[A");
    expect(key("c", "KeyC", true)).toBe("\x03");
    expect(key("x", "KeyX", false, true)).toBe("\x1bx");
    expect(key("ArrowLeft", "ArrowLeft", true)).toBe("\x1b[1;5D");
    expect(key("Tab", "Tab", false, false, true)).toBe("\x1b[Z");
    expect(vt.paste("a\nb")).toBe("a\rb");
    const fallbackKeys = [
      ["Enter", "\r"], ["Escape", "\x1b"], ["Backspace", "\x7f"], ["Tab", "\t"],
      ["ArrowUp", "\x1b[A"], ["ArrowDown", "\x1b[B"], ["ArrowLeft", "\x1b[D"], ["ArrowRight", "\x1b[C"],
      ["Home", "\x1b[H"], ["End", "\x1b[F"], ["PageUp", "\x1b[5~"], ["PageDown", "\x1b[6~"],
      ["Insert", "\x1b[2~"], ["Delete", "\x1b[3~"], [" ", " "], ["a", "a"], ["é", "é"], ["😀", "😀"],
    ] as const;
    for (const [name, expected] of fallbackKeys) expect(key(name, ""), `missing code: ${name}`).toBe(expected);
    expect(key("é", "", false, true)).toBe("\x1bé");
    expect(mouse(0)).toBe("");
    vt.write(Buffer.from("\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h"));
    expect(key("ArrowUp")).toBe("\x1bOA");
    expect(vt.paste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
    expect(mouse(0)).toBe("\x1b[<0;3;2M");
    expect(mouse(0, "release", 0)).toBe("\x1b[<0;3;2m");
    expect(mouse(3)).toBe("\x1b[<64;3;2M");
    expect(mouse(4)).toBe("\x1b[<65;3;2M");
    vt.write(Buffer.from("0123456789ABCDEF"));
    vt.select({ col: 0, row: 0 }, { col: 5, row: 1 });
    expect(vt.selectionText()).toBe("0123456789ABCDEF");
    expect(vt.frame().lines.filter(l => l.selection).map(l => [l.row, l.selection])).toStrictEqual([
      [0, { start: 0, end: 9 }], [1, { start: 0, end: 5 }],
    ]);
    vt.write(Buffer.from("\r\nnext\r\nlast"));
    expect(vt.selectionText()).toBe("0123456789ABCDEF"); // Terminal-owned refs track output scrolling.
    expect(vt.frame().lines.filter(l => l.selection).map(l => [l.row, l.selection])).toStrictEqual([[0, { start: 0, end: 5 }]]);
    vt.clearSelection();
    expect(vt.frame().lines.filter(l => l.selection).length).toBe(0);
    expect(vt.selectionText()).toBe("");
    vt.select({ col: 0, row: 0 }, { col: 5, row: 0 });
    expect(vt.selectionText()).toBe("ABCDEF"); // Viewport row 0 is not full-screen/history row 0.
    vt.scroll(-1);
    vt.select({ col: 0, row: 0 }, { col: 9, row: 0 });
    expect(vt.selectionText()).toBe("0123456789");
  } finally { vt.dispose(); }
});

test("screens name the highlighted item and fold long blank runs", async () => {
  const vt = await (await loadVt())(30, 12);
  try {
    // A menu: the selected row in inverse video, a button on a coloured background, and a key-hint bar.
    // The inverse "▀▀▀" after Apple is decoration: a span of drawing glyphs names no item.
    vt.write(Buffer.from("  Apple\x1b[20G\x1b[7m▀▀▀\x1b[0m\r\n\x1b[7m  Banana \x1b[0m\r\n  Cherry\r\n\r\n\r\n\r\n\r\n\r\n \x1b[44m< OK >\x1b[0m  <Cancel>\r\n\r\n" +
      "\x1b[7mF1\x1b[0m a \x1b[7mF2\x1b[0m b \x1b[7mF3\x1b[0m c \x1b[7mF4\x1b[0m d \x1b[7mF5\x1b[0m e"));
    const s = vt.screen();
    expect(highlights(s)).toStrictEqual([{ row: 2, col: 3, text: "Banana" }, { row: 9, col: 2, text: "< OK >" }]);
    const text = renderScreen({ id: "t", command: "menu", status: "running", exitCode: null, controller: "agent" } as never, s, [], 0);
    expect(text).toMatch(/^  Cherry\n\[rows 4-8 blank\]\n < OK >/m);
    expect(text).toMatch(/\nHighlighted: row 2 col 3 "Banana"; row 9 col 2 "< OK >"$/);
    vt.write(Buffer.from("\x1b[2J\x1b[Hplain"));
    expect(highlights(vt.screen())).toStrictEqual([]);
  } finally { vt.dispose(); }
});

test("key names map to the bytes a terminal sends, and a bare shell is refused", () => {
  expect(keyBytes("Enter")).toBe("\r");
  expect(keyBytes("Ctrl-C")).toBe("\x03");
  expect(keyBytes("Up")).toBe("\x1b[A");
  expect(keyBytes("Up", true)).toBe("\x1bOA");
  expect(keyBytes("Alt-x")).toBe("\x1bx");
  throwsWith(() => keyBytes("Hyper-q"), /Unknown key/);
  // The spellings models reach for, single characters, modifiers on special keys, and repeats.
  for (const k of ["C-c", "^C", "ctrl+c"]) expect(keyBytes(k), k).toBe("\x03");
  expect(keyBytes("M-x")).toBe("\x1bx");
  expect(keyBytes("j")).toBe("j");
  expect(keyBytes("/")).toBe("/");
  expect(keyBytes("S-Tab")).toBe("\x1b[Z");
  expect(keyBytes("Shift-Up")).toBe("\x1b[1;2A");
  expect(keyBytes("Ctrl-Left")).toBe("\x1b[1;5D");
  expect(keyBytes("Shift-F5")).toBe("\x1b[15;2~");
  expect(keyBytes("PgDn")).toBe("\x1b[6~");
  expect(keyBytes("Down*3")).toBe("\x1b[B".repeat(3));
  expect(keyBytes("Down*3", true)).toBe("\x1bOB".repeat(3));
  // Multi-line text is one paste when the program asked for bracketed paste, else Enter per line.
  expect(textBytes("a\nb", true)).toBe("\x1b[200~a\nb\x1b[201~");
  expect(textBytes("a\nb", false)).toBe("a\rb");
  expect(textBytes("ab", true)).toBe("ab");
  for (const c of ["bash", "/bin/zsh -l", "sh -i", "env bash --login"]) expect(bareShell(c), c).toBeTruthy();
  for (const c of ["vim notes.md", "python3", "bash -c 'read x'", "ssh host", "htop"]) expect(!bareShell(c), c).toBeTruthy();
});

test("an agent terminal runs one program, reads its screen, and ends with it", async () => {
  const r = registry();
  await rejectsWith(r.create({ session: 1, owner: "agent", worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 400);
  const info = await r.create({ session: 1, owner: "agent", worker: null, cwd: "/tmp", command: "python3 -q", cols: 80, rows: 10 });
  expect(info.controller).toBe("agent");
  expect(info.shared).toBe(true);
  await until(() => screenText(r, info.id).includes(">>>"), "python prompt");
  r.agentWrite(info.id, 1, "6*7\r");
  await until(() => /^42$/m.test(screenText(r, info.id)), "42");
  throwsWith(() => r.agentScreen(info.id, 2), (e: unknown) => e instanceof TerminalError && e.status === 404);
  r.agentWrite(info.id, 1, "exit()\r");
  await until(() => r.get(info.id)?.status === "ended", "exit");
  expect(r.get(info.id)?.exitCode).toBe(0);
  throwsWith(() => r.agentWrite(info.id, 1, "x"), (e: unknown) => e instanceof TerminalError && e.status === 409);
});

test("terminals are two-way always: both m57 and Luna can type and read without locking", async () => {
  const r = registry();
  const info = await r.create({ session: 1, owner: "agent", worker: null, cwd: "/tmp", command: "cat", cols: 40, rows: 5 });
  r.write(info.id, "user-typed\r");
  r.agentWrite(info.id, 1, "luna-typed\r");
  await until(() => screenText(r, info.id).includes("user-typed") && screenText(r, info.id).includes("luna-typed"), "both echo");
  await r.control(info.id, "take");
  r.agentWrite(info.id, 1, "still-works\r");
  await until(() => screenText(r, info.id).includes("still-works"), "luna still works");
});

test("user shells are shared with Luna by default and readable immediately", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp", cols: 60, rows: 8 });
  expect(info.shared).toBe(true);
  expect(r.agentList(1).length).toBe(1);
  r.write(info.id, "printf 'before-%s\\n' share\n");
  const seen = { text: "" };
  r.attach(info.id, { data: c => { seen.text += c.toString(); }, exit() {}, closed() {} });
  await until(() => seen.text.includes("before-share"), "shell output");
  expect(screenText(r, info.id)).toMatch(/before-share/);
  r.agentWrite(info.id, 1, "printf 'from-%s\\n' luna\n");
  await until(() => screenText(r, info.id).includes("from-luna"), "luna command");
});

// ---- the tool through the runtime, with a scripted model ----

type Call = [string, Parameters<typeof fauxToolCall>[1]];
const lastResult = (request: AiContext) => {
  const results = request.messages.filter(m => m.role === "toolResult");
  const last = results.at(-1);
  return last ? last.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
};
const terminalId = (text: string) => /terminal ([0-9a-f-]{36})/.exec(text)?.[1] ?? "missing";

async function runTool(dir: string, agentOn: boolean, script: ((previous: string) => Call)[]) {
  const faux = fauxProvider();
  let step = 0;
  const offered: string[][] = [];
  faux.setResponses(Array.from({ length: script.length + 1 }, () => (request: AiContext) => {
    offered.push(request.messages.flatMap(m => m.role === "system" ? (m.toolsAdded ?? []).map(t => t.name) : []));
    const next = script[step++];
    if (!next) return fauxAssistantMessage([fauxText("done")]);
    const [name, args] = next(lastResult(request));
    return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const modelRef = { provider: model.provider, modelId: model.id };
  const rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["coding", "tool-search"], terminal: { agent: agentOn } }), { models, model: modelRef });
  try {
    const session = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: modelRef } }, context);
    const run = await (await session.submit({ type: "input", content: "use the terminal" }, context)).wait(context);
    expect(run.status).toBe("done");
    const results = (await session.entries({}, 200, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    results.sort((a, b) => a.timestamp - b.timestamp);
    return { offered, results: results.map(r => ({ name: r.toolName, error: r.isError, text: r.content.filter(b => b.type === "text").map(b => b.text).join("\n") })) };
  } finally {
    await rt.close();
  }
}

test("the terminal tool is deferred: tool_search loads it, then it drives a REPL and vim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-agent-terminal-"));
  const file = join(dir, "note.txt");
  const { offered, results } = await runTool(dir, true, [
    () => ["tool_search", { query: "terminal interactive TTY program" }],
    () => ["terminal", { action: "start", command: "bash" }],
    () => ["terminal", { action: "start", command: "python3 -q" }],
    prev => ["terminal", { action: "send", id: terminalId(prev), text: "1+1", enter: true }],
    prev => ["terminal", { action: "stop", id: terminalId(prev) }],
    () => ["terminal", { action: "start", command: `vim -u NONE -N -n ${file}`, cols: 80, rows: 12 }],
    prev => ["terminal", { action: "send", id: terminalId(prev), text: "ihello from luna" }],
    prev => ["terminal", { action: "send", id: terminalId(prev), keys: ["Escape"], text: ":wq", enter: true }],
    prev => ["terminal", { action: "wait", id: terminalId(prev), timeoutSec: 5 }],
    () => ["terminal", { action: "list" }],
  ]);
  try {
    expect(!offered[0]!.includes("terminal"), "terminal must not be offered before tool_search loads it").toBeTruthy();
    expect(offered[0]!.includes("bash")).toBeTruthy();
    if (process.env.DEBUG_TERMINAL) for (const r of results) console.log(r.name, r.error, r.text);
    const [search, shell, start, send, stop, vim, typed, save, wait, list] = results;
    expect(search!.text).toMatch(/terminal/);
    expect(shell!.error).toBe(true);
    expect(shell!.text).toMatch(/bare shell.*bash/s);
    expect(start!.error, start!.text).toBe(false);
    expect(start!.text).toMatch(/>>>/);
    expect(send!.error, send!.text).toBe(false);
    expect(send!.text).toMatch(/^>>> 1\+1\n2\n>>>/m);
    expect(stop!.text).toMatch(/^Closed\./);
    expect(vim!.error, vim!.text).toBe(false);
    expect(vim!.text).toMatch(/full-screen app/);
    expect(typed!.text).toMatch(/hello from luna/);
    expect(save!.error, save!.text).toBe(false);
    expect(wait!.text).toMatch(/ended \(exit 0\)/);
    expect(readFileSync(file, "utf8")).toBe("hello from luna\n");
    expect(list!.text).toMatch(/"status":"ended"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

test("with terminal.agent off the tool is hidden from tool_search and refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-agent-terminal-"));
  const { results } = await runTool(dir, false, [
    () => ["tool_search", { query: "terminal interactive TTY program" }],
    () => ["terminal", { action: "start", command: "python3" }],
  ]);
  try {
    expect(results[0]!.text).not.toMatch(/"terminal"|\bterminal\b.*TTY/);
    expect(results[1]!.error).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("send waits for a quiet program to answer instead of returning the screen from before the input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-agent-terminal-"));
  const script = join(dir, "slow.sh");
  // No echo, then silence before the input and a late answer: the shape of a TUI that redraws only after it processes a key.
  writeFileSync(script, "stty -echo\nprintf 'ready\\n'\nread x\nsleep 0.6\nprintf 'got-%s\\n' \"$x\"\nsleep 30\n");
  const { results } = await runTool(dir, true, [
    () => ["tool_search", { query: "terminal interactive TTY program" }],
    () => ["terminal", { action: "start", command: `sh ${script}` }],
    prev => ["terminal", { action: "wait", id: terminalId(prev), idleMs: 800 }],
    prev => ["terminal", { action: "send", id: terminalId(prev), text: "abc", enter: true }],
    prev => ["terminal", { action: "stop", id: terminalId(prev) }],
  ]);
  try {
    const send = results[3]!;
    expect(send.error, send.text).toBe(false);
    expect(send.text).toMatch(/got-abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("start waits for a slow program's first screen, and send with a pattern waits for its answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-agent-terminal-"));
  const script = join(dir, "slow.sh");
  // Draws nothing for 1.2 s (past the start settle), then answers each line 2 s later (past the send settle).
  // It echoes input, so the echo answers at once while the old "reply-" stays on the screen.
  // Before each reply it prints filler that scrolls the old reply up a 6-row screen, as a chat TUI does while it streams.
  writeFileSync(script, "sleep 1.2\nprintf 'menu ready\\n'\nwhile read x; do printf 'w\\nw\\n'; sleep 2; printf 'reply-%s\\n' \"$x\"; done\n");
  const { results } = await runTool(dir, true, [
    () => ["tool_search", { query: "terminal interactive TTY program" }],
    () => ["terminal", { action: "start", command: `sh ${script}`, rows: 6 }],
    prev => ["terminal", { action: "send", id: terminalId(prev), text: "one", enter: true, pattern: "reply-one", timeoutSec: 8 }],
    prev => ["terminal", { action: "send", id: terminalId(prev), text: "two", enter: true, pattern: "reply-", timeoutSec: 8 }],
    prev => ["terminal", { action: "stop", id: terminalId(prev) }],
  ]);
  try {
    const [, start, one, two] = results;
    expect(start!.text, start!.text).toMatch(/menu ready/);
    expect(one!.text, one!.text).toMatch(/Pattern found\.[\s\S]*reply-one/);
    // "reply-" is already on the screen; it counts only once the program answered the new line.
    expect(two!.text, two!.text).toMatch(/reply-two/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 40_000);
