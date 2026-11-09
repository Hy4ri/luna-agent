// Pure helpers for tool-specific views in the transcript. No Vue; covered by the chat-view browser gate.

export type DiffRow = { kind: "add" | "del" | "ctx" | "skip"; line?: number; text: string };
export type AnsiSpan = { text: string; cls: string };
export type ToolView = "edit" | "bash" | "write" | "read" | "process" | "todo" | "web_search" | "web_extract" | "answers" | "skill" | "media" | "codemode" | "text" | "generic";

const TEXT_TOOLS = new Set([
  // cron_history stays for older transcripts; it is now cron runs/get_run/lessons.
  "board", "memory", "cron", "cron_history", "goal", "delegate_task", "session_search",
  "tool_search", "session_handoff", "browser_tab", "browser_inspect", "browser_act",
]);

/** Image and video analysis. vision_analyze and video_analyze are the retired names in older transcripts. */
export const ANALYZE_TOOLS = new Set(["media_analyze", "vision_analyze", "video_analyze"]);

/** Which renderer a call uses. Unknown tools (MCP and others) keep the generic arguments/output card.
 * `web` picks its view from the action; web_search and web_extract are the retired names in older transcripts. */
export function toolView(name: string, args?: unknown): ToolView {
  if (name === "codemode") return "codemode";
  if (name === "web") return (args as { action?: unknown } | undefined)?.action === "read" ? "web_extract" : "web_search";
  if (["edit", "bash", "write", "read", "todo", "web_search", "web_extract"].includes(name)) return name as ToolView;
  if (name === "process") return "process";
  if (name === "ask_user_question") return "answers";
  if (name === "skill_view") return "skill";
  // Content-carrying skill changes show the proposed SKILL.md; list and other actions stay plain text.
  if (name === "skill_manage") return "skill";
  if (name === "image_generate" || ANALYZE_TOOLS.has(name)) return "media";
  return TEXT_TOOLS.has(name) ? "text" : "generic";
}

function clip(text: string, max = 80): string {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
const str = (v: unknown) => typeof v === "string" && v ? v : "";

/** The single most useful argument of a call, shown next to the tool name. Empty when no argument fits. */
export function toolSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, any>;
  switch (name) {
    case "read": {
      if (!str(a.path)) return "";
      const from = typeof a.offset === "number" ? a.offset : undefined;
      const to = from !== undefined && typeof a.limit === "number" ? from + a.limit - 1 : undefined;
      return clip(a.path) + (from === undefined ? "" : to === undefined ? `:${from}` : `:${from}–${to}`);
    }
    case "browser_tab": return [str(a.action), clip(str(a.url), 60) || str(a.tabId).slice(0, 8)].filter(Boolean).join(" ");
    case "browser_inspect": return [str(a.action), str(a.tabId).slice(0, 8)].filter(Boolean).join(" ");
    case "browser_act": {
      const el = str(a.ref) ? "ref " + a.ref : str(a.selector);
      if (a.action === "type") return clip(`type "${str(a.text)}" → ${el}`);
      if (a.action === "scroll") return ["scroll", str(a.direction), typeof a.amount === "number" ? a.amount + "px" : ""].filter(Boolean).join(" ");
      return clip(["click", el].filter(Boolean).join(" "));
    }
    case "process": return a.action === "start" ? clip("start " + str(a.command)) : [str(a.action), str(a.id).slice(0, 8)].filter(Boolean).join(" ");
    case "todo": return [str(a.action), typeof a.id === "number" ? "#" + a.id : "", str(a.subject) || str(a.status)].filter(Boolean).map(s => clip(s, 60)).join(" ");
    case "board": return [str(a.action), typeof a.id === "number" ? "#" + a.id : "", clip(str(a.subject), 60) || str(a.status)].filter(Boolean).join(" ");
    case "cron": {
      if (a.action === "create") return [str(a.action), str(a.name), str(a.expr) && `[${a.expr}]`].filter(Boolean).join(" ");
      return [str(a.action), typeof a.id === "number" ? `job ${a.id}` : typeof a.runId === "number" ? `run #${a.runId}` : "", typeof a.enabled === "boolean" ? (a.enabled ? "on" : "off") : ""].filter(Boolean).join(" ");
    }
    case "cron_history": return [str(a.action), typeof a.runId === "number" ? `run #${a.runId}` : typeof a.id === "number" ? `job ${a.id}` : ""].filter(Boolean).join(" ");
    case "memory": return [str(a.action), a.action === "forget" ? (typeof a.id === "number" ? "#" + a.id : "") : clip(str(a.key) || str(a.content) || str(a.query), 60)].filter(Boolean).join(" ");
    case "goal": {
      if (a.action === "update_task") return ["update_task", str(a.task_id), str(a.status)].filter(Boolean).join(" ");
      if (a.action === "update") return ["update", str(a.status)].filter(Boolean).join(" ");
      if (a.action === "set_tasks") return Array.isArray(a.tasks) ? `set_tasks ${a.tasks.length} task${a.tasks.length === 1 ? "" : "s"}` : "set_tasks";
      if (a.action === "create") return clip("create " + str(a.objective));
      return str(a.action);
    }
    case "skill_manage": return [str(a.action), str(a.name), str(a.file_path)].filter(Boolean).join(" ");
    case "ask_user_question": return Array.isArray(a.questions) && a.questions[0] ? clip(str(a.questions[0].question)) + (a.questions.length > 1 ? ` +${a.questions.length - 1}` : "") : "";
    case "delegate_task": return clip([str(a.action), str(a.task)].filter(Boolean).join(" · "));
    case "codemode": return clip(str(a.code));
    case "web": return [str(a.action), clip(str(a.action) === "read" ? str(a.url) : str(a.query), 70)].filter(Boolean).join(" ");
  }
  for (const key of ["path", "command", "query", "url", "objective", "prompt", "question", "name", "subject", "action"]) if (str(a[key])) return clip(a[key]);
  return "";
}

/** Rows of the pi edit tool's `details.diff`: `[+- ]<padded line> <text>`, with `...` marking skipped context. */
export function parseEditDiff(diff: string): DiffRow[] {
  return diff.split("\n").map(raw => {
    const m = /^([+\- ])( *)(\d*) (.*)$/.exec(raw);
    if (!m) return { kind: "ctx", text: raw } as DiffRow;
    if (!m[3] && m[4] === "...") return { kind: "skip", text: "…" } as DiffRow;
    const kind = m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx";
    return { kind, line: m[3] ? Number(m[3]) : undefined, text: m[4]! } as DiffRow;
  });
}

/** Fallback when no `details.diff` exists (call still running or failed): old/new blocks, no line numbers. */
export function argsEditDiff(args: unknown): DiffRow[] {
  const edits = (args as any)?.edits;
  if (!Array.isArray(edits)) return [];
  const rows: DiffRow[] = [];
  edits.forEach((e: any, i: number) => {
    if (i > 0) rows.push({ kind: "skip", text: "…" });
    for (const t of String(e?.oldText ?? "").split("\n")) rows.push({ kind: "del", text: t });
    for (const t of String(e?.newText ?? "").split("\n")) rows.push({ kind: "add", text: t });
  });
  return rows;
}

export function diffCounts(rows: DiffRow[]): { add: number; del: number } {
  return { add: rows.filter(r => r.kind === "add").length, del: rows.filter(r => r.kind === "del").length };
}

/** Split result text from the `<harness>` diagnostics block the runtime appends; return the exit code it reports. */
export function splitHarness(text: string): { output: string; exit?: number; diagnostics: string } {
  const m = /\n?<harness>\n([\s\S]*?)\n<\/harness>\s*$/.exec(text);
  if (!m) return { output: text, diagnostics: "" };
  const exit = /Command exited with code (\d+)/.exec(m[1]!);
  return { output: text.slice(0, m.index), exit: exit ? Number(exit[1]) : undefined, diagnostics: m[1]! };
}

/** Diagnostic lines without their `[severity]` prefix. */
export const diagnosticLines = (diagnostics: string) => diagnostics.split("\n").map(l => l.replace(/^\[\w+\]\s*/, "")).filter(Boolean);

export function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

export type DockTarget = { pane: "browser" | "terminal"; id?: string };
const BROWSER_TOOLS = new Set(["browser_tab", "browser_inspect", "browser_act"]);

/** The dock pane a call worked in, and the tab or terminal it used when the arguments or output name one. */
export function dockTarget(name: string, args: unknown, output: string): DockTarget | undefined {
  const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
  if (BROWSER_TOOLS.has(name)) {
    // browser_tab open returns the new handle; every other call names it.
    const id = str(a.tabId) || str(parseJson(output)?.tabId);
    return id ? { pane: "browser", id } : { pane: "browser" };
  }
  if (name === "terminal") {
    // Every screen the tool returns starts with `terminal <id> | ...`.
    const id = str(a.id) || /^terminal (\S+) \|/.exec(output)?.[1];
    return id ? { pane: "terminal", id } : { pane: "terminal" };
  }
  return undefined;
}

/** Numbered lines for a code view; a trailing newline adds no line. */
export function codeLines(text: string, start = 1): { line: number; text: string }[] {
  const lines = text.replace(/\n$/, "").split("\n");
  return text === "" ? [] : lines.map((t, i) => ({ line: start + i, text: t }));
}

export type SearchHit = { title: string; url: string; snippet: string; host: string };
export function searchHits(text: string): SearchHit[] {
  const results = parseJson(text)?.results;
  if (!Array.isArray(results)) return [];
  return results.filter((r: any) => typeof r?.url === "string" && /^https?:\/\//.test(r.url)).map((r: any) => {
    let host = ""; try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { /* checked above */ }
    return { title: str(r.title) || r.url, url: r.url, snippet: str(r.snippet), host };
  });
}

const ANSI = /\x1b\[([0-9;]*)m/g;
const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Basic SGR colours and bold as classes; every other escape sequence is removed. */
export function ansiSpans(text: string): AnsiSpan[] {
  text = text.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  const spans: AnsiSpan[] = [];
  let fg = "", bold = false, at = 0;
  const push = (s: string) => { if (s) spans.push({ text: s, cls: [fg && "ansi-" + fg, bold && "ansi-bold"].filter(Boolean).join(" ") }); };
  for (const m of text.matchAll(ANSI)) {
    push(text.slice(at, m.index));
    at = m.index! + m[0].length;
    for (const code of (m[1] || "0").split(";").map(Number)) {
      if (code === 0) { fg = ""; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) fg = "";
      else if (code >= 30 && code <= 37) fg = COLORS[code - 30]!;
      else if (code >= 90 && code <= 97) fg = COLORS[code - 90]!;
    }
  }
  push(text.slice(at));
  return spans;
}

export type CodemodeNestedCallView = {
  id: number;
  name: string;
  args: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
};

export function parseCodemodeCalls(details: unknown): CodemodeNestedCallView[] {
  if (!details || typeof details !== "object") return [];
  const calls = (details as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return [];
  return calls.filter((c: any): c is CodemodeNestedCallView =>
    c && Number.isSafeInteger(c.id) && c.id >= 0 && typeof c.name === "string" &&
    typeof c.args === "string" && ["running", "ok", "error", "cancelled"].includes(c.status) &&
    (c.durationMs === undefined || typeof c.durationMs === "number" && Number.isFinite(c.durationMs) && c.durationMs >= 0) &&
    (c.error === undefined || typeof c.error === "string"));
}
