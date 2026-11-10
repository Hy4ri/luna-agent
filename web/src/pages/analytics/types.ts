import type { SessionStatus } from "@/lib/types"

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface ModelUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  reasoning: number | null
  cacheWrite1h: number | null
  cacheHitRate: number | null
  cost: UsageCost
  [key: string]: any
}

export interface DailyItem {
  date: string
  responses: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  [key: string]: any
}

export interface ModelItem {
  key: string
  provider: string
  model: string
  responses: number
  errors: number
  aborted: number
  sessions: number
  firstSeen: string | null
  lastSeen: string | null
  rates: UsageCost | null
  usage: ModelUsage
  daily: { date: string; responses: number; usage: ModelUsage }[]
}

export interface ToolItem {
  name: string
  usage: ModelUsage
}

export interface ToolDetailed {
  name: string
  calls: number
  errors: number
  errorRate: number | null
  usage: ModelUsage
}

export interface SkillRow {
  name: string
  invocations: number
  sessions: number
  lastUsed: string | null
}

export interface ProjectRow {
  id: number
  name: string
  sessions: number
  usage: ModelUsage
}

export interface WorkerRow {
  worker: number | null
  sessions: number
  usage: ModelUsage
  label: string
}

export interface AnalyticsSession {
  id: string
  title: string | null
  archived: boolean
  pinned: boolean
  parent: unknown
  status: SessionStatus
  statusReason: string | null
  lastActivity: string | null
  createdAt: string | null
  worker: number | null
  usage: ModelUsage
  responses: number
  errors: number
  aborted: number
  models: string[]
  turns: { user: number; assistant: number }
  durationMs: number | null
  subagentCount: number
  forkDepth: number
  toolCalls: number
  toolErrors: number
  skills: string[]
  avgTokensPerTurn: number | null
  projectId: number
  projectName: string | null
}

export interface AnalyticsSnapshot {
  generatedAt: string
  scope: string
  totals: ModelUsage
  sessions: number
  models: ModelItem[]
  tools: ToolItem[]
  toolsDetailed?: ToolDetailed[]
  skills?: SkillRow[]
  projects?: ProjectRow[]
  workers?: WorkerRow[]
  reliability?: {
    byModel: {
      key: string
      provider: string
      model: string
      responses: number
      errors: number
      aborted: number
      errorRate: number | null
      abortRate: number | null
    }[]
    dailyErrors: { date: string; responses: number; errors: number; aborted: number }[]
  }
  projectDaily?: { date: string; projectId: number; projectName: string; responses: number; usage: ModelUsage }[]
  contentActions?: { reads: number; writes: number; edits: number; bashes: number; boards: number }
  sessionsList?: AnalyticsSession[]
  statusBreakdown?: Record<string, number>
  notes: string[]
}
