// Legacy response shapes. Requests are served by analytics/compatibility.ts from the persistent store.
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionStatus } from "./session-status.js";

export interface AnalyticsMetrics {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  reasoning: number | null; cacheWrite1h: number | null;
  cost: Usage["cost"];
  cacheHitRate: number | null;
}
export interface AnalyticsModel {
  key: string; provider: string; model: string; usage: AnalyticsMetrics;
  sessions: number; responses: number; errors: number; aborted: number;
  firstSeen: string | null; lastSeen: string | null;
  rates: Omit<Usage["cost"], "total"> | null;
  daily: { date: string; responses: number; usage: AnalyticsMetrics }[];
}
export interface AnalyticsToolDetailed {
  name: string; calls: number; errors: number; errorRate: number | null; usage: AnalyticsMetrics;
}
export interface AnalyticsSkill {
  name: string; invocations: number; sessions: number; lastUsed: string | null;
}
export interface AnalyticsProject {
  id: number; name: string; sessions: number; usage: AnalyticsMetrics;
}
export interface AnalyticsWorker {
  worker: number | null; sessions: number; usage: AnalyticsMetrics; label: string;
}
export interface AnalyticsSession {
  id: string;
  title: string | null;
  archived: boolean;
  pinned: boolean;
  parent: unknown;
  status: SessionStatus;
  statusReason: string | null;
  lastActivity: string | null;
  createdAt: string | null;
  worker: number | null;
  usage: AnalyticsMetrics;
  responses: number;
  errors: number;
  aborted: number;
  models: string[];
  // extended
  turns: { user: number; assistant: number };
  durationMs: number | null;
  subagentCount: number;
  forkDepth: number;
  toolCalls: number;
  toolErrors: number;
  skills: string[];
  avgTokensPerTurn: number | null;
  projectId: number;
  projectName: string | null;
}
