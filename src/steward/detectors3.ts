// Detectors that need more than session records: git worktrees, live terminals, tool errors, skill use, and user prompts.
// Each one is a pure function over plain inputs, so tests need no daemon.
import type { NewSuggestion } from "./store.js";

const DAY = 86_400_000;

export interface WorktreeView { path: string; branch: string; sessionId: number | null; merged: boolean; dirty: boolean; sessionGone: boolean }
/** A session worktree whose branch is merged or whose session is deleted. A dirty tree is reported but cannot be removed by Agree. */
export function worktreeOrphans(list: WorktreeView[]): NewSuggestion[] {
  return list.filter(w => w.merged || w.sessionGone).map(w => ({
    kind: "worktree_orphan" as const, fingerprint: `worktree_orphan:${w.path}`, source: "detector" as const,
    title: `Remove worktree ${w.branch}`,
    body: `${w.merged ? "Its branch is merged." : "Its session is deleted."}${w.dirty ? " It has uncommitted changes, so Steward will not remove it. Clean it up by hand." : " Agree removes the worktree and deletes the branch."}`,
    evidence: w.sessionId ? [{ sessionId: w.sessionId, note: w.merged ? "branch merged" : "session deleted" }] : [], payload: { path: w.path, branch: w.branch, dirty: w.dirty } }));
}

export interface TerminalView { id: string; session: number; command?: string; status: string }
/** A running terminal whose session is idle for more than a day, archived, or gone. */
export function bgLeftovers(terminals: TerminalView[], idle: (session: number) => boolean): NewSuggestion[] {
  return terminals.filter(t => t.status === "running" && idle(t.session)).map(t => ({
    kind: "bg_leftover" as const, fingerprint: `bg_leftover:${t.id}`, source: "detector" as const,
    title: `Stop a leftover terminal${t.command ? `: ${t.command.slice(0, 40)}` : ""}`,
    body: `Still running in session ${t.session}, which has been idle for over a day or is archived.`,
    evidence: [{ sessionId: t.session, note: "idle session" }], payload: { terminalId: t.id } }));
}

export interface BrowserTabView { tabId: string; session: number; url: string }
/** An open browser tab in a session that is idle for more than a day, archived, or gone. */
export function browserLeftovers(tabs: BrowserTabView[], idle: (session: number) => boolean): NewSuggestion[] {
  return tabs.filter(t => idle(t.session)).map(t => ({
    kind: "browser_leftover" as const, fingerprint: `browser_leftover:${t.tabId}`, source: "detector" as const,
    title: `Close a leftover browser tab: ${t.url.replace(/^https?:\/\//, "").slice(0, 50)}`,
    body: `Still open in session ${t.session}, which has been idle for over a day or is archived.`,
    evidence: [{ sessionId: t.session, note: "idle session" }], payload: { tabId: t.tabId, session: t.session } }));
}

export interface ToolErrorRow { name: string; calls: number; errors: number; sessions: number; sample: number[] }
/** Tools that fail on `rate` or more of `minCalls`+ calls in a week, in `minSessions`+ sessions. One folded card per week lists them all. */
export function toolErrorRepeat(rows: ToolErrorRow[], week: string, o: { minCalls?: number; rate?: number; minSessions?: number } = {}): NewSuggestion[] {
  const minCalls = o.minCalls ?? 10, rate = o.rate ?? 0.2, minSessions = o.minSessions ?? 3;
  const bad = rows.filter(r => r.calls >= minCalls && r.errors / r.calls >= rate && r.sessions >= minSessions).sort((a, b) => b.errors / b.calls - a.errors / a.calls);
  if (!bad.length) return [];
  const pct = (r: ToolErrorRow) => `${Math.round(100 * r.errors / r.calls)}%`;
  const line = (r: ToolErrorRow) => `${r.name} ${pct(r)} (${r.errors} of ${r.calls} calls, ${r.sessions} sessions)`;
  const evidence: { sessionId: number; note: string }[] = [];
  for (const r of bad) for (const id of r.sample.slice(0, 2)) if (evidence.length < 5 && !evidence.some(e => e.sessionId === id)) evidence.push({ sessionId: id, note: `${r.name} error` });
  return [{ kind: "tool_error_repeat", fingerprint: `tool_error_repeat:${week}`, source: "detector",
    title: bad.length === 1 ? `Tool "${bad[0]!.name}" fails ${pct(bad[0]!)} of calls` : `${bad.length} tools fail often this week`,
    body: `Failing this week: ${bad.slice(0, 6).map(line).join("; ")}. Discuss to find the cause.`,
    evidence, payload: { tools: bad.map(r => ({ name: r.name, calls: r.calls, errors: r.errors, sessions: r.sessions })), tool: bad[0]!.name } }];
}

/** A managed skill with no use in `days` that is also older than `days`. */
export function skillsUnused(skills: { name: string; managed: boolean; modified: number }[], lastUse: Map<string, number>, now: number, days = 60): NewSuggestion[] {
  return skills.filter(s => s.managed && now - s.modified >= days * DAY && now - (lastUse.get(s.name) ?? 0) >= days * DAY).map(s => ({
    kind: "skill_unused" as const, fingerprint: `skill_unused:${s.name}`, source: "detector" as const,
    title: `Archive skill "${s.name}"`, body: `No session has loaded it in ${days} days. Agree moves it to the skill trash, and you can restore it from there.`,
    evidence: [], payload: { name: s.name } }));
}

/** Messages a peer session or the runtime wrote. They are not prompts m57 typed. */
export const isMachineMessage = (t: string) => /^\[message from session #\d+/.test(t) || t.startsWith("Steward suggests:");
const norm = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
export interface UserMsg { conv: number; ts: number; text: string }
/** Almost the same prompt at least 3 times, from different sessions, at least 20 hours apart on average. */
export function promptRepeat(msgs: UserMsg[], min = 3): NewSuggestion[] {
  const groups = new Map<string, UserMsg[]>();
  for (const m of msgs) { if (m.text.length < 30 || m.text.startsWith("/") || isMachineMessage(m.text)) continue; const k = norm(m.text); groups.set(k, [...(groups.get(k) ?? []), m]); }
  const out: NewSuggestion[] = [];
  for (const [k, g] of groups) {
    const convs = new Set(g.map(m => m.conv));
    if (convs.size < min) continue;
    const ts = g.map(m => m.ts).sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    if (gaps.reduce((a, b) => a + b, 0) / gaps.length < 20 * 3_600_000) continue;
    out.push({ kind: "prompt_repeat", fingerprint: `prompt_repeat:${Bun.hash(k).toString(36)}`, source: "detector", title: "Schedule a prompt you keep sending",
      body: `You sent almost the same prompt ${g.length} times: "${g[0]!.text.slice(0, 120)}". Agree starts a session that drafts a cron job for it.`,
      evidence: [...convs].slice(0, 3).map(c => ({ sessionId: c, note: "same prompt" })), payload: { prompt: g[0]!.text.slice(0, 2000), count: g.length } });
  }
  return out;
}

/** At least 3 sessions in one project open with the same setup text (first 200 characters, case and digits ignored). */
export function projectSetupRepeat(firsts: { conv: number; project: number; text: string }[], min = 3): NewSuggestion[] {
  const groups = new Map<string, { conv: number; project: number; text: string }[]>();
  for (const f of firsts) { if (f.project === 0 || f.text.length < 80 || isMachineMessage(f.text)) continue; const k = `${f.project}|${norm(f.text).slice(0, 200)}`; groups.set(k, [...(groups.get(k) ?? []), f]); }
  const out: NewSuggestion[] = [];
  for (const [k, g] of groups) {
    if (g.length < min) continue;
    out.push({ kind: "project_setup_repeat", fingerprint: `project_setup_repeat:${Bun.hash(k).toString(36)}`, source: "detector", title: "Put your session setup in the project",
      body: `${g.length} sessions in this project start with the same text: "${g[0]!.text.slice(0, 120)}". Agree starts a session that adds it to the project's AGENTS.md.`,
      evidence: g.slice(0, 3).map(f => ({ sessionId: f.conv, note: "same opening" })), payload: { project: g[0]!.project, text: g[0]!.text.slice(0, 2000) } });
  }
  return out;
}
