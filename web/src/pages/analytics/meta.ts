import type { AnalyticsTab } from "../../../../src/analytics/types";

/** What each tab answers, which headline numbers it shows, and how its table reads. */
export interface TabMeta {
  label: string;
  question: string;
  /** Summary keys from the query result. `tableTotal` is the row count of the main table. */
  kpis: string[];
  tableTitle: string;
  tableHint: string;
  /** The server's default table sort, so the header can show it before the user picks one. */
  defaultSort: string;
}

export const TAB_META: Record<AnalyticsTab, TabMeta> = {
  overview: {
    label: "Overview",
    question: "How much did Luna do and spend, and when?",
    kpis: ["cost", "totalTokens", "sessions", "responses", "cacheHitRate", "errorRate"],
    tableTitle: "Recent sessions",
    tableHint: "Newest first. Select a session to see its usage ledger and events.",
    defaultSort: "lastActivity:desc",
  },
  models: {
    label: "Models",
    question: "Which models cost the most, and how well do they use the cache?",
    kpis: ["cost", "responses", "totalTokens", "cacheHitRate", "responseErrorRate", "avgDurationMs"],
    tableTitle: "Models",
    tableHint: "One row per model. Select a model to see its recent calls.",
    defaultSort: "cost:desc",
  },
  tools: {
    label: "Tools",
    question: "Which tools and skills run most, and which ones fail?",
    kpis: ["toolCalls", "toolErrors", "toolErrorRate", "sessions"],
    tableTitle: "Tools and skills",
    tableHint: "Direct: the model called the tool. Codemode: a codemode script called it. Select a row to see recent calls.",
    defaultSort: "calls:desc",
  },
  sessions: {
    label: "Sessions",
    question: "Which sessions used the most tokens and money?",
    kpis: ["sessions", "responses", "totalTokens", "cost"],
    tableTitle: "Sessions",
    tableHint: "Sort by Tokens or Cost to find the heaviest sessions. Select a session for details.",
    defaultSort: "lastActivity:desc",
  },
  delegation: {
    label: "Delegation",
    question: "Which sessions handed work to other sessions, and what did that work cost?",
    kpis: ["tableTotal"],
    tableTitle: "Delegation events",
    tableHint: "From: the session that sent the work. To: the session that received it. Cost and tokens belong to the receiving session.",
    defaultSort: "ts:desc",
  },
  reliability: {
    label: "Reliability",
    question: "What failed, how often, and on which model?",
    kpis: ["responseErrors", "responseErrorRate", "aborts", "toolErrors", "toolErrorRate"],
    tableTitle: "Failures",
    tableHint: "Every failed or aborted response and failed tool call, newest first.",
    defaultSort: "ts:desc",
  },
  speed: {
    label: "Speed",
    question: "How fast do models answer and tools finish?",
    kpis: ["responses", "avgDurationMs"],
    tableTitle: "Model response time",
    tableHint: "Median: half of responses were faster. p95: 95% were faster, so it shows the slow tail.",
    defaultSort: "p95DurationMs:desc",
  },
  context: {
    label: "Context",
    question: "How large is the context, how much comes from cache, and when does it compact?",
    kpis: ["inputTokens", "cacheRead", "cacheWrite", "cacheHitRate"],
    tableTitle: "Context events",
    tableHint: "Responses, system prompts, and compactions, newest first. Empty cells were not recorded by the provider.",
    defaultSort: "ts:desc",
  },
  workflow: {
    label: "Workflow",
    question: "How are goals, todos, uploads, and waits used per session?",
    kpis: ["sessions"],
    tableTitle: "Session workflow",
    tableHint: "Counts show the latest state of each session, not a history.",
    defaultSort: "lastActivity:desc",
  },
  projects: {
    label: "Projects",
    question: "Which project, machine, and folder use the most?",
    kpis: ["sessions", "totalTokens", "cost"],
    tableTitle: "Projects by folder",
    tableHint: "One row per project, machine, and working folder. Select a row to list its sessions.",
    defaultSort: "cost:desc",
  },
};

export const METRIC_LABELS: Record<string, string> = {
  cost: "Cost (estimate)",
  totalTokens: "Total tokens",
  sessions: "Sessions",
  responses: "Model responses",
  cacheHitRate: "Cache hit rate",
  errorRate: "Error rate",
  responseErrors: "Failed responses",
  responseErrorRate: "Response error rate",
  aborts: "Aborted responses",
  toolCalls: "Tool calls",
  toolErrors: "Failed tool calls",
  toolErrorRate: "Tool error rate",
  avgDurationMs: "Avg response time",
  inputTokens: "Uncached input",
  outputTokens: "Output tokens",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  tableTotal: "Rows",
};

/** Plain-language definitions for metrics and table columns. Keys are backend field names. */
export const METRIC_HELP: Record<string, string> = {
  cost: "Estimated USD from recorded usage and catalog prices. It is not an invoice.",
  totalTokens: "Uncached input + output + cache read + cache write tokens.",
  sessions: "Sessions with activity that matches the filters.",
  responses: "Model responses (one per assistant message).",
  cacheHitRate: "Cache read ÷ (uncached input + cache read + cache write). Higher is cheaper and faster.",
  errorRate: "Failed responses and failed tool calls ÷ all responses and tool calls.",
  responseErrors: "Model responses that ended with an error.",
  responseErrorRate: "Failed responses ÷ all responses.",
  aborts: "Responses that stopped before they finished (for example, you pressed Stop).",
  toolCalls: "Tool and skill calls, direct and from codemode scripts.",
  toolErrors: "Tool calls that returned an error.",
  toolErrorRate: "Failed tool calls ÷ all tool calls.",
  avgDurationMs: "Mean time from request to the complete model response.",
  inputTokens: "Input tokens sent without a cache hit.",
  outputTokens: "Tokens the model generated.",
  cacheRead: "Input tokens served from the provider's prompt cache.",
  cacheWrite: "Input tokens written into the prompt cache.",
  tableTotal: "Rows in the table below.",
  directCalls: "Calls the model made itself.",
  codemodeCalls: "Calls made from inside a codemode script.",
  p50DurationMs: "Median: half of the samples were faster.",
  p95DurationMs: "95% of the samples were faster. Shows the slow tail.",
  outputTokensPerSec: "Output tokens ÷ response time.",
  mismatchRate: "Share of responses where the provider served a different model than requested.",
  chars: "Size of the compacted or system text, in characters.",
  thinkingChars: "Size of the model's reasoning text, in characters.",
  avgThinkingChars: "Mean reasoning size per response, in characters.",
  cacheReadTokens: "Input tokens served from the prompt cache for this response.",
  targetTotalTokens: "Total tokens of the receiving session.",
  targetCost: "Estimated cost of the receiving session.",
  uploadBytes: "Total size of uploaded files.",
  servedModel: "The model the provider reports it actually used.",
  thinkingLevel: "Reasoning effort setting for the response.",
};

export type SeriesUnit = "usd" | "count" | "tokens" | "ms";

export function seriesKind(name: string): { unit: SeriesUnit; aggregate: "sum" | "mean" } {
  if (/duration|latency/i.test(name)) return { unit: "ms", aggregate: "mean" };
  if (/cost|usd/i.test(name)) return { unit: "usd", aggregate: "sum" };
  if (/token/i.test(name)) return { unit: "tokens", aggregate: "sum" };
  return { unit: "count", aggregate: "sum" };
}

/** Friendly titles and explanations for the extra tables some tabs return. */
export const SECTION_META: Record<string, { title: string; hint: string }> = {
  "Reliability by Model & Reason": {
    title: "Failures by model and reason",
    hint: "Grouped by requested model, served model, and error reason. Mismatch: the provider served a different model than requested.",
  },
  "Tool Latencies": {
    title: "Tool run time",
    hint: "Time from tool call to result. Sorted by p95, slowest first.",
  },
  "Slowest Sessions (Turn Wall Times)": {
    title: "Slowest sessions",
    hint: "Wall time of whole turns, from your message to the final answer.",
  },
  "Cache & Thinking by Model": {
    title: "Cache and reasoning by model",
    hint: "Cache use and reasoning size per model and thinking level.",
  },
  "Compactions by Day": {
    title: "Compactions per day",
    hint: "How often a session's context was summarized to fit, per UTC day.",
  },
  "Workflow Events (Wait / Switch / Undo)": {
    title: "Waits, model switches, and undos",
    hint: "Newest first.",
  },
};

export const RANGE_PRESETS = [
  { value: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { value: "90d", label: "Last 90 days", ms: 90 * 86_400_000 },
] as const;
export type RangePreset = "all" | "custom" | (typeof RANGE_PRESETS)[number]["value"];
