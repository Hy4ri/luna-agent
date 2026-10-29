import { ref, watch } from "vue";

/** old and new: line numbers in each version; null where the line does not exist (and on hunk or meta rows). */
export type DiffLine = { kind: "add" | "del" | "ctx" | "hunk" | "meta"; old: number | null; new: number | null; text: string };
type CodeLine = DiffLine & { kind: "add" | "del" | "ctx" };

/**
 * Parses unified diff text into display rows with old and new line numbers.
 * Accepts `git diff` output (one or more files) and GitHub patches (hunks only).
 */
export function parseDiff(text: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let inHunk = false, oldNo = 0, newNo = 0;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { inHunk = true; oldNo = Number(hunk[1]); newNo = Number(hunk[2]); rows.push({ kind: "hunk", old: null, new: null, text: line }); continue; }
    // File headers come before the first hunk of each file. The file name is shown elsewhere,
    // so keep only the informative ones (mode, rename, copy, binary).
    if (!inHunk) { if (!/^(?:index |--- |\+\+\+ )/.test(line)) rows.push({ kind: "meta", old: null, new: null, text: line }); continue; }
    if (line.startsWith("+")) rows.push({ kind: "add", old: null, new: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: oldNo++, new: null, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", old: null, new: null, text: line });
    else rows.push({ kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) });
  }
  return rows;
}

export type SplitRow =
  | { kind: "pair"; left: CodeLine | null; right: CodeLine | null }
  | { kind: "hunk" | "meta"; text: string };

/** Side-by-side rows: a run of removed lines is paired with the added lines that follow it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.kind === "hunk" || line.kind === "meta") { rows.push({ kind: line.kind, text: line.text }); i++; continue; }
    if (line.kind === "ctx") { rows.push({ kind: "pair", left: line as CodeLine, right: line as CodeLine }); i++; continue; }
    const del: CodeLine[] = [], add: CodeLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") del.push(lines[i++] as CodeLine);
    while (i < lines.length && lines[i]!.kind === "add") add.push(lines[i++] as CodeLine);
    for (let k = 0; k < Math.max(del.length, add.length); k++) rows.push({ kind: "pair", left: del[k] ?? null, right: add[k] ?? null });
  }
  return rows;
}

const MODE_KEY = "luna.diff.mode";
/** Preferred diff layout. Split applies only where the view is wide enough. */
export const diffMode = ref<"unified" | "split">(localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified");
watch(diffMode, mode => localStorage.setItem(MODE_KEY, mode));

/** Short label and color for a Git file status letter (A, D, M, R, C, T). */
export function statusStyle(status: string) {
  switch (status) {
    case "A": return { label: "Added", cls: "text-emerald-400" };
    case "D": return { label: "Deleted", cls: "text-rose-400" };
    case "R": return { label: "Renamed", cls: "text-sky-400" };
    case "C": return { label: "Copied", cls: "text-sky-400" };
    case "T": return { label: "Type changed", cls: "text-amber-400" };
    default: return { label: "Modified", cls: "text-amber-400" };
  }
}
