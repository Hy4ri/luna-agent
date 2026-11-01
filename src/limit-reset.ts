// Usage-limit classification for automatic continuation. Pure: no I/O, the clock is a parameter.
// - "wait": a rate or usage limit that ends by itself. `resetAt` (epoch ms) is set when the error names a time.
// - "fatal": waiting cannot fix it (context overflow, auth, billing, an empty pay-as-you-go balance).
// - "none": not a limit error.
// Patterns come from real provider errors: Codex/ChatGPT (resets_at epoch), Claude subscription
// ("resets 12:30am (Asia/Amman)"), OpenAI/Groq/DeepSeek ("try again in 6m0s"), Google (retryDelay "37s",
// ErrorInfo quotaResetTimeStamp/quotaResetDelay), plain 429.

export type ResetSource = "quota_timestamp" | "quota_delay" | "retry_after" | "message";

export type ResetEvidence = {
  resetAt: number;
  source: ResetSource;
  exact: boolean;
};

export type LimitClass =
  | { kind: "wait"; resetAt?: number; resetSource?: ResetSource; exact?: boolean }
  | { kind: "fatal" }
  | { kind: "none" };

const FATAL_TEXT = [
  /\bcontext[_ -]?(?:window|length)\b/i,
  /\bcontext.{0,30}(?:exceeded|too (?:large|long))/i,
  /\bprompt is too long\b/i,
  /\bmax(?:imum)?[_ -](?:tokens|context)\b/i,
  /\binput is too long\b/i,
  /\binsufficient_quota\b/i,
  /\b(?:credit|available) balance\b/i,
  /\bout of budget\b/i,
  /\bpayment required\b/i,
  /\bbilling_error\b/i,
  /\binvalid[_ -](?:api|x-api)[_ -]?key\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bauthentication(?:[_ -](?:failed|error))?\b/i,
];

const WAIT_PATTERNS = [
  /\b429\b/,
  /\b529\b/,
  /\brate[_ -]?limit(?:ed)?\b/i,
  /\busage[_ -]limit/i,
  /\bsession limit\b/i,
  /\bweekly limit\b/i,
  /\bhit your (?:\w+ )?limit\b/i,
  /\btoo many requests\b/i,
  /\bquota\b/i,
  /\bresource[_ ]exhausted\b/i,
  /\boverloaded\b/i,
  /\bcapacity (?:exceeded|exhausted)\b/i,
  /\bexceed your account's rate limit\b/i,
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MAX_EPOCH_MS = 8.64e15;

/** Validate IANA timezone or Etc/GMT(+|-)offset. Returns normalized zone or throws. */
function validateTimezone(tz: string): string {
  new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
  return tz;
}

/** Offset (ms) of `tz` from UTC at instant `at`. Throws on an unknown zone. */
function zoneOffset(at: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(new Date(at))
      .filter(p => p.type !== "literal")
      .map(p => [p.type, Number(p.value)])
  );
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in `tz`. Round-trips to verify nonexistent DST gap. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | undefined {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffset(guess, tz);
  const target = guess - zoneOffset(first, tz);
  // Verify wall parts match to reject nonexistent DST gap or impossible dates
  const check = wallDateTime(target, tz);
  if (check.y !== y || check.mo !== mo || check.d !== d || check.h !== h || check.mi !== mi) {
    return undefined;
  }
  return target;
}

function wallDate(at: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date(at))
      .filter(x => x.type !== "literal")
      .map(x => [x.type, Number(x.value)])
  );
  return { y: p.year!, mo: p.month! - 1, d: p.day! };
}

function wallDateTime(at: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(new Date(at))
      .filter(x => x.type !== "literal")
      .map(x => [x.type, Number(x.value)])
  );
  return { y: p.year!, mo: p.month! - 1, d: p.day!, h: p.hour!, mi: p.minute! };
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
}

/** "resets 12:30am (Asia/Amman)", "resets Oct 24, 10am (UTC)", "resets at 5pm". Next occurrence after `now`. */
function clockReset(text: string, now: number, defaultTz: string): number | undefined {
  // Capture explicit zones completely; invalid text must not silently select the default zone.
  const m = /\bresets?(?:\s+at)?\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:\(([^)\r\n]+)\))?/i.exec(text);
  if (!m || (!m[4] && !m[5])) return undefined;
  let h = Number(m[3]);
  const mi = Number(m[4] ?? 0);
  const ap = m[5]?.toLowerCase().replace(/\./g, "");
  if (h > 23 || mi > 59 || (ap && (h < 1 || h > 12))) return undefined;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;

  if (!m[6] && text.slice(m.index + m[0].length).trimStart().startsWith("(")) return undefined;
  const rawTz = m[6];
  let tz: string;
  if (rawTz) {
    try {
      tz = validateTimezone(rawTz);
    } catch {
      // Invalid explicit timezone must not fall back to default
      return undefined;
    }
  } else {
    try {
      tz = validateTimezone(defaultTz);
    } catch {
      return undefined;
    }
  }

  try {
    const today = wallDate(now, tz);
    if (m[1]) {
      const mo = MONTHS.indexOf(m[1].toLowerCase());
      if (mo < 0) return undefined;
      const day = Number(m[2]);
      if (day < 1 || day > daysInMonth(today.y, mo)) return undefined;

      let at = zoned(today.y, mo, day, h, mi, tz);
      if (at !== undefined && at < now - 86_400_000) {
        if (day > daysInMonth(today.y + 1, mo)) return undefined;
        at = zoned(today.y + 1, mo, day, h, mi, tz);
      }
      return at;
    }

    let at = zoned(today.y, today.mo, today.d, h, mi, tz);
    if (at === undefined) return undefined;
    if (at <= now) {
      const nextDayDate = new Date(Date.UTC(today.y, today.mo, today.d + 1));
      at = zoned(nextDayDate.getUTCFullYear(), nextDayDate.getUTCMonth(), nextDayDate.getUTCDate(), h, mi, tz);
    }
    return at;
  } catch {
    return undefined;
  }
}

/**
 * Strict parser for compound durations like "4h47m6.263787177s", "6m0s", "1m26.4s", "37s", "17226.263787177s".
 * Rejects negative signs, unconsumed tokens/garbage, and values overflowing max allowed epoch.
 */
function parseRecognizedDuration(s: string, maxAllowedMs = MAX_EPOCH_MS): number | undefined {
  const str = s.trim();
  if (!str || str.includes("-")) return undefined;

  let totalMs = 0;
  let lastIndex = 0;
  let matches = 0;

  const re = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|hours?|hrs?|h|min(?:ute)?s?|m|sec(?:ond)?s?|s)(?![a-z])/gi;
  for (const m of str.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;

    // Check intermediate substring between tokens: only whitespace and commas/and permitted
    const between = str.slice(lastIndex, start).trim();
    if (between && between !== "," && between !== "and" && between !== ", and") {
      return undefined;
    }
    lastIndex = end;

    const val = Number(m[1]);
    if (!Number.isFinite(val) || val < 0) return undefined;
    const unit = m[2]!.toLowerCase();
    matches++;

    const tokenMs =
      unit === "ms" || unit.startsWith("milli")
        ? val
        : unit.startsWith("h")
        ? val * 3_600_000
        : unit.startsWith("m")
        ? val * 60_000
        : val * 1000;

    totalMs += tokenMs;
    if (!Number.isFinite(totalMs) || totalMs > maxAllowedMs) return undefined;
  }

  // Trailing garbage check
  const trailing = str.slice(lastIndex).trim();
  if (trailing || matches === 0) return undefined;

  const ceilMs = Math.ceil(totalMs);
  return ceilMs <= maxAllowedMs ? ceilMs : undefined;
}

/**
 * Strict ISO-8601 parser. Validates calendar bounds and rounds fractional seconds upward.
 */
function parseStrictIso(isoStr: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-]\d{2}):?(\d{2}))$/.exec(isoStr);
  if (!m) return undefined;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6] ?? 0);
  const frac = m[7] ? Number(m[7]) : 0;

  if (mo < 1 || mo > 12) return undefined;
  if (d < 1 || d > daysInMonth(y, mo - 1)) return undefined;
  if (h > 23 || mi > 59 || s > 59) return undefined;

  let offsetMinutes = 0;
  if (m[8] !== undefined) {
    const sign = m[8][0] === "-" ? -1 : 1;
    const offH = Number(m[8].slice(1));
    const offM = Number(m[9]);
    if (offH > 23 || offM > 59) return undefined;
    offsetMinutes = sign * (offH * 60 + offM);
  }

  const baseUtcMs = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
  const fracMs = Math.ceil(frac * 1000);
  const total = baseUtcMs + fracMs;
  return Number.isFinite(total) && total > 0 && total <= MAX_EPOCH_MS ? total : undefined;
}

/**
 * Parse HTTP-date (RFC 7231 / RFC 1123 / RFC 850 / asctime).
 */
function parseHttpDate(str: string): number | undefined {
  const t = Date.parse(str);
  return Number.isFinite(t) && t > 0 && t <= MAX_EPOCH_MS ? t : undefined;
}

/**
 * Parse strict timestamp: numeric epoch (seconds or ms by magnitude) or strict ISO.
 */
function parseTimestamp(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    // Strict ISO check
    if (trimmed.includes("T")) {
      return parseStrictIso(trimmed);
    }

    // Numeric epoch string check
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      // Use numeric magnitude: >= 1e11 is ms, otherwise seconds
      const ms = n >= 1e11 ? Math.ceil(n) : Math.ceil(n * 1000);
      return ms <= MAX_EPOCH_MS ? ms : undefined;
    }
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    const ms = raw >= 1e11 ? Math.ceil(raw) : Math.ceil(raw * 1000);
    return ms <= MAX_EPOCH_MS ? ms : undefined;
  }
  return undefined;
}

/** Bounded extraction of JSON object (max 4000 characters). */
function extractJsonPayload(text: string): Record<string, unknown> | undefined {
  if (text.length > 4000) return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Structured reset evidence extraction from Google error details and provider text.
 * Within same window: quotaResetTimeStamp > quotaResetDelay > retryDelay/Retry-After > text.
 * Multiple windows: latest constraint wins.
 */
export function resetEvidence(
  text: string,
  receivedAt = Date.now(),
  defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone
): ResetEvidence | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const maxAllowedDuration = MAX_EPOCH_MS - receivedAt;
  const payload = extractJsonPayload(trimmed);
  const rootObj =
    payload && typeof payload.error === "object" && payload.error !== null && !Array.isArray(payload.error)
      ? (payload.error as Record<string, unknown>)
      : payload;

  if (rootObj && Array.isArray(rootObj.details)) {
    let latestQuotaTimestamp: number | undefined;
    let latestQuotaDelayResetAt: number | undefined;
    let latestRetryAfterResetAt: number | undefined;

    for (const detail of rootObj.details.slice(0, 32)) {
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
      const type = (detail as Record<string, unknown>)["@type"];

      if (type === "type.googleapis.com/google.rpc.ErrorInfo") {
        const meta = (detail as Record<string, unknown>).metadata;
        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
          const rec = meta as Record<string, unknown>;
          if (typeof rec.quotaResetTimeStamp === "string") {
            const ts = parseTimestamp(rec.quotaResetTimeStamp);
            if (ts !== undefined) {
              latestQuotaTimestamp = Math.max(latestQuotaTimestamp ?? 0, ts);
            }
          }
          if (typeof rec.quotaResetDelay === "string") {
            const d = parseRecognizedDuration(rec.quotaResetDelay, maxAllowedDuration);
            if (d !== undefined) {
              latestQuotaDelayResetAt = Math.max(latestQuotaDelayResetAt ?? 0, receivedAt + d);
            }
          }
        }
      } else if (type === "type.googleapis.com/google.rpc.RetryInfo") {
        const rd = (detail as Record<string, unknown>).retryDelay;
        if (typeof rd === "string") {
          const d = parseRecognizedDuration(rd, maxAllowedDuration);
          if (d !== undefined) {
            latestRetryAfterResetAt = Math.max(latestRetryAfterResetAt ?? 0, receivedAt + d);
          }
        }
      }
    }

    // Within same quota window, absolute timestamp overrides conflicting relative quota delay
    const quotaResetAt = latestQuotaTimestamp ?? latestQuotaDelayResetAt;
    const quotaSource: ResetSource = latestQuotaTimestamp !== undefined ? "quota_timestamp" : "quota_delay";

    // ErrorInfo and RetryInfo in one refusal describe the same quota unless the provider
    // explicitly identifies separate blocked windows. Prefer its absolute quota evidence.
    if (quotaResetAt !== undefined && latestRetryAfterResetAt !== undefined) {
      return { resetAt: quotaResetAt, source: quotaSource, exact: true };
    }

    if (quotaResetAt !== undefined) {
      return { resetAt: quotaResetAt, source: quotaSource, exact: true };
    }

    if (latestRetryAfterResetAt !== undefined) {
      return { resetAt: latestRetryAfterResetAt, source: "retry_after", exact: false };
    }
  }

  // Fallback regex extraction for malformed prefixed bodies

  // 1. Quota timestamp in raw metadata string e.g. quotaResetTimeStamp: "..."
  const rawQuotaTimestamp = /"quotaResetTimeStamp"\s*:\s*"([^"]+)"/i.exec(trimmed);
  if (rawQuotaTimestamp) {
    const ts = parseTimestamp(rawQuotaTimestamp[1]!);
    if (ts !== undefined) {
      return { resetAt: ts, source: "quota_timestamp", exact: true };
    }
  }

  // 2. Epoch in text: resets_at / ratelimit-reset
  const epoch =
    /\bresets?[_ -]?at"?\s*[:=]\s*"?(\d{10,13}(?:\.\d+)?)\b/i.exec(trimmed) ??
    /\bratelimit-(?:unified-)?reset"?\s*[:=]\s*"?(\d{10,13}(?:\.\d+)?)\b/i.exec(trimmed);
  if (epoch) {
    const ts = parseTimestamp(epoch[1]!);
    if (ts !== undefined) {
      return { resetAt: ts, source: "quota_timestamp", exact: true };
    }
  }

  // 3. Generic strict ISO timestamp
  const iso = /\b(?:resets?|until|after|at)\s*[:=]?\s*"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
    trimmed
  );
  if (iso) {
    const t = parseStrictIso(iso[1]!);
    if (t !== undefined) {
      return { resetAt: t, source: "quota_timestamp", exact: true };
    }
  }

  // 4. Quota delay in raw metadata string
  const rawQuotaDelay = /"quotaResetDelay"\s*:\s*"([^"]+)"/i.exec(trimmed);
  if (rawQuotaDelay) {
    const d = parseRecognizedDuration(rawQuotaDelay[1]!, maxAllowedDuration);
    if (d !== undefined) {
      return { resetAt: receivedAt + d, source: "quota_delay", exact: true };
    }
  }

  // 5. Retry guidance: retryDelay, retry-after, retry-after-ms
  const retryDelay = /"retryDelay"\s*:\s*"([^"]+)"/i.exec(trimmed);
  if (retryDelay) {
    const d = parseRecognizedDuration(retryDelay[1]!, maxAllowedDuration);
    if (d !== undefined) {
      return { resetAt: receivedAt + d, source: "retry_after", exact: false };
    }
  }

  const retryAfter = /\bretry[- ]after(?:-ms)?\s*[:=]\s*"?([^"\r\n;]+)"?/i.exec(trimmed);
  if (retryAfter) {
    const isMs = /retry-after-ms/i.test(retryAfter[0]);
    const val = retryAfter[1]!.trim();
    if (/^\d+(\.\d+)?$/.test(val)) {
      const num = Number(val);
      if (Number.isFinite(num) && num >= 0) {
        const ms = Math.ceil(num * (isMs ? 1 : 1000));
        if (ms <= maxAllowedDuration) {
          return { resetAt: receivedAt + ms, source: "retry_after", exact: false };
        }
      }
    } else {
      // Check HTTP-date (e.g. Wed, 21 Oct 2026 07:28:00 GMT)
      const httpAt = parseHttpDate(val);
      if (httpAt !== undefined) {
        return { resetAt: httpAt, source: "retry_after", exact: false };
      }
    }
  }

  // 6. Human-readable text delay
  const rel =
    /\b(?:try again|retry|resets?|available again)\s+in\s+(?:about\s+|approximately\s+|~\s*)?((?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|hours?|hrs?|h|min(?:ute)?s?|m|sec(?:ond)?s?|s)(?![a-z])\s*,?\s*(?:and\s+)?)+)/i.exec(
      trimmed
    );
  if (rel) {
    const d = parseRecognizedDuration(rel[1]!, maxAllowedDuration);
    if (d !== undefined) {
      return { resetAt: receivedAt + d, source: "message", exact: false };
    }
  }

  // 7. Clock-based reset (e.g. "resets 12:30am (Asia/Amman)")
  const clock = clockReset(trimmed, receivedAt, defaultTz);
  if (clock !== undefined) {
    return { resetAt: clock, source: "message", exact: true };
  }

  return undefined;
}

/** Extract explicit HTTP status code from wrapper/body instead of searching arbitrary numbers. */
function extractExplicitHttpStatus(text: string): number | undefined {
  const payload = extractJsonPayload(text);
  const rootObj =
    payload && typeof payload.error === "object" && payload.error !== null && !Array.isArray(payload.error)
      ? (payload.error as Record<string, unknown>)
      : payload;

  if (rootObj) {
    const code = rootObj.code;
    if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) {
      return code;
    }
    const status = rootObj.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }

  // Match HTTP status at the beginning of the message: e.g. "401: Unauthorized", "403 Forbidden"
  const prefixMatch = /^(?:status\s*)?(\d{3})\b/i.exec(text);
  if (prefixMatch) {
    const code = Number(prefixMatch[1]);
    if (code >= 100 && code <= 599) return code;
  }

  return undefined;
}

export function classifyLimit(
  message: string,
  now = Date.now(),
  defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone
): LimitClass {
  const text = message.trim();
  if (!text) return { kind: "none" };

  const httpStatus = extractExplicitHttpStatus(text);
  if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) {
    return { kind: "fatal" };
  }

  if (FATAL_TEXT.some(r => r.test(text))) {
    return { kind: "fatal" };
  }

  const wait = WAIT_PATTERNS.some(r => r.test(text));
  if (!wait) {
    return /\bbilling\b/i.test(text) ? { kind: "fatal" } : { kind: "none" };
  }

  const evidence = resetEvidence(text, now, defaultTz);
  if (evidence !== undefined) {
    return {
      kind: "wait",
      resetAt: evidence.resetAt,
      resetSource: evidence.source,
      exact: evidence.exact,
    };
  }

  return { kind: "wait" };
}
