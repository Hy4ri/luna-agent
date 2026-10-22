// CommonMark-style fenced code scanning, shared by markdown.ts and segments.ts.
// A fence opens with 3+ backticks or tildes and closes only on a bare line of the same
// character that is at least as long. Any indent is accepted on open (fences inside list items).

export interface Fence {
  char: "`" | "~";
  len: number;
  /** Text after the opening run, trimmed. */
  info: string;
}

export function openFence(line: string): Fence | null {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const info = m[2].trim();
  // A backtick fence cannot have a backtick in its info string (it would be inline code).
  if (m[1][0] === "`" && info.includes("`")) return null;
  return { char: m[1][0] as "`" | "~", len: m[1].length, info };
}

export function closesFence(line: string, fence: Fence): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === fence.char && m[1].length >= fence.len;
}

/** Language label: the first word of the info string, restricted to the characters markdown.ts always allowed. */
export function fenceLang(fence: Fence): string {
  return /^[\w#+-]*/.exec(fence.info)?.[0] ?? "";
}

/** Index of the closing line at or after `from`, or -1 when the fence never closes. */
export function findFenceEnd(lines: string[], from: number, fence: Fence): number {
  for (let i = from; i < lines.length; i++) if (closesFence(lines[i], fence)) return i;
  return -1;
}
