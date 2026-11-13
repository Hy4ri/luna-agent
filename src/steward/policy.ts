// When and where Steward may show cards: quiet hours, the daily cap, and the project scope.
export interface StewardPolicy { maxNewPerDay: number; quietHours: { enabled: boolean; from: string; to: string } | null; projects: { mode: "all" | "only" | "except"; ids: number[] } }

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h! * 60 + m!; };
/** Is the local time of `now` inside the window? A window that crosses midnight (22:00 to 08:00) works. */
export function inQuietHours(q: StewardPolicy["quietHours"], now: number): boolean {
  if (!q?.enabled) return false;
  const d = new Date(now), cur = d.getHours() * 60 + d.getMinutes(), from = minutes(q.from), to = minutes(q.to);
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}
export function inScope(p: StewardPolicy["projects"], projectId: number): boolean {
  return p.mode === "all" ? true : p.mode === "only" ? p.ids.includes(projectId) : !p.ids.includes(projectId);
}
export function startOfLocalDay(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
