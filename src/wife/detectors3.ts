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
    body: `${w.merged ? "Its branch is merged." : "Its session is deleted."}${w.dirty ? " It has uncommitted changes, so Wife will not remove it. Clean it up by hand." : " Agree removes the worktree and deletes the branch."}`,
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

/** The same tool failing in 3 or more sessions in a week. The signature is the tool name. */
export function toolErrorRepeat(rows: { name: string; errors: number; sessions: number; sample: number[] }[], week: string, min = 3): NewSuggestion[] {
  return rows.filter(r => r.sessions >= min).map(r => ({
    kind: "tool_error_repeat" as const, fingerprint: `tool_error_repeat:${r.name}:${week}`, source: "detector" as const,
    title: `Tool "${r.name}" keeps failing`, body: `${r.errors} errors in ${r.sessions} sessions this week. Discuss to find the cause.`,
    evidence: r.sample.slice(0, 3).map(id => ({ sessionId: id, note: `${r.name} error` })), payload: { tool: r.name } }));
}

/** A managed skill with no use in `days` that is also older than `days`. */
export function skillsUnused(skills: { name: string; managed: boolean; modified: number }[], lastUse: Map<string, number>, now: number, days = 60): NewSuggestion[] {
  return skills.filter(s => s.managed && now - s.modified >= days * DAY && now - (lastUse.get(s.name) ?? 0) >= days * DAY).map(s => ({
    kind: "skill_unused" as const, fingerprint: `skill_unused:${s.name}`, source: "detector" as const,
    title: `Archive skill "${s.name}"`, body: `No session has loaded it in ${days} days. Agree moves it to the skill trash, and you can restore it from there.`,
    evidence: [], payload: { name: s.name } }));
}

const norm = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
export interface UserMsg { conv: number; ts: number; text: string }
/** Almost the same prompt at least 3 times, from different sessions, at least 20 hours apart on average. */
export function promptRepeat(msgs: UserMsg[], min = 3): NewSuggestion[] {
  const groups = new Map<string, UserMsg[]>();
  for (const m of msgs) { if (m.text.length < 30 || m.text.startsWith("/")) continue; const k = norm(m.text); groups.set(k, [...(groups.get(k) ?? []), m]); }
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
  for (const f of firsts) { if (f.project === 0 || f.text.length < 80) continue; const k = `${f.project}|${norm(f.text).slice(0, 200)}`; groups.set(k, [...(groups.get(k) ?? []), f]); }
  const out: NewSuggestion[] = [];
  for (const [k, g] of groups) {
    if (g.length < min) continue;
    out.push({ kind: "project_setup_repeat", fingerprint: `project_setup_repeat:${Bun.hash(k).toString(36)}`, source: "detector", title: "Put your session setup in the project",
      body: `${g.length} sessions in this project start with the same text: "${g[0]!.text.slice(0, 120)}". Agree starts a session that adds it to the project's AGENTS.md.`,
      evidence: g.slice(0, 3).map(f => ({ sessionId: f.conv, note: "same opening" })), payload: { project: g[0]!.project, text: g[0]!.text.slice(0, 2000) } });
  }
  return out;
}
