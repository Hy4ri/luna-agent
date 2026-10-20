// Pure helpers for tool-specific views in the transcript. No Vue; covered by the chat-view browser gate.

export type DiffRow = { kind: "add" | "del" | "ctx" | "skip"; line?: number; text: string };
export type AnsiSpan = { text: string; cls: string };
export type ToolView = "edit" | "bash" | "write" | "read" | "process" | "todo" | "web_search" | "web_extract" | "answers" | "skill" | "media" | "text" | "generic";

const TEXT_TOOLS = new Set([
  "board", "remember", "recall", "forget", "cron_create", "cron_list", "cron_runs", "cron_toggle", "cron_remove",
  "create_goal", "get_goal", "update_goal", "set_goal_tasks", "update_goal_task", "delegate_task", "session_search",
  "tool_search", "inspect_runs", "extract_lessons", "skill_rollback", "skill_list", "skill_manage", "session_handoff",
  "browser_open", "browser_navigate", "browser_close", "browser_snapshot", "browser_click", "browser_type", "browser_scroll", "browser_screenshot",
]);

/** Which renderer a call uses. Unknown tools (MCP and others) keep the generic arguments/output card. */
export function toolView(name: string): ToolView {
  if (["edit", "bash", "write", "read", "todo", "web_search", "web_extract"].includes(name)) return name as ToolView;
  if (name === "process_start" || name === "process_manage") return "process";
  if (name === "ask_user_question") return "answers";
  if (name === "skill_view" || name === "skill_propose") return "skill";
  if (name === "image_generate" || name === "vision_analyze") return "media";
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
    case "browser_click": return clip(str(a.ref) ? "ref " + a.ref : str(a.selector));
    case "browser_type": return clip(`"${str(a.text)}" → ${str(a.ref) ? "ref " + a.ref : str(a.selector)}`);
    case "browser_scroll": return [str(a.direction), typeof a.amount === "number" ? a.amount + "px" : ""].filter(Boolean).join(" ");
    case "process_manage": return [str(a.action), str(a.id).slice(0, 8)].filter(Boolean).join(" ");
    case "todo": return [str(a.action), typeof a.id === "number" ? "#" + a.id : "", str(a.subject) || str(a.status)].filter(Boolean).map(s => clip(s, 60)).join(" ");
    case "board": return [str(a.action), typeof a.id === "number" ? "#" + a.id : "", clip(str(a.subject), 60) || str(a.status)].filter(Boolean).join(" ");
    case "cron_create": return [str(a.name), str(a.expr) && `[${a.expr}]`].filter(Boolean).join(" ");
    case "cron_toggle": case "cron_remove": case "cron_runs": return typeof a.id === "number" ? `job ${a.id}` + (typeof a.enabled === "boolean" ? (a.enabled ? " on" : " off") : "") : "";
    case "forget": return typeof a.id === "number" ? "#" + a.id : "";
    case "remember": return clip(str(a.key) || str(a.content));
    case "update_goal_task": return [str(a.task_id), str(a.status)].filter(Boolean).join(" ");
    case "update_goal": return str(a.status);
    case "set_goal_tasks": return Array.isArray(a.tasks) ? `${a.tasks.length} task${a.tasks.length === 1 ? "" : "s"}` : "";
    case "ask_user_question": return Array.isArray(a.questions) && a.questions[0] ? clip(str(a.questions[0].question)) + (a.questions.length > 1 ? ` +${a.questions.length - 1}` : "") : "";
    case "delegate_task": return clip([str(a.action), str(a.task)].filter(Boolean).join(" · "));
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
