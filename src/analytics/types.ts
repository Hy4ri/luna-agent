import type { AnalyticsMetrics } from "../analytics.js";

export const ANALYTICS_TABS = ["overview", "models", "tools", "sessions", "delegation", "reliability", "speed", "context", "workflow", "projects"] as const;
export type AnalyticsTab = typeof ANALYTICS_TABS[number];
export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsRow = Record<string, AnalyticsValue>;
export interface AnalyticsFilters {
  from?: number; to?: number; project: number[]; model: string[]; provider: string[];
  worker: string[]; cwd: string[]; includeDeleted: boolean; compare: boolean;
  sort?: string; page: number; limit: number; search: string; source?: "direct" | "codemode";
}
export interface AnalyticsSessionRecord {
  id: number; title: string | null; parentId: number | null; projectId: number; projectName: string;
  worker: string; cwd: string | null; createdAt: number | null; lastActivity: number | null;
  status: string; statusReason: string | null; archived: boolean; pinned: boolean; deletedAt: number | null;
  lastEntryId: number; revision: string; userTurns: number; assistantTurns: number; subagentCount: number; forkDepth: number;
  usage: AnalyticsMetrics;
  /** Complete recorded per-model/tool ledgers, including usage without response timestamps. */
  uploadIds?: string[];
  modelUsage?: Record<string, AnalyticsMetrics>;
  toolUsage?: Record<string, AnalyticsMetrics>;
  /** Latest document counters only, not historical completion or duration claims. */
  workflow: { goals: number; completedGoals: number; todos: number; completedTodos: number; visionCalls: number; uploads: number; uploadBytes: number };
}
export type AnalyticsFactKind = "response" | "tool" | "turn" | "skill" | "compaction" | "system" | "model_switch" | "undo" | "message" | "delegation" | "wait" | "quota_wait" | "upload" | "vision";
export interface AnalyticsFact {
  /** Stable unique identity; replaying an entry must replace, never duplicate. */
  key: string; sessionId: number; kind: AnalyticsFactKind; ts: number | null;
  name: string | null; model: string | null; source: "direct" | "codemode" | null;
  durationMs: number | null; error: boolean; aborted: boolean;
  /** Only aggregate metadata: no transcript, tool arguments, file content, or raw tool result. */
  data: Record<string, AnalyticsValue>;
  usage: Partial<AnalyticsMetrics> | null;
}
export interface AnalyticsScan {
  session: AnalyticsSessionRecord; facts: AnalyticsFact[];
  /** A structural edit forces replacement of all stored facts; ordinary append upserts only new facts. */
  rebuild: boolean; entriesScanned: number;
}
export interface AnalyticsQueryResult {
  generatedAt: string; tab: AnalyticsTab; filters: AnalyticsFilters;
  summary: AnalyticsRow;
  series: { name: string; points: { x: string; y: number }[] }[];
  table: { columns: { key: string; label: string; format?: "number" | "usd" | "ms" | "percent" | "date" }[]; rows: AnalyticsRow[]; total: number; page: number; limit: number };
  previous?: AnalyticsRow;
  sections?: { title: string; table: AnalyticsQueryResult["table"] }[];
  notes: string[];
  performance: { queryMs: number; sessionsScanned: number; entriesScanned: number; indexedAt: string | null };
}
export interface AnalyticsFilterOptions {
  projects: { value: string; label: string }[]; models: { value: string; label: string }[];
  providers: { value: string; label: string }[]; workers: { value: string; label: string }[];
  cwds: { value: string; label: string }[];
}
