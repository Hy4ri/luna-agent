// Contract: a provider error maps to wait (with the reset time when the error names one), fatal, or none.
// A wrong "wait" retries a dead request forever; a wrong "fatal" stops a session that would have recovered.
// Inputs are real provider error strings.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { classifyLimit, type LimitClass } from "../src/limit-reset.js";

// 2026-10-20 18:00:00 UTC = 21:00 in Asia/Amman (UTC+3).
const now = Date.UTC(2026, 9, 20, 18, 0, 0);
const at = (s: string, tz = "UTC") => classifyLimit(s, now, tz);
const resetAt = (s: string, tz?: string) => {
  const got = at(s, tz);
  assert.equal(got.kind, "wait", s);
  return (got as Extract<LimitClass, { kind: "wait" }>).resetAt;
};

test("Claude subscription: clock time in a named zone resolves to its next occurrence", () => {
  // 00:30 Amman = 21:30 UTC, later today.
  assert.equal(resetAt("Incomplete upstream response (first upstream attempt: status 429, capture incomplete, native retries denied: 0, upstream said: This request would exceed your account's rate limit. Please try again later.): You've hit your session limit · resets 12:30am (Asia/Amman)"),
    Date.UTC(2026, 9, 20, 21, 30));
  // 20:00 Amman is already past: tomorrow.
  assert.equal(resetAt("You've hit your usage limit · resets 8pm (Asia/Amman)"), Date.UTC(2026, 9, 21, 17, 0));
  assert.equal(resetAt("You've hit your weekly limit · resets Oct 24, 10am (Asia/Amman)"), Date.UTC(2026, 9, 24, 7, 0));
  // No zone in the message: the default zone applies.
  assert.equal(resetAt("Claude usage limit reached. resets 11pm"), Date.UTC(2026, 9, 20, 23, 0));
  assert.equal(resetAt("Claude usage limit reached. resets 11pm", "Asia/Amman"), Date.UTC(2026, 9, 20, 20, 0));
});

test("Codex / ChatGPT: relative minutes, or no time", () => {
  assert.equal(resetAt("You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."), now + 42 * 60_000);
  assert.equal(resetAt("The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead."), undefined);
});

test("OpenAI-compatible APIs: compound durations", () => {
  assert.equal(resetAt("429: Rate limit reached for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 6m0s."), now + 360_000);
  assert.equal(resetAt("429 Rate limit reached for model `llama-3.3-70b` on tokens per day. Please try again in 1m26.4s."), now + 86_400);
});

test("Google: absolute quota timestamp beats relative retry guidance in the same refusal", () => {
  const retryOnly = '429: {"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}';
  assert.deepEqual(at(retryOnly), { kind: "wait", resetAt: now + 37_000, resetSource: "retry_after", exact: false });
  const both = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetTimeStamp: "2026-10-21T00:00:00Z", quotaResetDelay: "1h" } },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
  ] } });
  assert.deepEqual(at(both), { kind: "wait", resetAt: Date.UTC(2026, 9, 21), resetSource: "quota_timestamp", exact: true });
});

test("generic reset forms: ISO timestamp, Retry-After seconds and HTTP-date", () => {
  assert.equal(resetAt("Rate limited. Quota resets at 2026-10-21T00:00:00Z"), Date.UTC(2026, 9, 21));
  assert.equal(resetAt("429 Too Many Requests; retry-after: 120"), now + 120_000);
  assert.equal(resetAt("429 Too Many Requests; Retry-After: Wed, 21 Oct 2026 07:28:00 GMT"), Date.UTC(2026, 9, 21, 7, 28));
});

test("a limit without a time is still a wait", () => {
  assert.deepEqual(at("429 Too Many Requests"), { kind: "wait" });
  assert.deepEqual(at("Anthropic overloaded_error: Overloaded"), { kind: "wait" });
  // An "API key" hint inside a limit message is not an auth failure.
  assert.deepEqual(at("usage limit reached; use an API key instead"), { kind: "wait" });
});

test("errors that waiting cannot fix are fatal", () => {
  for (const s of [
    "429: You exceeded your current quota, please check your plan and billing details. insufficient_quota",
    "400 prompt is too long: 210000 tokens > 200000 maximum",
    "This model's maximum context length is 128000 tokens.",
    "401 Invalid API key",
    '{"error":{"code":403,"message":"rate limit","status":"PERMISSION_DENIED"}}',
    "Your credit balance is too low to access the Anthropic API.",
    "402 Payment Required",
  ]) assert.deepEqual(at(s), { kind: "fatal" }, s);
});

test("other errors are not limits", () => {
  for (const s of ["Network error: ECONNRESET", "", "500 Internal Server Error"]) assert.deepEqual(at(s), { kind: "none" }, s);
});
