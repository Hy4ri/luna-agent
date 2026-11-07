// Luna's `terminal` tool: drive programs that need a real TTY (vim, htop, REPLs, curses installers, ssh prompts).
// It is a last resort, not a shell. Plain commands belong to bash and process, which return clean output and exit codes.
// The tool is deferred (tool_search loads it) and hidden while `terminal.agent` is off, so it never crowds out bash.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, hook, GenerationTask, ToolTask, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ExecTarget } from "../workers.js";
import { filterHiddenTools } from "../tool-visibility.js";
import { TerminalError, type TerminalInfo, type TerminalRegistry } from "./registry.js";
import type { VtScreen } from "./vt-model.js";

export const TERMINAL_TOOL = "terminal";
const OFF = "Luna's terminal tool is off. m57 can turn on Settings > Tools > Terminal (terminal.agent). Use bash for commands that do not need a TTY.";
const MAX_WAIT_MS = 60_000;
/** After input, wait this long without output before the screen counts as settled. */
const SETTLE_MS = 300;
const SETTLE_MAX_MS = 3_000;
/** start: how long a program may take to draw its first screen. */
const START_MAX_MS = 8_000;
/** After input, wait this long for the program's first output. A program that never answers settles after this window. */
const REACT_MS = 1_500;

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "ash", "busybox", "nu", "elvish", "xonsh", "pwsh"]);
/** A bare shell is just bash with extra steps and worse output. Refuse it, so the tool is not used in place of bash. */
export function bareShell(command: string): boolean {
  const words = command.trim().split(/\s+/);
  const first = (words[0] ?? "").split("/").pop() ?? "";
  const name = first === "env" || first === "exec" ? (words[1] ?? "").split("/").pop() ?? "" : first;
  if (!SHELLS.has(name)) return false;
  const rest = words.slice(first === "env" || first === "exec" ? 2 : 1);
  return rest.every(w => /^-[ilsx]+$|^--login$|^--norc$|^--noprofile$|^--interactive$/.test(w));
}

const CSI = "\x1b[";
const named: Record<string, string> = {
  enter: "\r", return: "\r", tab: "\t", "shift-tab": `${CSI}Z`, escape: "\x1b", esc: "\x1b", space: " ", backspace: "\x7f",
  delete: `${CSI}3~`, insert: `${CSI}2~`, home: `${CSI}H`, end: `${CSI}F`, pageup: `${CSI}5~`, pagedown: `${CSI}6~`,
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: `${CSI}15~`, f6: `${CSI}17~`, f7: `${CSI}18~`, f8: `${CSI}19~`,
  f9: `${CSI}20~`, f10: `${CSI}21~`, f11: `${CSI}23~`, f12: `${CSI}24~`,
};
const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

// xterm modifier parameter: 1 + (Shift 1, Alt 2, Ctrl 4).
const MODS: Record<string, number> = { shift: 1, s: 1, alt: 2, meta: 2, m: 2, a: 2, ctrl: 4, control: 4, c: 4 };
const tilde: Record<string, string> = { delete: "3", insert: "2", pageup: "5", pagedown: "6", f5: "15", f6: "17", f7: "18", f8: "19", f9: "20", f10: "21", f11: "23", f12: "24" };
const ss3: Record<string, string> = { home: "H", end: "F", f1: "P", f2: "Q", f3: "R", f4: "S" };

/**
 * Bytes for one key. `appCursor` is DEC mode 1, which full-screen programs turn on and which changes the arrow keys.
 * Accepts names (Enter, Up, F5), modifiers in any common spelling (Ctrl-C, C-c, ^C, ctrl+shift+up, M-x, S-Tab),
 * a single character (j, /, :), and a repeat count (Down*3).
 */
export function keyBytes(key: string, appCursor = false): string {
  const raw = key.trim();
  const rep = /^(.+?)\s*\*\s*(\d{1,3})$/.exec(raw);
  if (rep && Number(rep[2]) >= 1 && Number(rep[2]) <= 200) return keyBytes(rep[1]!, appCursor).repeat(Number(rep[2]));
  if ([...raw].length === 1) return raw; // a plain character: j, q, /, :
  const caret = /^\^(.)$/.exec(raw);
  if (caret) return ctrlByte(caret[1]!, key);
  const parts = raw.toLowerCase().split(/(?<=.)[-+](?=.)/).map(p => p.replace(/\s+/g, ""));
  let base = parts.pop()!;
  let mod = 0;
  for (const p of parts) { if (MODS[p] === undefined) throw unknownKey(key); mod |= MODS[p]!; }
  if (base === "esc") base = "escape";
  if (base === "return") base = "enter";
  if (base === "pgup") base = "pageup";
  if (base === "pgdn") base = "pagedown";
  if (base === "del") base = "delete";
  if (base === "ins") base = "insert";
  if (!mod) {
    if (arrows[base]) return (appCursor ? "\x1bO" : CSI) + arrows[base];
    if (named[base] !== undefined) return named[base]!;
    throw unknownKey(key);
  }
  // Single characters with Ctrl and/or Alt.
  const ch = [...raw.split(/[-+]/).pop()!];
  if (ch.length === 1 && !(mod & 1)) {
    const c = mod & 4 ? ctrlByte(ch[0]!, key) : ch[0]!;
    return (mod & 2 ? "\x1b" : "") + c;
  }
  if (base === "tab" && mod === 1) return `${CSI}Z`;
  if (base === "space" && mod === 4) return "\x00";
  if ((base === "enter" || base === "backspace" || base === "escape" || base === "tab" || base === "space") && mod === 2) return "\x1b" + named[base]!;
  const m = 1 + mod;
  if (arrows[base]) return `${CSI}1;${m}${arrows[base]}`;
  if (ss3[base]) return `${CSI}1;${m}${ss3[base]}`;
  if (tilde[base]) return `${CSI}${tilde[base]};${m}~`;
  if (base === "enter") return `${CSI}13;${m}u`; // kitty/CSI-u form, as Shift-Enter in modern TUIs
  throw unknownKey(key);
}

function ctrlByte(c: string, key: string): string {
  if (c === "?") return "\x7f";
  if (c === " " || c === "2" || c === "@") return "\x00";
  const code = c.toUpperCase().charCodeAt(0);
  if (code < 0x40 || code > 0x5f) throw unknownKey(key);
  return String.fromCharCode(code & 0x1f);
}
const unknownKey = (key: string) => new Error(`Unknown key "${key}". Use names such as Enter, Tab, Escape, Up, Down, Left, Right, Backspace, PageUp, F1, with modifiers like Ctrl-C, Alt-x, Shift-Up, Ctrl-Left; single characters such as j or /; and repeats such as Down*3. Send longer text with text.`);

/** Text as typed. Programs that turned on bracketed paste get multi-line text as one paste; others get Enter for each newline. */
export function textBytes(text: string, bracketedPaste: boolean): string {
  if (!/[\r\n]/.test(text)) return text;
  return bracketedPaste ? `\x1b[200~${text.replace(/\r\n?/g, "\n")}\x1b[201~` : text.replace(/\r\n?|\n/g, "\r");
}

/** The lines a pattern matches, counted by text. A whole-screen key stands in for a pattern that spans rows. */
function matches(pattern: RegExp, lines: string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of lines) if (pattern.test(line)) found.set(line, (found.get(line) ?? 0) + 1);
  if (!found.size && pattern.test(lines.join("\n"))) found.set(`\0${lines.join("\n")}`, 1);
  return found;
}

/** A match is new when some matched text shows more often than before the input. Scrolling moves old matches but adds none. */
function newMatch(pattern: RegExp, lines: string[], before: Map<string, number>): boolean {
  for (const [text, n] of matches(pattern, lines)) if (n > (before.get(text) ?? 0)) return true;
  return false;
}

const HIGHLIGHT_MAX = 6;
/**
 * Spans drawn with a background that differs from the cells directly above and below them: the selected menu item,
 * list row, button, or search hit. Rows with many such spans are decoration (key-hint bars) and are skipped.
 */
export function highlights(screen: VtScreen): { row: number; col: number; text: string }[] {
  const grid = screen.grid;
  if (!grid) return [];
  const found: { row: number; col: number; text: string }[] = [];
  for (let y = 0; y < grid.length; y++) {
    const { ch, bg } = grid[y]!;
    const differs = (other: { bg: number[] } | undefined, x: number, end: number) => {
      if (!other) return true;
      let n = 0;
      for (let i = x; i < end; i++) if (other.bg[i] !== bg[x]) n++;
      return n * 2 > end - x;
    };
    const spans: { x: number; end: number; bg: number }[] = [];
    let raw = 0;
    for (let x = 0; x < bg.length;) {
      let end = x + 1;
      while (end < bg.length && bg[end] === bg[x]) end++;
      if (ch.slice(x, end).join("").trim() && differs(grid[y - 1], x, end) && differs(grid[y + 1], x, end)) {
        raw++;
        const last = spans.at(-1);
        // One item drawn in parts, such as a hotkey letter and its label, joins across a short gap.
        if (last && last.bg === bg[x] && x - last.end <= 3) last.end = end;
        else spans.push({ x, end, bg: bg[x]! });
      }
      x = end;
    }
    if (raw > 4 || spans.length > 3) continue; // a row of many spans is decoration, such as a key-hint bar
    for (const sp of spans) {
      const cellText = ch.slice(sp.x, sp.end).join("");
      const text = cellText.trim().replace(/\s{3,}/g, "  ");
      if (!/[\p{L}\p{N}]/u.test(text)) continue; // borders, shading, and lone symbols carry no item
      found.push({ row: y + 1, col: sp.x + 1 + cellText.length - cellText.trimStart().length, text: text.length > 80 ? text.slice(0, 79) + "…" : text });
    }
  }
  return found.length > HIGHLIGHT_MAX * 2 ? [] : found.slice(0, HIGHLIGHT_MAX);
}

function idleText(ms: number) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`; }

/** The screen as the model reads it: a status line, then the rows. Trailing blank rows are dropped. */
export function renderScreen(info: TerminalInfo, screen: VtScreen, scrollback: string[], idleMs: number, note?: string): string {
  const state = info.status === "running" ? "running" : `ended${info.exitCode === null ? "" : ` (exit ${info.exitCode})`}${info.endReason ? `: ${info.endReason}` : ""}`;
  const head = [
    `terminal ${info.id}`, info.command ?? info.shell, state, `${screen.cols}x${screen.rows}`,
    `cursor row ${screen.cursor.row + 1} col ${screen.cursor.col + 1}`, ...(screen.alternate ? ["full-screen app"] : []),
    ...(info.controller === "user" ? ["m57 has control"] : []), `idle ${idleText(idleMs)}`,
  ].join(" | ");
  const lines = [...screen.lines];
  while (lines.length && !lines.at(-1)) lines.pop();
  // Long runs of blank rows say only where content is; keep the row numbers.
  const shown: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j < lines.length && !lines[j]!.trim()) j++;
    if (j - i >= 4) { shown.push(`[rows ${i + 1}-${j} blank]`); i = j; }
    else { shown.push(lines[i]!); i++; }
  }
  const marks = lines.length ? highlights(screen) : [];
  const body = [...(scrollback.length ? [...scrollback, "--- screen ---"] : []), ...shown].join("\n");
  const tail = marks.length ? ["", "Highlighted: " + marks.map(m => `row ${m.row} col ${m.col} "${m.text}"`).join("; ")] : [];
  return [head, ...(note ? [note] : []), "", body || "(blank screen)", ...tail].join("\n");
}

export interface AgentTerminalOptions {
  registry: TerminalRegistry;
  /** Reads the live `terminal.agent` setting. */
  enabled: () => boolean;
  /** Working directory when the session has no execution environment. */
  cwd?: string;
  /** Hide the tool from tool_search while it is off. Needs the tool-search extension. */
  wrapSearch?: boolean;
}

const sessionOf = (id: ConversationId) => {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("This conversation cannot own terminals.");
  return n;
};
const asError = (e: unknown) => e instanceof TerminalError ? new Error(e.message) : e;

const DESCRIPTION =
  "Last resort for programs that need a real interactive TTY: full-screen apps (vim, nano, htop, less, tig, mc), REPLs you drive over several turns (python, node, psql, gdb), " +
  "curses installers and prompts that refuse piped input (ssh/sudo password prompts, interactive git rebase). " +
  "NEVER use it for commands that run and exit, builds, tests, scripts, file reads, searches, or long jobs: use bash, or process for background work. Those return clean output and exit codes; a terminal returns a screen picture. " +
  "start: run `command` (one program, not a bare shell) in a new terminal and return its screen. send: press `keys`, type `text`, optionally press Enter, then return the settled screen (with `pattern`: the screen once it matches). read: the current screen, optionally with scrollback lines. " +
  "Screens list the highlighted spans (the selected menu item, list row, or button) after the rows. " +
  "wait: until `pattern` (regex) shows on screen, the program exits, or output stops for idleMs; at most 60 s. resize, list, stop. m57 sees the terminal live and can take control; while he has it, send is refused. " +
  "Terminals end when the daemon restarts.";

export function createAgentTerminalExtension(o: AgentTerminalOptions) {
  const { registry } = o;

  /**
   * `after`: the time of Luna's input. Quiet time counts from the later of that input and the last output, and the program
   * gets REACT_MS to answer. Without this, a program that was quiet before the input "settles" at once, before it redraws.
   */
  async function settle(id: string, opts: { pattern?: RegExp; idleMs: number; maxMs: number; session: number; after?: number; content?: boolean; seen?: Map<string, number> }, context: Context): Promise<"matched" | "ended" | "idle" | "timeout"> {
    const end = Date.now() + opts.maxMs;
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const view = registry.agentScreen(id, opts.session);
      const sinceInput = opts.after === undefined ? Infinity : Date.now() - opts.after;
      const answered = view.idleMs < sinceInput;
      // After input, the screen from before it does not count: match once the program answered or had time to.
      const fresh = answered || sinceInput >= REACT_MS;
      if (opts.pattern && fresh && newMatch(opts.pattern, view.screen.lines, opts.seen ?? new Map())) return "matched";
      if (view.info.status !== "running") return "ended";
      const quiet = Math.min(view.idleMs, sinceInput);
      const need = answered || sinceInput >= REACT_MS ? opts.idleMs : REACT_MS;
      // content: a program that has drawn nothing yet is still starting (htop, TUIs that load first).
      const blank = opts.content && !view.screen.lines.some(l => l.trim());
      if (!opts.pattern && quiet >= need && !blank) return "idle";
      const left = end - Date.now();
      if (left <= 0) return "timeout";
      // Recheck when output arrives, when the idle window would close, or at the deadline.
      const idleLeft = need - quiet;
      await registry.changed(id, Math.min(left, opts.pattern ? left : Math.max(20, idleLeft)), context.abortSignal);
      // Output comes in bursts. A short pause gathers one burst before the screen is parsed again.
      if (opts.pattern) await new Promise(r => setTimeout(r, 15));
    }
  }

  const screen = (id: string, session: number, scrollback = 0, note?: string) => {
    const v = registry.agentScreen(id, session, scrollback);
    return renderScreen(v.info, v.screen, v.scrollback, v.idleMs, note);
  };
  const out = (text: string) => ({ output: [{ type: "text" as const, text }] });
  const compile = (source?: string) => {
    if (!source) return undefined;
    try { return new RegExp(source, "m"); } catch (e) { throw new Error(`Invalid pattern: ${(e as Error).message}`); }
  };
  const waitNote = (result: string, pattern: boolean) => result === "matched" ? "Pattern found." : result === "ended" ? "The program ended."
    : result === "idle" ? "Output stopped." : pattern ? "Timed out; the pattern is not on the screen." : "Timed out; output did not stop.";

  const tool = defineTool({
    name: TERMINAL_TOOL, deferred: true, executionMode: "sequential",
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("resize"), Type.Literal("list"), Type.Literal("stop")]),
      id: Type.Optional(Type.String({ minLength: 1, description: "send, read, wait, resize, stop: terminal ID." })),
      command: Type.Optional(Type.String({ minLength: 1, description: "start: the interactive program and its arguments, e.g. `vim notes.md` or `python3`. Not a bare shell." })),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "start: working directory. Default: the session's." })),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 200, description: "send: keys pressed first, in order. Names: Enter, Tab, Escape, Space, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12. Modifiers: Ctrl-c, Alt-x, Shift-Tab, Shift-Up, Ctrl-Left, Ctrl-Shift-Right. A single character presses that key (j, q, /). Repeat with *N: Down*3." })),
      text: Type.Optional(Type.String({ description: "send: characters typed after keys. Newlines are pasted as one block when the program supports bracketed paste, else pressed as Enter." })),
      enter: Type.Optional(Type.Boolean({ description: "send: press Enter last. Example, vim save and quit: keys [\"Escape\"], text \":wq\", enter true." })),
      pattern: Type.Optional(Type.String({ minLength: 1, description: "wait, send: JavaScript regular expression to find on the screen. With send, return when it shows after the input instead of when output pauses; use it for slow programs (an AI reply, a long load)." })),
      idleMs: Type.Optional(Type.Integer({ minimum: 50, maximum: MAX_WAIT_MS, description: "wait without pattern: return after this long with no output. Default 1000." })),
      timeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 60, description: "wait, send with pattern: time limit, at most 60. Default 10." })),
      scrollback: Type.Optional(Type.Integer({ minimum: 0, maximum: 2000, description: "read: also return this many lines above the screen." })),
      cols: Type.Optional(Type.Integer({ minimum: 20, maximum: 500, description: "start, resize: columns. Default 100." })),
      rows: Type.Optional(Type.Integer({ minimum: 5, maximum: 300, description: "start, resize: rows. Default 30." })),
    }, { additionalProperties: false }),
    execute: async (args, api, context) => {
      if (!o.enabled()) throw new Error(OFF);
      const session = sessionOf(api.conversationId);
      const need = (name: "id" | "command") => { const v = args[name]; if (!v) throw new Error(`${args.action} needs ${name}.`); return v; };
      try {
        switch (args.action) {
          case "start": {
            const command = need("command");
            if (bareShell(command)) throw new Error("terminal does not run a bare shell. Run shell commands with bash (or process for background work), and start only the interactive program here, e.g. `vim file` or `python3`.");
            const worker = (await api.snapshot(ExecTarget, api.conversationId, context))?.worker ?? null;
            let cwd = args.cwd ?? api.env?.cwd ?? o.cwd ?? process.cwd();
            if (api.env) { const abs = await api.env.absolutePath(cwd, context); if (!abs.ok) throw new Error(abs.error.message); cwd = abs.value; }
            const info = await registry.create({ session, owner: "agent", worker, cwd, command, cols: args.cols ?? 100, rows: args.rows ?? 30 });
            const result = await settle(info.id, { session, idleMs: SETTLE_MS * 2, maxMs: START_MAX_MS, after: Date.now(), content: true }, context);
            const now = registry.get(info.id);
            const note = now?.status === "ended" ? "The program already ended. If it needs no TTY, run it with bash instead."
              : result === "timeout" ? "Still starting or busy: wait for a pattern before sending keys." : undefined;
            return out(screen(info.id, session, 0, note));
          }
          case "send": {
            const id = need("id");
            if (!args.text && !args.keys?.length && !args.enter) throw new Error("send needs keys, text, or enter.");
            const pattern = compile(args.pattern);
            const appCursor = registry.agentMode(id, session, 1);
            const data = (args.keys ?? []).map(k => keyBytes(k, appCursor)).join("")
              + textBytes(args.text ?? "", registry.agentMode(id, session, 2004)) + (args.enter ? "\r" : "");
            // With a pattern, the matches already on the screen (a prompt, an earlier reply) do not count.
            const seen = pattern ? matches(pattern, registry.agentScreen(id, session).screen.lines) : undefined;
            const after = Date.now();
            registry.agentWrite(id, session, data);
            if (!pattern) {
              await settle(id, { session, idleMs: SETTLE_MS, maxMs: SETTLE_MAX_MS, after }, context);
              return out(screen(id, session));
            }
            const result = await settle(id, { session, pattern, idleMs: 0, maxMs: Math.min(MAX_WAIT_MS, (args.timeoutSec ?? 10) * 1000), after, seen }, context);
            // A matched pattern can sit mid-redraw; let that burst finish.
            if (result === "matched") await settle(id, { session, idleMs: 150, maxMs: 1_000 }, context);
            return out(screen(id, session, 0, waitNote(result, true)));
          }
          case "read": return out(screen(need("id"), session, args.scrollback ?? 0));
          case "wait": {
            const id = need("id");
            const pattern = compile(args.pattern);
            const result = await settle(id, { session, pattern, idleMs: args.idleMs ?? 1000, maxMs: Math.min(MAX_WAIT_MS, (args.timeoutSec ?? 10) * 1000) }, context);
            return out(screen(id, session, 0, waitNote(result, !!pattern)));
          }
          case "resize": {
            const id = need("id");
            const cur = registry.agentScreen(id, session).info;
            const after = Date.now();
            registry.agentResize(id, session, args.cols ?? cur.cols, args.rows ?? cur.rows);
            await settle(id, { session, idleMs: SETTLE_MS, maxMs: SETTLE_MAX_MS, after }, context);
            return out(screen(id, session));
          }
          case "list": {
            const rows = registry.agentList(session).map(t => ({
              id: t.id, command: t.command ?? `${t.shell} (shared by m57)`, status: t.status, exitCode: t.exitCode, control: t.controller === "agent" ? "luna" : "m57", cwd: t.cwd,
            }));
            return out(rows.length ? JSON.stringify(rows) : "No terminals in this session.");
          }
          case "stop": {
            const id = need("id");
            const info = registry.agentScreen(id, session).info;
            if (info.owner !== "agent") throw new Error("This is m57's terminal. Only he can close it.");
            const last = screen(id, session);
            registry.close(id);
            return out(`Closed.\n${last}`);
          }
        }
      } catch (e) { throw asError(e); }
    },
  });

  // Off means gone: not offered, not found by tool_search, and refused if a stale call names it.
  const hidden = () => !o.enabled();
  return defineExtension({
    name: "agent-terminal",
    tools: [tool],
    hooks: [
      hook(GenerationTask, { async beforeRequest(request) { return hidden() ? { messages: filterHiddenTools(request.messages, new Set([TERMINAL_TOOL])) } : undefined; } }),
      hook(ToolTask, { async beforeTool(call) { return call.name === TERMINAL_TOOL && hidden() ? { block: OFF } : {}; } }),
    ],
    wraps: o.wrapSearch === false ? [] : [{ tool: "tool_search", wrap: (search: ToolRegistration): ToolRegistration => ({
      ...search,
      execute: (a: any, api: any, context: any) => search.execute(a, hidden() ? Object.create(api, {
        agent: { value: async (c: unknown) => { const agent = await api.agent(c); return { ...agent, deferred: agent.deferred.filter((t: { name: string }) => t.name !== TERMINAL_TOOL) }; } },
      }) : api, context),
    }) }],
  });
}
