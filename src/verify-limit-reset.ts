// Classifier units: real provider error strings map to wait (with or without a reset time), fatal, or none.
import assert from "node:assert/strict";
import { classifyLimit } from "./limit-reset.js";

// 2026-10-20 18:00:00 UTC = 21:00 in Asia/Amman (UTC+3).
const now = Date.UTC(2026, 9, 20, 18, 0, 0);
const at = (s: string, tz = "UTC") => classifyLimit(s, now, tz);
const wait = (s: string, resetAt?: number, tz?: string) => assert.deepEqual(at(s, tz), resetAt === undefined ? { kind: "wait" } : { kind: "wait", resetAt }, s);
const fatal = (s: string) => assert.deepEqual(at(s), { kind: "fatal" }, s);
const none = (s: string) => assert.deepEqual(at(s), { kind: "none" }, s);

// Claude subscription (native transport): clock time in a named zone, next occurrence. 00:30 Amman = 21:30 UTC.
wait("Incomplete upstream response (first upstream attempt: status 429, capture incomplete, native retries denied: 0, upstream said: This request would exceed your account's rate limit. Please try again later.): You've hit your session limit · resets 12:30am (Asia/Amman)",
  Date.UTC(2026, 9, 20, 21, 30));
// Already past today in that zone: tomorrow. 20:00 Amman = 17:00 UTC < now.
wait("You've hit your usage limit · resets 8pm (Asia/Amman)", Date.UTC(2026, 9, 21, 17, 0));
// Weekly limit with a date.
wait("You've hit your weekly limit · resets Oct 24, 10am (Asia/Amman)", Date.UTC(2026, 9, 24, 7, 0));
// No zone: the default zone applies.
wait("Claude usage limit reached. resets 11pm", Date.UTC(2026, 9, 20, 23, 0));
wait("Claude usage limit reached. resets 11pm", Date.UTC(2026, 9, 20, 20, 0), "Asia/Amman");

// Codex / ChatGPT: no time in the plain message, epoch after the pi-ai patch, minutes in the friendly form.
wait("The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.");
wait("You have hit your ChatGPT usage limit (plus plan). (resets_at=1792540800)", 1792540800_000);
wait("You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.", now + 42 * 60_000);

// OpenAI / Groq / DeepSeek API rate limits.
wait("429: Rate limit reached for gpt-4.1 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 6m0s.", now + 360_000);
wait("429 Rate limit reached for model `llama-3.3-70b` on tokens per day. Please try again in 1m26.4s.", now + 86_400);
// Google: RetryInfo.
wait('429: {"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}', now + 37_000);
// ISO reset.
wait("Rate limited. Quota resets at 2026-10-21T00:00:00Z", Date.UTC(2026, 9, 21));
// Plain limit, no time: backoff decides.
wait("429 Too Many Requests");
wait("Anthropic overloaded_error: Overloaded");
// A "use an API key" hint inside a limit message is not an auth failure.
wait("usage limit reached; use an API key instead (401 not involved)");

// Waiting does not fix these.
fatal("429: You exceeded your current quota, please check your plan and billing details. insufficient_quota");
fatal("400 prompt is too long: 210000 tokens > 200000 maximum");
fatal("This model's maximum context length is 128000 tokens.");
fatal("401 Invalid API key");
fatal("Your credit balance is too low to access the Anthropic API.");
fatal("402 Payment Required");

// Not a limit.
none("Network error: ECONNRESET");
none("");
console.log("LIMIT_RESET_OK: claude clock+zone+date, codex epoch/minutes/none, openai durations, google retryDelay, iso, plain 429, fatal and none");
