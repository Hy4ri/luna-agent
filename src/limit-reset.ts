// Usage-limit classification for automatic continuation. Pure: no I/O, the clock is a parameter.
// - "wait": a rate or usage limit that ends by itself. `resetAt` (epoch ms) is set when the error names a time.
// - "fatal": waiting cannot fix it (context overflow, auth, billing, an empty pay-as-you-go balance).
// - "none": not a limit error.
// Patterns come from real provider errors: Codex/ChatGPT (resets_at epoch), Claude subscription
// ("resets 12:30am (Asia/Amman)"), OpenAI/Groq/DeepSeek ("try again in 6m0s"), Google (retryDelay "37s"), plain 429.

export type LimitClass = { kind: "wait"; resetAt?: number } | { kind: "fatal" } | { kind: "none" };

const FATAL = [
  /\bcontext[_ -]?(?:window|length)\b/i, /\bcontext.{0,30}(?:exceeded|too (?:large|long))/i, /\bprompt is too long\b/i,
  /\bmax(?:imum)?[_ -](?:tokens|context)\b/i, /\binput is too long\b/i,
  /\binsufficient_quota\b/i, /\bcredit balance\b/i, /\bbilling\b/i, /\bpayment required\b/i, /\b402\b/,
  /\b(?:401|403)\b/, /\binvalid (?:api|x-api)[_ -]?key\b/i, /\bunauthori[sz]ed\b/i, /\bauthentication\b/i,
];
const WAIT = [
  /\b429\b/, /\b529\b/, /\brate[_ -]?limit(?:ed)?\b/i, /\busage[_ -]limit/i, /\bsession limit\b/i, /\bweekly limit\b/i,
  /\bhit your (?:\w+ )?limit\b/i, /\btoo many requests\b/i, /\bquota\b/i, /\bresource[_ ]exhausted\b/i,
  /\boverloaded\b/i, /\bcapacity (?:exceeded|exhausted)\b/i, /\bexceed your account's rate limit\b/i,
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset (ms) of `tz` from UTC at instant `at`. Throws on an unknown zone. */
function zoneOffset(at: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(at)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000;
}
/** Epoch ms of a wall-clock time in `tz`. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffset(guess, tz);
  return guess - zoneOffset(first, tz);
}
function wallDate(at: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(at)).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
  return { y: p.year!, mo: p.month! - 1, d: p.day! };
}

/** "resets 12:30am (Asia/Amman)", "resets Oct 24, 10am (UTC)", "resets at 5pm". Next occurrence after `now`. */
function clockReset(text: string, now: number, defaultTz: string): number | undefined {
  const m = /\bresets?(?:\s+at)?\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(text);
  if (!m || (!m[4] && !m[5])) return undefined;
  let h = Number(m[3]); const mi = Number(m[4] ?? 0), ap = m[5]?.toLowerCase().replace(/\./g, "");
  if (h > 23 || mi > 59 || ap && (h < 1 || h > 12)) return undefined;
  if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
  const tz = m[6] ?? defaultTz;
  try {
    const today = wallDate(now, tz);
    if (m[1]) {
      const mo = MONTHS.indexOf(m[1].toLowerCase()); if (mo < 0) return undefined;
      let at = zoned(today.y, mo, Number(m[2]), h, mi, tz);
      if (at < now - 86_400_000) at = zoned(today.y + 1, mo, Number(m[2]), h, mi, tz);
      return at;
    }
    let at = zoned(today.y, today.mo, today.d, h, mi, tz);
    if (at <= now) at = zoned(today.y, today.mo, today.d + 1, h, mi, tz);
    return at;
  } catch { return undefined; }
}

/** "6m0s", "1m26.4s", "1h2m", "37s", "20 seconds", "~5 min". Returns ms. */
function duration(s: string): number | undefined {
  let ms = 0, hit = false;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|hours?|hrs?|h|min(?:ute)?s?|m|sec(?:ond)?s?|s)(?![a-z])/gi)) {
    const v = Number(n), unit = u!.toLowerCase(); hit = true;
    ms += unit === "ms" || unit.startsWith("milli") ? v : unit.startsWith("h") ? v * 3_600_000 : unit.startsWith("m") ? v * 60_000 : v * 1000;
  }
  return hit ? Math.round(ms) : undefined;
}

/** Reset time in epoch ms, when the message names one. */
export function resetTime(text: string, now: number, defaultTz: string): number | undefined {
  const epoch = /\bresets?[_ -]?at"?\s*[:=]\s*"?(\d{10,13})\b/i.exec(text) ?? /\bratelimit-(?:unified-)?reset"?\s*[:=]\s*"?(\d{10,13})\b/i.exec(text);
  if (epoch) { const n = Number(epoch[1]); return epoch[1]!.length === 13 ? n : n * 1000; }
  const iso = /\b(?:resets?|until|after|at)\s*[:=]?\s*"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (iso) { const t = Date.parse(iso[1]!); if (Number.isFinite(t)) return t; }
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(text) ?? /\bretry[- ]after(?:-ms)?\s*[:=]\s*(\d+(?:\.\d+)?)\b/i.exec(text);
  if (delay) return now + Math.round(Number(delay[1]) * (/retry-after-ms/i.test(delay[0]) ? 1 : 1000));
  const rel = /\b(?:try again|retry|resets?|available again)\s+in\s+(?:about\s+|approximately\s+|~\s*)?((?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|hours?|hrs?|h|min(?:ute)?s?|m|sec(?:ond)?s?|s)(?![a-z])\s*,?\s*(?:and\s+)?)+)/i.exec(text);
  if (rel) { const d = duration(rel[1]!); if (d !== undefined) return now + d; }
  return clockReset(text, now, defaultTz);
}

export function classifyLimit(message: string, now = Date.now(), defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone): LimitClass {
  const text = message.trim();
  if (!text) return { kind: "none" };
  const wait = WAIT.some(r => r.test(text));
  // A 429 body may say "billing" in a hint ("or use an API key"), so a named wait wins over a soft fatal word,
  // except for the cases that never reset by themselves.
  if (/\binsufficient_quota\b|\bcredit balance\b|\bcontext[_ -]?(?:window|length)\b|\bprompt is too long\b|\binput is too long\b/i.test(text)) return { kind: "fatal" };
  if (!wait) return FATAL.some(r => r.test(text)) ? { kind: "fatal" } : { kind: "none" };
  const resetAt = resetTime(text, now, defaultTz);
  return resetAt !== undefined ? { kind: "wait", resetAt } : { kind: "wait" };
}
