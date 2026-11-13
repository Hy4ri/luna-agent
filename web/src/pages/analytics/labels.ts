import type { AnalyticsValue } from "../../../../src/analytics/types";
import { workers } from "@/stores/workers";
import { compact, durationFormat, pct, usd, when } from "./formatters";

/** Machine ids are stored as "main" or a worker id; show the names the sidebar uses. */
export function machineLabel(value: string | number): string {
  const v = String(value);
  if (v === "main" || v === "") return "This host";
  const w = workers.list.find(x => String(x.id) === v);
  return w?.name || `Machine ${v}`;
}

/** Two decimals reads well in tables; the exact amount stays in the cell title. */
export function usdShort(n: number): string {
  if (n !== 0 && Math.abs(n) < 0.01) return n < 0 ? "-<$0.01" : "<$0.01";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export const FIELD_LABELS: Record<string, string> = {
  id: "ID",
  title: "Title",
  parentId: "Parent session",
  projectName: "Project",
  worker: "Machine",
  cwd: "Working directory",
  status: "Status",
  statusReason: "Status reason",
  createdAt: "Created",
  lastActivity: "Last activity",
  deletedAt: "Deleted",
  archived: "Archived",
  pinned: "Pinned",
  input: "Input tokens",
  output: "Output tokens",
  cacheRead: "Cache read tokens",
  cacheWrite: "Cache write tokens",
  cacheWrite1h: "Cache write (1h) tokens",
  reasoning: "Reasoning tokens",
  totalTokens: "Total tokens",
  costInput: "Input cost (estimate)",
  costOutput: "Output cost (estimate)",
  costCacheRead: "Cache read cost (estimate)",
  costCacheWrite: "Cache write cost (estimate)",
  costTotal: "Total cost (estimate)",
  subtreeSessions: "Subtree sessions",
  subtreeTotalTokens: "Subtree total tokens",
  subtreeCost: "Subtree cost (estimate)",
  kind: "Kind",
  name: "Name",
  model: "Model",
  source: "Source",
  durationMs: "Duration",
  error: "Error",
  aborted: "Aborted",
  ts: "Time",
  sessionId: "Session",
  provider: "Provider",
  responses: "Responses",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  cacheHitRate: "Cache hit rate",
  cost: "Cost (estimate)",
  avgDurationMs: "Avg duration",
  errorRate: "Error rate",
  firstSeen: "First seen",
  lastSeen: "Last seen",
  calls: "Calls",
  directCalls: "Direct calls",
  codemodeCalls: "Codemode calls",
  errors: "Errors",
  eventKind: "Type",
  chars: "Characters",
  thinkingChars: "Thinking characters",
  cacheReadTokens: "Cache read tokens",
  thinkingLevel: "Thinking level",
  servedModel: "Served model",
  errorReason: "Error reason",
  count: "Count",
  aborts: "Aborts",
  mismatchRate: "Mismatch rate",
  sourceSessionId: "From session",
  targetSessionId: "To session",
  sourceTitle: "From",
  targetTitle: "To",
  targetStatus: "Receiver status",
  targetTotalTokens: "Receiver tokens",
  targetCost: "Receiver cost (estimate)",
  outcome: "Outcome",
  p50DurationMs: "Median duration (p50)",
  p95DurationMs: "p95 duration",
  maxDurationMs: "Max duration",
  outputTokensPerSec: "Output tokens / sec",
  turns: "Turns",
  goals: "Goals",
  completedGoals: "Completed goals",
  todos: "Todos",
  completedTodos: "Completed todos",
  visionCalls: "Vision calls",
  uploads: "Uploads",
  uploadBytes: "Upload size",
  day: "Day",
  compactions: "Compactions",
  avgChars: "Avg characters",
  avgThinkingChars: "Avg thinking characters",
  sessions: "Sessions",
};

export const VALUE_LABELS: Record<string, string> = {
  "delegate.child": "Subagent spawned",
  "delegate.msg": "Message to subagent",
  "luna.xsession.msg": "Cross-session message",
  response: "Model response",
  tool: "Tool call",
  skill: "Skill",
  compaction: "Compaction",
  system: "System prompt",
  model_switch: "Model switch",
  undo: "Undo",
  wait: "Wait",
  quota_wait: "Quota wait",
  turn: "Turn",
  direct: "Direct",
  codemode: "Codemode",
  running: "Running",
  finished: "Finished",
  ready: "Ready",
  failed: "Failed",
  stopped: "Stopped",
  reviewing: "Reviewing",
  review_finished: "Review finished",
  needs_approval: "Needs approval",
  needs_input: "Needs input",
  limit_reached: "Limit reached",
  completed: "Completed",
  pending: "Pending",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Provider errors often arrive as "429: {json}". Show the status and the message, not the JSON. */
export function readableError(raw: string): string {
  const m = /^(\d{3}):\s*(\{[\s\S]*)$/.exec(raw.trim());
  if (!m) return raw;
  try {
    const body = JSON.parse(m[2]!) as { message?: unknown; type?: unknown; error?: { message?: unknown; type?: unknown } };
    const msg = body.error?.message ?? body.message;
    const type = body.error?.type ?? body.type;
    const label = typeof type === "string" ? type.replace(/_/g, " ") : "";
    return [m[1], label, typeof msg === "string" ? msg : ""].filter(Boolean).join(" · ");
  } catch {
    return raw;
  }
}

export function fieldLabel(key: string): string {
  if (key in FIELD_LABELS) return FIELD_LABELS[key];
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export type FieldKind =
  | "id"
  | "session"
  | "date"
  | "ms"
  | "usd"
  | "percent"
  | "bytes"
  | "bool"
  | "tokens"
  | "number"
  | "text";

const SESSION_KEYS = new Set([
  "sessionId",
  "sourceSessionId",
  "targetSessionId",
  "parentId",
]);

const DATE_KEYS = new Set([
  "ts",
  "createdAt",
  "lastActivity",
  "deletedAt",
  "firstSeen",
  "lastSeen",
]);

const TOKEN_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
]);

export function fieldKind(key: string, value: unknown): FieldKind {
  if (SESSION_KEYS.has(key)) return "session";
  if (key === "id") return "id";
  if (DATE_KEYS.has(key)) return "date";
  if (/durationms$/i.test(key)) return "ms";
  if (/^cost|cost$|Cost$/.test(key)) return "usd";
  if (/rate$/i.test(key)) return "percent";
  if (key === "uploadBytes") return "bytes";
  if (typeof value === "boolean") return "bool";
  if (key.toLowerCase().includes("token") || TOKEN_KEYS.has(key)) return "tokens";
  if (typeof value === "number") return "number";
  return "text";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${Math.round(bytes)} B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (abs < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function fullNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

export function formatField(key: string, value: AnalyticsValue | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "worker") return machineLabel(value as string | number);
  if (key === "errorReason" && typeof value === "string") return readableError(value);
  const kind = fieldKind(key, value);

  switch (kind) {
    case "bool":
      return value ? "Yes" : "No";
    case "session":
      return `#${value}`;
    case "id":
      return String(value);
    case "date": {
      if (typeof value === "number") {
        return when(new Date(value).toISOString());
      }
      return when(String(value));
    }
    case "ms":
      return typeof value === "number" ? durationFormat(value) : String(value);
    case "usd":
      return typeof value === "number" ? usd(value) : String(value);
    case "percent":
      return typeof value === "number" ? pct(value) : String(value);
    case "bytes":
      return typeof value === "number" ? formatBytes(value) : String(value);
    case "tokens":
    case "number":
      return typeof value === "number" ? compact(value) : String(value);
    case "text":
    default: {
      const s = String(value);
      return s in VALUE_LABELS ? VALUE_LABELS[s] : s;
    }
  }
}
