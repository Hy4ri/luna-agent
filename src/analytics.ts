import type { Models, Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { context } from "./luna.js";
import { isRunning, readSessionStatus, type SessionStatus } from "./session-status.js";
import { newestMessageTime, SessionCreated } from "./session-activity.js";
import { ExecTarget } from "./workers.js";
import { conversationStorage } from "./conversation-storage.js";
import { Children } from "./delegate.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
const counters = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const costCounters = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const subsets = ["reasoning", "cacheWrite1h"] as const;
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
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function empty(): AnalyticsMetrics {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: null, cacheWrite1h: null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheHitRate: null };
}
function add(target: AnalyticsMetrics, usage: Partial<Usage>) {
  for (const key of counters) if (valid(usage[key])) target[key] += usage[key];
  for (const key of subsets) if (valid(usage[key])) target[key] = (target[key] ?? 0) + usage[key];
  for (const key of costCounters) if (valid(usage.cost?.[key])) target.cost[key] += usage.cost[key];
  const denominator = target.input + target.cacheRead + target.cacheWrite;
  target.cacheHitRate = denominator ? target.cacheRead / denominator : null;
}

/** Storage-derived input of one conversation. Only its own entries count, so fork parents never change it. */
interface ConversationPart {
  ledger: { models: [string, Partial<Usage>][]; tools: [string, Partial<Usage>][] };
  responses: { key: string; stopReason?: string; timestamp: unknown; usage?: Usage }[];
  userTurns: number;
  assistantTurns: number;
  toolCalls: [string, number][];
  toolErrors: [string, number][];
  totalToolCalls: number;
  totalToolErrors: number;
  skillCounts: [string, number][];
  skillLastUsed: [string, number][];
}
/** Per-conversation cache. Each commit drops the parts of the conversations it touched. */
export interface AnalyticsCache { parts: Map<string, ConversationPart>; generations: Map<string, number>; epoch: number }
/** Returns undefined when commits cannot be observed: a cache without invalidation would serve stale data. */
export function createAnalyticsCache(harness: Harness): AnalyticsCache | undefined {
  const cache: AnalyticsCache = { parts: new Map(), generations: new Map(), epoch: 0 };
  try { harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      const id = change.type === "conversation" ? change.value.id
        : change.type === "entry" || change.type === "task" || change.type === "submission" ? change.value.conversationId
        : change.conversationId;
      if (id === undefined) { cache.parts.clear(); cache.epoch++; continue; }
      const k = String(id); cache.parts.delete(k); cache.generations.set(k, (cache.generations.get(k) ?? 0) + 1);
    }
  }); } catch { return undefined; }
  return cache;
}

/** One consistent view of retained ledgers and their own dated response history.
 * Usage documents include undated compaction attempts. They must not be rebuilt from entries.
 * Fork scans include inherited entries; counting only their owning conversation prevents duplication.
 */
export async function readAnalytics(harness: Harness, models?: Models, cache?: AnalyticsCache) {
  return harness.commit(async tx => {
    const modelMap = new Map<string, AnalyticsModel>();
    const daily = new Map<string, Map<string, AnalyticsModel["daily"][number]>>();
    const toolMap = new Map<string, AnalyticsMetrics>();
    const totals = empty();
    const sessionRows: AnalyticsSession[] = [];
    const statusBreakdown: Record<string, number> = {};
    let metaDb: ReturnType<typeof conversationStorage>["db"] | undefined;
    try { metaDb = conversationStorage(harness).db; } catch { metaDb = undefined; }

    // Project mapping
    const projectLinks = new Map<number, number>();
    const projectNames = new Map<number, string>();
    projectNames.set(0, "General");
    if (metaDb) {
      try {
        const projRows = metaDb.prepare("SELECT id, name FROM luna_projects").all() as { id: number; name: string }[];
        for (const r of projRows) projectNames.set(r.id, r.name);
        const linkRows = metaDb.prepare("SELECT conversation_id, project_id FROM luna_session_projects").all() as { conversation_id: number; project_id: number }[];
        for (const r of linkRows) projectLinks.set(r.conversation_id, r.project_id);
      } catch {}
    }

    // Global aggregates
    const toolCallsGlobal = new Map<string, number>();
    const toolErrorsGlobal = new Map<string, number>();
    const skillGlobal = new Map<string, { invocations: number; sessions: Set<string>; lastUsed: number | null }>();
    const projectStatsMap = new Map<number, { usage: AnalyticsMetrics; sessions: number }>();
    const workerStatsMap = new Map<string, { worker: number | null; sessions: number; usage: AnalyticsMetrics }>();
    const dailyErrors = new Map<string, { responses: number; errors: number; aborted: number }>();
    const projectDailyMap = new Map<string, { date: string; projectId: number; projectName: string; responses: number; usage: AnalyticsMetrics }>();

    const getModel = (key: string) => {
      let row = modelMap.get(key);
      if (!row) {
        const slash = key.indexOf("/");
        const provider = slash < 0 ? key : key.slice(0, slash), model = slash < 0 ? "" : key.slice(slash + 1);
        const catalog = models?.getModel(provider, model);
        const rates = catalog?.cost;
        row = { key, provider, model, usage: empty(), sessions: 0, responses: 0, errors: 0, aborted: 0,
          firstSeen: null, lastSeen: null, rates: rates ? {
            input: valid(rates.input) ? rates.input : 0, output: valid(rates.output) ? rates.output : 0,
            cacheRead: valid(rates.cacheRead) ? rates.cacheRead : 0, cacheWrite: valid(rates.cacheWrite) ? rates.cacheWrite : 0,
          } : null, daily: [] };
        modelMap.set(key, row); daily.set(key, new Map());
      }
      return row;
    };
    const loadPart = async (id: ConversationId): Promise<ConversationPart> => {
      const usage = await tx.doc(UsageDoc, id);
      const part: ConversationPart = {
        ledger: JSON.parse(JSON.stringify({ models: Object.entries(usage.models), tools: Object.entries(usage.tools) })),
        responses: [],
        userTurns: 0,
        assistantTurns: 0,
        toolCalls: [],
        toolErrors: [],
        totalToolCalls: 0,
        totalToolErrors: 0,
        skillCounts: [],
        skillLastUsed: [],
      };
      const callMap = new Map<string, number>();
      const errMap = new Map<string, number>();
      const skillMap = new Map<string, number>();
      const skillLast = new Map<string, number>();
      let userTurns = 0, assistantTurns = 0;
      let cursor;
      do {
        const page = await tx.scanEntries({ conversationId: id, order: "ascending" }, 200, cursor);
        for (const entry of page.items) {
          if (entry.conversationId !== id) continue;
          for (const message of entry.model ?? []) {
            const role = (message as unknown as { role?: string }).role;
            if (role === "user") {
              userTurns++;
            } else if (role === "assistant") {
              assistantTurns++;
              const provider = (message as unknown as { provider?: string }).provider;
              const model = (message as unknown as { model?: string }).model;
              if (provider && model) {
                part.responses.push({ key: `${provider}/${model}`, stopReason: (message as unknown as { stopReason?: string }).stopReason, timestamp: (message as unknown as { timestamp?: unknown }).timestamp, usage: (message as unknown as { usage?: Usage }).usage });
              } else {
                // still count as response for turn metrics even without provider/model
                // push with unknown key to keep error/abort tracking consistent with ledger
                const k = provider || model ? `${provider ?? "unknown"}/${model ?? "unknown"}` : "unknown/unknown";
                // only push if we can identify; otherwise skip to avoid polluting model stats
                if (provider || model) part.responses.push({ key: k, stopReason: (message as unknown as { stopReason?: string }).stopReason, timestamp: (message as unknown as { timestamp?: unknown }).timestamp, usage: (message as unknown as { usage?: Usage }).usage });
              }
              const content = (message as unknown as { content?: unknown }).content;
              if (Array.isArray(content)) {
                for (const block of content as Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>) {
                  if (block?.type === "toolCall" && typeof block.name === "string") {
                    const name = block.name;
                    callMap.set(name, (callMap.get(name) ?? 0) + 1);
                    if (name === "skill_view" && block.arguments && typeof block.arguments.name === "string" && !block.arguments.file_path) {
                      const sname = block.arguments.name as string;
                      skillMap.set(sname, (skillMap.get(sname) ?? 0) + 1);
                      const ts = (message as unknown as { timestamp?: number }).timestamp;
                      const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
                      const prev = skillLast.get(sname) ?? 0;
                      if (t > prev) skillLast.set(sname, t);
                    }
                  }
                }
              }
            } else if (role === "toolResult") {
              const toolName = (message as unknown as { toolName?: string }).toolName;
              const isError = !!(message as unknown as { isError?: boolean }).isError;
              if (isError) {
                const key = toolName ?? "_unknown";
                errMap.set(key, (errMap.get(key) ?? 0) + 1);
              }
            }
          }
        }
        cursor = page.next;
      } while (cursor);
      part.userTurns = userTurns;
      part.assistantTurns = assistantTurns;
      part.totalToolCalls = [...callMap.values()].reduce((a, b) => a + b, 0);
      part.totalToolErrors = [...errMap.values()].reduce((a, b) => a + b, 0);
      part.toolCalls = [...callMap.entries()];
      part.toolErrors = [...errMap.entries()];
      part.skillCounts = [...skillMap.entries()];
      part.skillLastUsed = [...skillLast.entries()];
      return part;
    };

    // First collect conversation list and parent map
    let cursor, sessions = 0;
    const conversationList: { id: ConversationId; parent: unknown }[] = [];
    do {
      const page = await tx.scanConversations({ order: "ascending" }, 100, cursor);
      for (const conversation of page.items) { sessions++; conversationList.push({ id: conversation.id, parent: (conversation as unknown as { parent?: unknown }).parent ?? null }); }
      cursor = page.next;
    } while (cursor);

    // Build parent id map for fork depth
    const parentIdMap = new Map<string, string | null>();
    for (const c of conversationList) {
      const raw = c.parent as unknown;
      let pid: string | null = null;
      if (raw != null) {
        if (typeof raw === "number" || typeof raw === "string") pid = String(raw);
        else if (typeof raw === "object") {
          const o = raw as Record<string, unknown>;
          const cand = o.id ?? o.conversationId ?? o.conversation_id ?? (o as { parent?: unknown }).parent;
          if (cand != null) pid = String(cand);
          else if (typeof (o as { at?: unknown }).at === "number") {
            // parent is { at: number, id? } - try to find id in map via at? Not reliable; leave null
            pid = null;
          }
        }
      }
      parentIdMap.set(String(c.id), pid);
    }
    const forkDepthOf = (id: string): number => {
      let depth = 0, cur: string | null = parentIdMap.get(id) ?? null;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        depth++;
        cur = parentIdMap.get(cur) ?? null;
        if (depth > 20) break;
      }
      return depth;
    };

    const readConversation = async (id: ConversationId, parent: unknown) => {
      const k = String(id);
      let part = cache?.parts.get(k);
      if (!part) {
        const gen = cache?.generations.get(k) ?? 0, at = cache?.epoch;
        part = await loadPart(id);
        if (cache && (cache.generations.get(k) ?? 0) === gen && cache.epoch === at) cache.parts.set(k, part);
      }
      for (const [key, metrics] of part.ledger.models) {
        const row = getModel(key); row.sessions++;
        add(row.usage, metrics); add(totals, metrics);
      }
      for (const [name, metrics] of part.ledger.tools) {
        let total = toolMap.get(name);
        if (!total) { total = empty(); toolMap.set(name, total); }
        add(total, metrics);
      }
      // global tool call / error aggregation
      for (const [name, cnt] of part.toolCalls) toolCallsGlobal.set(name, (toolCallsGlobal.get(name) ?? 0) + cnt);
      for (const [name, cnt] of part.toolErrors) toolErrorsGlobal.set(name, (toolErrorsGlobal.get(name) ?? 0) + cnt);
      for (const [sname, cnt] of part.skillCounts) {
        let entry = skillGlobal.get(sname);
        if (!entry) { entry = { invocations: 0, sessions: new Set<string>(), lastUsed: null }; skillGlobal.set(sname, entry); }
        entry.invocations += cnt;
        entry.sessions.add(k);
        const last = part.skillLastUsed.find(([n]) => n === sname)?.[1] ?? null;
        if (last != null && (entry.lastUsed == null || last > entry.lastUsed)) entry.lastUsed = last;
      }

      for (const message of part.responses) {
        const row = getModel(message.key);
        row.responses++;
        if (message.stopReason === "error") row.errors++;
        if (message.stopReason === "aborted") row.aborted++;
        const timestamp = message.timestamp;
        if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
        const date = new Date(timestamp);
        if (!Number.isFinite(date.getTime())) continue;
        const iso = date.toISOString();
        if (row.firstSeen === null || iso < row.firstSeen) row.firstSeen = iso;
        if (row.lastSeen === null || iso > row.lastSeen) row.lastSeen = iso;
        const dateKey = iso.slice(0, 10), dates = daily.get(row.key)!;
        let bucket = dates.get(dateKey);
        if (!bucket) { bucket = { date: dateKey, responses: 0, usage: empty() }; dates.set(dateKey, bucket); }
        bucket.responses++;
        if (message.usage) add(bucket.usage, message.usage);
        // global daily errors
        let dErr = dailyErrors.get(dateKey);
        if (!dErr) { dErr = { responses: 0, errors: 0, aborted: 0 }; dailyErrors.set(dateKey, dErr); }
        dErr.responses++;
        if (message.stopReason === "error") dErr.errors++;
        if (message.stopReason === "aborted") dErr.aborted++;
        // project daily
        const pid = projectLinks.get(Number(id)) ?? 0;
        const pname = projectNames.get(pid) ?? "General";
        const pdKey = `${pid}|${dateKey}`;
        let pd = projectDailyMap.get(pdKey);
        if (!pd) { pd = { date: dateKey, projectId: pid, projectName: pname, responses: 0, usage: empty() }; projectDailyMap.set(pdKey, pd); }
        pd.responses++;
        if (message.usage) add(pd.usage, message.usage);
      }
      // Per-session rollup
      const sessionUsage = empty();
      for (const [, metrics] of part.ledger.models) add(sessionUsage, metrics);
      let sessResponses = 0, sessErrors = 0, sessAborted = 0;
      for (const m of part.responses) { sessResponses++; if (m.stopReason === "error") sessErrors++; if (m.stopReason === "aborted") sessAborted++; }
      const sessModels = [...new Set(part.ledger.models.map(([k]) => k))].sort();
      // Session status/meta
      let status: SessionStatus = "ready", statusReason: string | null = null;
      let lastActivity: string | null = null, createdAt: string | null = null, worker: number | null = null;
      let lastTs: number | null = null, createdTs: number | null = null;
      try {
        const running = await isRunning(tx, id);
        const s = await readSessionStatus(tx, id, running);
        status = s.status; statusReason = s.statusReason;
        const ts = await newestMessageTime(tx, id);
        if (ts !== null) { lastTs = ts; lastActivity = new Date(ts).toISOString(); }
        const createdRaw: unknown = (await tx.doc(SessionCreated, id)).at;
        if (typeof createdRaw === "number" && Number.isFinite(createdRaw)) { createdTs = createdRaw; createdAt = new Date(createdRaw).toISOString(); }
        try {
          const target = await (tx.doc as unknown as (doc: unknown, id: ConversationId) => Promise<{ worker: number | null }>)(ExecTarget as unknown as never, id).catch(() => null);
          if (target && typeof (target as { worker: unknown }).worker !== "undefined") worker = (target as { worker: number | null }).worker ?? null;
        } catch {}
      } catch {}
      // subagent count
      let subagentCount = 0;
      try {
        const children = await tx.doc(Children, id);
        subagentCount = Array.isArray((children as { children?: unknown[] }).children) ? (children as { children: unknown[] }).children.length : 0;
      } catch {}
      const forkDepth = forkDepthOf(k);
      let durationMs: number | null = null;
      if (lastTs != null && createdTs != null) durationMs = Math.max(0, lastTs - createdTs);
      const totalTurns = part.userTurns + part.assistantTurns;
      const avgTokensPerTurn = totalTurns ? sessionUsage.totalTokens / totalTurns : null;
      // Title/meta from sqlite if available
      let title: string | null = null, archived = false, pinned = false;
      if (metaDb) {
        try {
          const row = metaDb.prepare("SELECT title, archived, pinned FROM luna_conversations WHERE id=?").get(Number(id)) as { title?: string | null; archived?: number; pinned?: number } | undefined;
          if (row) { title = row.title ?? null; archived = !!row.archived; pinned = !!row.pinned; }
        } catch {}
        if (!title) {
          try {
            const first = (await tx.scanEntries({ conversationId: id, order: "ascending" }, 30)).items.find(e => e.kind === "pi.user");
            const txt = (first as unknown as { model?: Array<{ content?: unknown }> })?.model?.[0]?.content ?? "";
            const t = typeof txt === "string" ? txt : Array.isArray(txt) ? (txt as Array<{ text?: string }>).map((b) => b.text || "").join(" ") : "";
            title = t.replace(/\s+/g, " ").slice(0, 60) || null;
          } catch {}
        }
      }
      statusBreakdown[status] = (statusBreakdown[status] ?? 0) + 1;
      const pid = projectLinks.get(Number(id)) ?? 0;
      const pname = projectNames.get(pid) ?? null;
      // project stats accumulation
      let ps = projectStatsMap.get(pid);
      if (!ps) { ps = { usage: empty(), sessions: 0 }; projectStatsMap.set(pid, ps); }
      ps.sessions++;
      add(ps.usage, sessionUsage as unknown as Partial<Usage>);
      // worker stats
      const wKey = worker == null ? "main" : String(worker);
      let ws = workerStatsMap.get(wKey);
      if (!ws) { ws = { worker, sessions: 0, usage: empty() }; workerStatsMap.set(wKey, ws); }
      ws.sessions++;
      add(ws.usage, sessionUsage as unknown as Partial<Usage>);

      sessionRows.push({
        id: String(id), title, archived, pinned, parent: parent ?? null,
        status, statusReason, lastActivity, createdAt, worker,
        usage: sessionUsage, responses: sessResponses, errors: sessErrors, aborted: sessAborted, models: sessModels,
        turns: { user: part.userTurns, assistant: part.assistantTurns },
        durationMs,
        subagentCount,
        forkDepth,
        toolCalls: part.totalToolCalls,
        toolErrors: part.totalToolErrors,
        skills: part.skillCounts.map(([n]) => n),
        avgTokensPerTurn,
        projectId: pid,
        projectName: pname,
      });
    };
    for (const c of conversationList) await readConversation(c.id, c.parent);
    // Most recent activity first
    sessionRows.sort((a, b) => (b.lastActivity ?? b.createdAt ?? "").localeCompare(a.lastActivity ?? a.createdAt ?? "") || Number(b.id) - Number(a.id));
    for (const row of modelMap.values()) row.daily = [...daily.get(row.key)!.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Build derived aggregates
    const toolsDetailed: AnalyticsToolDetailed[] = [...toolMap.entries()].map(([name, usage]) => {
      const calls = toolCallsGlobal.get(name) ?? 0;
      const errors = toolErrorsGlobal.get(name) ?? 0;
      return { name, calls, errors, errorRate: calls ? errors / calls : null, usage };
    }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    // include tools that were called but have no ledger usage (e.g., pure read without token reporting)
    for (const [name, calls] of toolCallsGlobal.entries()) {
      if (!toolMap.has(name)) {
        const errors = toolErrorsGlobal.get(name) ?? 0;
        toolsDetailed.push({ name, calls, errors, errorRate: calls ? errors / calls : null, usage: empty() });
      }
    }
    toolsDetailed.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

    const skills: AnalyticsSkill[] = [...skillGlobal.entries()].map(([name, v]) => ({
      name, invocations: v.invocations, sessions: v.sessions.size, lastUsed: v.lastUsed ? new Date(v.lastUsed).toISOString() : null,
    })).sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name));

    const projects: AnalyticsProject[] = [...projectStatsMap.entries()].map(([id, v]) => ({
      id, name: projectNames.get(id) ?? String(id), sessions: v.sessions, usage: v.usage,
    })).sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);

    const workers: AnalyticsWorker[] = [...workerStatsMap.values()].map(v => ({
      worker: v.worker, sessions: v.sessions, usage: v.usage, label: v.worker == null ? "main" : `worker #${v.worker}`,
    })).sort((a, b) => (a.worker ?? -1) - (b.worker ?? -1));

    const reliability = {
      byModel: [...modelMap.values()].map(m => ({
        key: m.key, provider: m.provider, model: m.model, responses: m.responses, errors: m.errors, aborted: m.aborted,
        errorRate: m.responses ? m.errors / m.responses : null, abortRate: m.responses ? m.aborted / m.responses : null,
      })).sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0)),
      dailyErrors: [...dailyErrors.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    };

    const projectDaily = [...projectDailyMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.projectId - b.projectId);

    // Content actions: derived from toolCallsGlobal
    const contentActions = {
      reads: toolCallsGlobal.get("read") ?? 0,
      writes: toolCallsGlobal.get("write") ?? 0,
      edits: toolCallsGlobal.get("edit") ?? 0,
      bashes: toolCallsGlobal.get("bash") ?? 0,
      boards: toolCallsGlobal.get("board") ?? 0,
    };

    return {
      generatedAt: new Date().toISOString(),
      scope: "All retained conversations, including archived sessions and subagents. Deleted conversations are excluded. Fork history is counted only at its original owner.",
      totals, sessions,
      models: [...modelMap.values()].sort((a, b) => a.key.localeCompare(b.key)),
      tools: [...toolMap].sort(([a], [b]) => a.localeCompare(b)).map(([name, usage]) => ({ name, usage })),
      toolsDetailed,
      skills,
      projects,
      workers,
      reliability,
      projectDaily,
      contentActions,
      sessionsList: sessionRows,
      statusBreakdown,
      notes: [
        "Model totals come from recorded usage ledgers and include compaction attempts. They survive context reset and compaction.",
        "Costs are recorded USD estimates, not invoices or subscription charges. Current catalog rates do not recalculate historical costs.",
        "Zero cost can mean unpriced usage, a subscription adapter, or a zero rate. It does not prove usage was free.",
        "Uncached input is not proof of a cache miss. Providers do not report a separate cache-miss counter.",
        "Reasoning tokens are part of output. One-hour cache writes are part of cache writes. Optional counters sum reported values only.",
        "Daily charts and response counts use retained assistant messages. Undated compaction attempts are excluded, so chart sums can differ from ledger totals.",
        "Tool-reported usage is shown separately and is not added to model totals because it can overlap.",
        "Per-session status is live. Filter and sort the sessions table to find active, failed, or waiting sessions.",
        "Tool calls and skill invocations are counted from retained entries. Fork parents do not duplicate child tool history.",
        "Project and worker breakdowns use luna_session_projects and ExecTarget. General holds sessions without a project.",
      ],
    };
  }, context);
}
