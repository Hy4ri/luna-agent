// Minimal 5-field cron: minute hour day-of-month month day-of-week (local time).
// Supports *, lists, ranges, steps, names (jan-dec, sun-sat), and @hourly/@daily/@weekly/@monthly/@yearly.
const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface CronSpec { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function field(src: string, lo: number, hi: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const val = (s: string): number => {
    const ni = names?.indexOf(s.toLowerCase()) ?? -1;
    const n = ni >= 0 ? ni + nameBase : Number(s);
    if (!Number.isInteger(n) || !/^[A-Za-z0-9]+$/.test(s)) throw new Error(`bad cron value "${s}"`);
    return n;
  };
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in "${part}"`);
    let a: number, b: number;
    if (range === "*") { a = lo; b = hi; }
    else if (range!.includes("-")) { const [x, y] = range!.split("-"); a = val(x!); b = val(y!); }
    else { a = val(range!); b = stepS === undefined ? a : hi; }
    if (a < lo || b > hi || a > b) throw new Error(`cron value out of range [${lo}-${hi}] in "${part}"`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const e = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields, got ${f.length}: "${expr}"`);
  const dow = field(f[4]!, 0, 7, DAYS);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    min: field(f[0]!, 0, 59), hour: field(f[1]!, 0, 23), dom: field(f[2]!, 1, 31),
    mon: field(f[3]!, 1, 12, MONTHS, 1), dow,
    domStar: f[2]!.startsWith("*"), dowStar: f[4]!.startsWith("*"),
  };
}

function dayMatches(s: CronSpec, dom: number, dow: number): boolean {
  const dm = s.dom.has(dom), dw = s.dow.has(dow);
  if (s.domStar && s.dowStar) return true;
  if (s.domStar) return dw;
  if (s.dowStar) return dm;
  return dm || dw; // standard cron: both restricted => OR
}

// At a forward offset change, treat missing wall-clock minutes as due at the gap boundary.
function gapMatches(s: CronSpec, d: Date): boolean {
  const time = d.getTime();
  const previousOffset = new Date(time - 60_000).getTimezoneOffset();
  const offset = d.getTimezoneOffset();
  for (let missing = previousOffset - offset; missing > 0; missing--) {
    const wall = new Date(time - (offset + missing) * 60_000);
    if (s.mon.has(wall.getUTCMonth() + 1) && dayMatches(s, wall.getUTCDate(), wall.getUTCDay()) &&
        s.hour.has(wall.getUTCHours()) && s.min.has(wall.getUTCMinutes())) return true;
  }
  return false;
}

/** Next fire time strictly after `after` (epoch ms), local time.
 * Missing DST times run at the gap boundary; both occurrences of repeated times are eligible.
 */
export function nextRun(expr: string | CronSpec, after: number): number {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date((Math.floor(after / 60_000) + 1) * 60_000);
  const limit = after + 5 * 366 * 86400_000;
  while (d.getTime() <= limit) {
    if (gapMatches(s, d)) return d.getTime();
    if (!s.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(s, d.getDate(), d.getDay())) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (s.hour.has(d.getHours()) && s.min.has(d.getMinutes())) return d.getTime();
    // Calendar setters can skip the repeated hour or move backwards inside it.
    // Keep day/month skips above, but traverse eligible days in elapsed minutes.
    d.setTime(d.getTime() + 60_000);
  }
  throw new Error(`cron "${typeof expr === "string" ? expr : "spec"}" never fires within 5 years`);
}
