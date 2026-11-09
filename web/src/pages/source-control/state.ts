// Source Control page state that survives reloads: the URL hash (section and open item) and saved filters.
export type Section = "changes" | "history" | "branches" | "pr" | "issue";
export type HashState = { section: Section; number?: number };
export type StateFilter = "open" | "closed" | "all";
export type Prefs = { section?: Section; state?: StateFilter };

const SECTIONS: readonly Section[] = ["changes", "history", "branches", "pr", "issue"];
const STATES: readonly StateFilter[] = ["open", "closed", "all"];
const PREFIX = "#source-control";

/** `#source-control`, `#source-control/history`, `#source-control/pr/148`. Anything else is Changes. */
export function parseHash(hash: string): HashState {
  const fallback: HashState = { section: "changes" };
  if (hash !== PREFIX && !hash.startsWith(PREFIX + "/")) return fallback;
  const parts = hash.slice(PREFIX.length + 1).split("/");
  const section = parts[0] as Section;
  if (parts.length === 1 && parts[0] === "") return fallback;
  if (!SECTIONS.includes(section) || section === "changes") return fallback;
  if (section === "pr" || section === "issue") {
    if (parts.length === 1) return { section };
    if (parts.length > 2 || !/^\d{1,9}$/.test(parts[1]!) || Number(parts[1]) < 1) return fallback;
    return { section, number: Number(parts[1]) };
  }
  return parts.length === 1 ? { section } : fallback;
}

export function formatHash(state: HashState): string {
  if (state.section === "changes") return PREFIX;
  return `${PREFIX}/${state.section}${state.number ? `/${state.number}` : ""}`;
}

export function readPrefs(raw: string | null): Prefs {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>, out: Prefs = {};
    if (SECTIONS.includes(value.section as Section)) out.section = value.section as Section;
    if (STATES.includes(value.state as StateFilter)) out.state = value.state as StateFilter;
    return out;
  } catch { return {}; }
}

export const mergePrefs = (current: Prefs, patch: Prefs): Prefs => ({ ...current, ...patch });
