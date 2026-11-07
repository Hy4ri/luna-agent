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

/** Bytes for one key name. `appCursor` is DEC mode 1, which full-screen programs turn on and which changes the arrow keys. */
export function keyBytes(key: string, appCursor = false): string {
  const k = key.trim().toLowerCase().replace(/\s+/g, "");
  if (arrows[k]) return (appCursor ? "\x1bO" : CSI) + arrows[k];
  if (named[k] !== undefined) return named[k]!;
  const ctrl = /^(?:ctrl|c|control)[-+]([a-z@[\\\]^_?])$/.exec(k);
  if (ctrl) return ctrl[1] === "?" ? "\x7f" : String.fromCharCode(ctrl[1]!.toUpperCase().charCodeAt(0) & 0x1f);
  const alt = /^(?:alt|meta|m)[-+](.)$/i.exec(key.trim());
  if (alt) return "\x1b" + alt[1];
  throw new Error(`Unknown key "${key}". Use names such as Enter, Tab, Escape, Up, Down, Left, Right, Backspace, PageUp, F1, Ctrl-C, Alt-x. Send plain characters with text.`);
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
  const body = [...(scrollback.length ? [...scrollback, "--- screen ---"] : []), ...lines].join("\n");
  return [head, ...(note ? [note] : []), "", body || "(blank screen)"].join("\n");
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
  "start: run `command` (one program, not a bare shell) in a new terminal and return its screen. send: press `keys`, type `text`, optionally press Enter, then return the settled screen. read: the current screen, optionally with scrollback lines. " +
  "wait: until `pattern` (regex) shows on screen, the program exits, or output stops for idleMs; at most 60 s. resize, list, stop. m57 sees the terminal live and can take control; while he has it, send is refused. " +
  "Terminals end when the daemon restarts.";

export function createAgentTerminalExtension(o: AgentTerminalOptions) {
  const { registry } = o;

  async function settle(id: string, opts: { pattern?: RegExp; idleMs: number; maxMs: number; session: number }, context: Context): Promise<"matched" | "ended" | "idle" | "timeout"> {
    const end = Date.now() + opts.maxMs;
    for (;;) {
      context.abortSignal?.throwIfAborted();
      const view = registry.agentScreen(id, opts.session);
      if (opts.pattern && opts.pattern.test(view.screen.lines.join("\n"))) return "matched";
      if (view.info.status !== "running") return "ended";
      if (!opts.pattern && view.idleMs >= opts.idleMs) return "idle";
      const left = end - Date.now();
      if (left <= 0) return "timeout";
      // Recheck when output arrives, when the idle window would close, or at the deadline.
      const idleLeft = opts.idleMs - view.idleMs;
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

  const tool = defineTool({
    name: TERMINAL_TOOL, deferred: true, executionMode: "sequential",
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("send"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("resize"), Type.Literal("list"), Type.Literal("stop")]),
      id: Type.Optional(Type.String({ minLength: 1, description: "send, read, wait, resize, stop: terminal ID." })),
      command: Type.Optional(Type.String({ minLength: 1, description: "start: the interactive program and its arguments, e.g. `vim notes.md` or `python3`. Not a bare shell." })),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "start: working directory. Default: the session's." })),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 200, description: "send: keys pressed first, in order. Names: Enter, Tab, Shift-Tab, Escape, Space, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12, Ctrl-<letter>, Alt-<char>." })),
      text: Type.Optional(Type.String({ description: "send: characters typed after keys." })),
      enter: Type.Optional(Type.Boolean({ description: "send: press Enter last. Example, vim save and quit: keys [\"Escape\"], text \":wq\", enter true." })),
      pattern: Type.Optional(Type.String({ minLength: 1, description: "wait: JavaScript regular expression to find on the screen." })),
      idleMs: Type.Optional(Type.Integer({ minimum: 50, maximum: MAX_WAIT_MS, description: "wait without pattern: return after this long with no output. Default 1000." })),
      timeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 60, description: "wait: time limit, at most 60. Default 10." })),
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
            await settle(info.id, { session, idleMs: SETTLE_MS * 2, maxMs: SETTLE_MAX_MS }, context);
            const now = registry.get(info.id);
            const note = now?.status === "ended" ? "The program already ended. If it needs no TTY, run it with bash instead." : undefined;
            return out(screen(info.id, session, 0, note));
          }
          case "send": {
            const id = need("id");
            if (!args.text && !args.keys?.length && !args.enter) throw new Error("send needs keys, text, or enter.");
            const appCursor = registry.agentMode(id, session, 1);
            const data = (args.keys ?? []).map(k => keyBytes(k, appCursor)).join("") + (args.text ?? "") + (args.enter ? "\r" : "");
            registry.agentWrite(id, session, data);
            // Give the program time to react before reading the screen.
            await new Promise(r => setTimeout(r, 30));
            await settle(id, { session, idleMs: SETTLE_MS, maxMs: SETTLE_MAX_MS }, context);
            return out(screen(id, session));
          }
          case "read": return out(screen(need("id"), session, args.scrollback ?? 0));
          case "wait": {
            const id = need("id");
            let pattern: RegExp | undefined;
            if (args.pattern) { try { pattern = new RegExp(args.pattern, "m"); } catch (e) { throw new Error(`Invalid pattern: ${(e as Error).message}`); } }
            const result = await settle(id, { session, pattern, idleMs: args.idleMs ?? 1000, maxMs: Math.min(MAX_WAIT_MS, (args.timeoutSec ?? 10) * 1000) }, context);
            const note = result === "matched" ? "Pattern found." : result === "ended" ? "The program ended." : result === "idle" ? "Output stopped." : pattern ? "Timed out; the pattern is not on the screen." : "Timed out; output did not stop.";
            return out(screen(id, session, 0, note));
          }
          case "resize": {
            const id = need("id");
            const cur = registry.agentScreen(id, session).info;
            registry.agentResize(id, session, args.cols ?? cur.cols, args.rows ?? cur.rows);
            await settle(id, { session, idleMs: SETTLE_MS, maxMs: SETTLE_MAX_MS }, context);
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
