// Luna's terminal: the headless screen, shared control, and the deferred `terminal` tool end to end.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Context as AiContext } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { bareShell, highlights, keyBytes, renderScreen, textBytes } from "../src/terminal/agent-tools.js";
import { localLauncher } from "../src/terminal/pty-host.js";
import { TerminalError, TerminalRegistry } from "../src/terminal/registry.js";
import { loadVt } from "../src/terminal/vt-model.js";

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
    assert.deepEqual(s.lines, ["hello", "prog 99%", "مرحبا 你好", ""]);
    assert.equal(s.alternate, false);
    assert.equal(vt.responses(), "\x1b[3;1R");
    assert.equal(vt.responses(), "");
    vt.write(Buffer.from("\x1b[?1049h\x1b[?1h\x1b[HALT"));
    assert.equal(vt.screen().alternate, true);
    assert.equal(vt.mode(1), true);
    assert.equal(vt.screen().lines[0], "ALT");
    vt.write(Buffer.from("\x1b[?1049l"));
    assert.equal(vt.screen().lines[0], "hello");
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
    assert.deepEqual(highlights(s), [{ row: 2, col: 3, text: "Banana" }, { row: 9, col: 2, text: "< OK >" }]);
    const text = renderScreen({ id: "t", command: "menu", status: "running", exitCode: null, controller: "agent" } as never, s, [], 0);
    assert.match(text, /^  Cherry\n\[rows 4-8 blank\]\n < OK >/m);
    assert.match(text, /\nHighlighted: row 2 col 3 "Banana"; row 9 col 2 "< OK >"$/);
    vt.write(Buffer.from("\x1b[2J\x1b[Hplain"));
    assert.deepEqual(highlights(vt.screen()), []);
  } finally { vt.dispose(); }
});

test("key names map to the bytes a terminal sends, and a bare shell is refused", () => {
  assert.equal(keyBytes("Enter"), "\r");
  assert.equal(keyBytes("Ctrl-C"), "\x03");
  assert.equal(keyBytes("Up"), "\x1b[A");
  assert.equal(keyBytes("Up", true), "\x1bOA");
  assert.equal(keyBytes("Alt-x"), "\x1bx");
  assert.throws(() => keyBytes("Hyper-q"), /Unknown key/);
  // The spellings models reach for, single characters, modifiers on special keys, and repeats.
  for (const k of ["C-c", "^C", "ctrl+c"]) assert.equal(keyBytes(k), "\x03", k);
  assert.equal(keyBytes("M-x"), "\x1bx");
  assert.equal(keyBytes("j"), "j");
  assert.equal(keyBytes("/"), "/");
  assert.equal(keyBytes("S-Tab"), "\x1b[Z");
  assert.equal(keyBytes("Shift-Up"), "\x1b[1;2A");
  assert.equal(keyBytes("Ctrl-Left"), "\x1b[1;5D");
  assert.equal(keyBytes("Shift-F5"), "\x1b[15;2~");
  assert.equal(keyBytes("PgDn"), "\x1b[6~");
  assert.equal(keyBytes("Down*3"), "\x1b[B".repeat(3));
  assert.equal(keyBytes("Down*3", true), "\x1bOB".repeat(3));
  // Multi-line text is one paste when the program asked for bracketed paste, else Enter per line.
  assert.equal(textBytes("a\nb", true), "\x1b[200~a\nb\x1b[201~");
  assert.equal(textBytes("a\nb", false), "a\rb");
  assert.equal(textBytes("ab", true), "ab");
  for (const c of ["bash", "/bin/zsh -l", "sh -i", "env bash --login"]) assert.ok(bareShell(c), c);
  for (const c of ["vim notes.md", "python3", "bash -c 'read x'", "ssh host", "htop"]) assert.ok(!bareShell(c), c);
});

test("an agent terminal runs one program, reads its screen, and ends with it", async () => {
  const r = registry();
  await assert.rejects(r.create({ session: 1, owner: "agent", worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 400);
  const info = await r.create({ session: 1, owner: "agent", worker: null, cwd: "/tmp", command: "python3 -q", cols: 80, rows: 10 });
  assert.equal(info.controller, "agent");
  assert.equal(info.shared, true);
  await until(() => screenText(r, info.id).includes(">>>"), "python prompt");
  r.agentWrite(info.id, 1, "6*7\r");
  await until(() => /^42$/m.test(screenText(r, info.id)), "42");
  assert.throws(() => r.agentScreen(info.id, 2), (e: unknown) => e instanceof TerminalError && e.status === 404);
  r.agentWrite(info.id, 1, "exit()\r");
  await until(() => r.get(info.id)?.status === "ended", "exit");
  assert.equal(r.get(info.id)?.exitCode, 0);
  assert.throws(() => r.agentWrite(info.id, 1, "x"), (e: unknown) => e instanceof TerminalError && e.status === 409);
});

test("control moves the keyboard: m57's keys are dropped while Luna types, and Luna is refused after he takes over", async () => {
  const r = registry();
  const info = await r.create({ session: 1, owner: "agent", worker: null, cwd: "/tmp", command: "cat", cols: 40, rows: 5 });
  r.write(info.id, "user-typed\r");
  r.agentWrite(info.id, 1, "luna-typed\r");
  await until(() => screenText(r, info.id).includes("luna-typed"), "luna echo");
  assert.ok(!screenText(r, info.id).includes("user-typed"));
  const events: string[] = [];
  r.attach(info.id, { data() {}, exit() {}, closed() {}, control: i => events.push(i.controller) });
  await r.control(info.id, "take");
  assert.throws(() => r.agentWrite(info.id, 1, "x"), /m57 has control/);
  r.write(info.id, "user-now\r");
  await until(() => screenText(r, info.id).includes("user-now"), "user echo");
  await r.control(info.id, "give");
  assert.deepEqual(events, ["user", "agent"]);
  await assert.rejects(r.control(info.id, "unshare"), /always visible/);
});

test("sharing a user shell replays its output into a screen Luna can read; unsharing hides it again", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp", cols: 60, rows: 8 });
  assert.equal(info.shared, false);
  assert.deepEqual(r.agentList(1), []);
  r.write(info.id, "printf 'before-%s\\n' share\n");
  const seen = { text: "" };
  r.attach(info.id, { data: c => { seen.text += c.toString(); }, exit() {}, closed() {} });
  await until(() => seen.text.includes("before-share"), "shell output");
  assert.throws(() => r.agentScreen(info.id, 1), (e: unknown) => e instanceof TerminalError && e.status === 404);
  await assert.rejects(r.control(info.id, "give"), /Share the terminal/);
  await r.control(info.id, "share");
  assert.match(screenText(r, info.id), /before-share/);
  assert.equal(r.agentList(1).length, 1);
  assert.throws(() => r.agentWrite(info.id, 1, "x"), /m57 has control/);
  await r.control(info.id, "give");
  r.agentWrite(info.id, 1, "printf 'from-%s\\n' luna\n");
  await until(() => screenText(r, info.id).includes("from-luna"), "luna command");
  await r.control(info.id, "unshare");
  assert.equal(r.get(info.id)?.controller, "user");
  assert.throws(() => r.agentScreen(info.id, 1), (e: unknown) => e instanceof TerminalError && e.status === 404);
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
    assert.equal(run.status, "done");
    const results = (await session.entries({}, 200, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    results.sort((a, b) => a.timestamp - b.timestamp);
    return { offered, results: results.map(r => ({ name: r.toolName, error: r.isError, text: r.content.filter(b => b.type === "text").map(b => b.text).join("\n") })) };
  } finally {
    await rt.close();
  }
}

test("the terminal tool is deferred: tool_search loads it, then it drives a REPL and vim", { timeout: 60_000 }, async () => {
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
    assert.ok(!offered[0]!.includes("terminal"), "terminal must not be offered before tool_search loads it");
    assert.ok(offered[0]!.includes("bash"));
    if (process.env.DEBUG_TERMINAL) for (const r of results) console.log(r.name, r.error, r.text);
    const [search, shell, start, send, stop, vim, typed, save, wait, list] = results;
    assert.match(search!.text, /terminal/);
    assert.equal(shell!.error, true);
    assert.match(shell!.text, /bare shell.*bash/s);
    assert.equal(start!.error, false, start!.text);
    assert.match(start!.text, />>>/);
    assert.equal(send!.error, false, send!.text);
    assert.match(send!.text, /^>>> 1\+1\n2\n>>>/m);
    assert.match(stop!.text, /^Closed\./);
    assert.equal(vim!.error, false, vim!.text);
    assert.match(vim!.text, /full-screen app/);
    assert.match(typed!.text, /hello from luna/);
    assert.equal(save!.error, false, save!.text);
    assert.match(wait!.text, /ended \(exit 0\)/);
    assert.equal(readFileSync(file, "utf8"), "hello from luna\n");
    assert.match(list!.text, /"status":"ended"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with terminal.agent off the tool is hidden from tool_search and refused", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-agent-terminal-"));
  const { results } = await runTool(dir, false, [
    () => ["tool_search", { query: "terminal interactive TTY program" }],
    () => ["terminal", { action: "start", command: "python3" }],
  ]);
  try {
    assert.doesNotMatch(results[0]!.text, /"terminal"|\bterminal\b.*TTY/);
    assert.equal(results[1]!.error, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("send waits for a quiet program to answer instead of returning the screen from before the input", { timeout: 30_000 }, async () => {
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
    assert.equal(send.error, false, send.text);
    assert.match(send.text, /got-abc/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("start waits for a slow program's first screen, and send with a pattern waits for its answer", { timeout: 40_000 }, async () => {
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
    assert.match(start!.text, /menu ready/, start!.text);
    assert.match(one!.text, /Pattern found\.[\s\S]*reply-one/, one!.text);
    // "reply-" is already on the screen; it counts only once the program answered the new line.
    assert.match(two!.text, /reply-two/, two!.text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
