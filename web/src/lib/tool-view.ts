// Pure helpers for tool-specific views in the transcript. No Vue; covered by the chat-view browser gate.

export type DiffRow = { kind: "add" | "del" | "ctx" | "skip"; line?: number; text: string };
export type AnsiSpan = { text: string; cls: string };

const SUMMARY_KEYS = ["path", "command", "query", "url", "pattern", "subject", "name", "prompt", "question", "action"];

function clip(text: string, max = 80): string {
  const line = text.split("\n", 1)[0]!.trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** The single most useful argument of a call, shown next to the tool name. Empty when no argument fits. */
export function toolSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (name === "read" && typeof a.path === "string") {
    const from = typeof a.offset === "number" ? a.offset : undefined;
    const to = from !== undefined && typeof a.limit === "number" ? from + a.limit - 1 : undefined;
    return clip(a.path) + (from === undefined ? "" : to === undefined ? `:${from}` : `:${from}–${to}`);
  }
  for (const key of SUMMARY_KEYS) if (typeof a[key] === "string" && a[key]) return clip(a[key] as string);
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

/** Split bash result text from the harness diagnostics block the runtime appends; return the exit code it reports. */
export function bashResult(text: string): { output: string; exit?: number; diagnostics: string } {
  const m = /\n?<harness>\n([\s\S]*?)\n<\/harness>\s*$/.exec(text);
  if (!m) return { output: text, diagnostics: "" };
  const exit = /Command exited with code (\d+)/.exec(m[1]!);
  return { output: text.slice(0, m.index), exit: exit ? Number(exit[1]) : undefined, diagnostics: m[1]! };
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
