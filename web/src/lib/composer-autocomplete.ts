export type AutocompleteMatch = { start: number; end: number; query: string };

export function matchAt(value: string, caret: number): AutocompleteMatch | null {
  const m = /(?:^|[\s([{"'])@([^\s@]*)$/.exec(value.slice(0, caret));
  if (!m) return null;
  const query = m[1] || "";
  return { start: caret - query.length - 1, end: caret, query };
}

export function matchHash(value: string, caret: number): AutocompleteMatch | null {
  const m = /(?:^|[\s([{"'])#([^\s#]*)$/.exec(value.slice(0, caret));
  if (!m) return null;
  const query = m[1] || "";
  return { start: caret - query.length - 1, end: caret, query };
}

export function matchSlash(value: string, caret: number): AutocompleteMatch | null {
  const before = value.slice(0, caret);
  const lead = /^(\s*)\/([^\n]*)$/.exec(before);
  if (!lead) return null;
  const rawAfterSlash = lead[2] || "";
  const slashStart = (lead[1] || "").length;
  const tokens = rawAfterSlash.trimStart().split(/\s+/).filter(Boolean);
  const firstToken = (tokens[0] || "").toLowerCase();
  const hasTrailingSpace = /\s$/.test(rawAfterSlash);

  if (firstToken === "queue") {
    const subToken = (tokens[1] || "").toLowerCase();
    if (tokens.length > 2 || (tokens.length === 2 && hasTrailingSpace)) {
      return null;
    }
    if (tokens.length === 2 && !["list", "edit", "remove", "move", "clear"].some(s => s.startsWith(subToken))) {
      return null;
    }
  } else if (tokens.length > 1 || (tokens.length === 1 && hasTrailingSpace)) {
    return null;
  }

  const query = rawAfterSlash.replace(/\s+/g, " ");
  return { start: slashStart, end: caret, query };
}
