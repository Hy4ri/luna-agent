import type { Usage } from "@earendil-works/pi-ai";
import type { AnalyticsMetrics, AnalyticsModel, AnalyticsToolDetailed, AnalyticsSkill, AnalyticsProject, AnalyticsWorker, AnalyticsSession } from "../analytics.js";
import type { AnalyticsStore } from "./store.js";

const counters = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const costCounters = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const subsets = ["reasoning", "cacheWrite1h"] as const;

const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function empty(): AnalyticsMetrics {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    reasoning: null,
    cacheWrite1h: null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cacheHitRate: null,
  };
}

function add(target: AnalyticsMetrics, usage: Partial<Usage> | Partial<AnalyticsMetrics> | null | undefined): void {
  if (!usage) return;
  for (const key of counters) if (valid(usage[key])) target[key] += usage[key]!;
  for (const key of subsets) if (valid(usage[key])) target[key] = (target[key] ?? 0) + usage[key]!;
  const cost = usage.cost;
  if (cost) {
    for (const key of costCounters) if (valid(cost[key])) target.cost[key] += cost[key]!;
  }
  const denominator = target.input + target.cacheRead + target.cacheWrite;
  target.cacheHitRate = denominator ? target.cacheRead / denominator : null;
}

interface FactRow {
  session_id: number;
  kind: string;
  ts: number | null;
  name: string | null;
  model: string | null;
  duration_ms: number | null;
  error: number;
  aborted: number;
  usage: string | null;
}

export function legacyAnalyticsSnapshot(
  store: AnalyticsStore,
) {
  const started = performance.now();
  const timings = {
    scanMs: 0,
    aggregationMs: 0,
    metadataMs: 0,
    entriesScanned: 0,
    conversationsScanned: 0,
    cacheHits: 0,
  };

  // Only all-time active retained sessions default for old APIs (preserve excludeDeleted)
  const allSessions = store.sessions();
  const sessions = allSessions.filter((s) => s.deletedAt === null);

  const modelMap = new Map<string, AnalyticsModel>();
  const daily = new Map<string, Map<string, AnalyticsModel["daily"][number]>>();
  const toolMap = new Map<string, AnalyticsMetrics>();
  const totals = empty();

  const getModel = (key: string): AnalyticsModel => {
    let row = modelMap.get(key);
    if (!row) {
      const slash = key.indexOf("/");
      const provider = slash < 0 ? key : key.slice(0, slash);
      const model = slash < 0 ? "" : key.slice(slash + 1);
      row = {
        key,
        provider,
        model,
        usage: empty(),
        sessions: 0,
        responses: 0,
        errors: 0,
        aborted: 0,
        firstSeen: null,
        lastSeen: null,
        rates: null,
        daily: [],
      };
      modelMap.set(key, row);
      daily.set(key, new Map());
    }
    return row;
  };

  // Pre-load facts for retained sessions
  const factRows = store.db
    .query<FactRow, []>(
      `SELECT f.session_id, f.kind, f.ts, f.name, f.model, f.duration_ms, f.error, f.aborted, f.usage
       FROM analytics_facts f
       JOIN analytics_sessions s ON s.id = f.session_id
       WHERE s.deleted_at IS NULL`,
    )
    .all();

  const factsBySession = new Map<number, FactRow[]>();
  for (const f of factRows) {
    let list = factsBySession.get(f.session_id);
    if (!list) {
      list = [];
      factsBySession.set(f.session_id, list);
    }
    list.push(f);
  }

  const toolCallsGlobal = new Map<string, number>();
  const toolErrorsGlobal = new Map<string, number>();
  const skillGlobal = new Map<
    string,
    { invocations: number; sessions: Set<string>; lastUsed: number | null }
  >();
  const projectStatsMap = new Map<number, { usage: AnalyticsMetrics; sessions: number }>();
  const workerStatsMap = new Map<string, { worker: number | null; sessions: number; usage: AnalyticsMetrics }>();
  const dailyErrors = new Map<string, { responses: number; errors: number; aborted: number }>();
  const projectDailyMap = new Map<
    string,
    { date: string; projectId: number; projectName: string; responses: number; usage: AnalyticsMetrics }
  >();
  const projectNames = new Map<number, string>();
  const statusBreakdown: Record<string, number> = {};

  const sessionRows: AnalyticsSession[] = [];

  for (const session of sessions) {
    statusBreakdown[session.status] = (statusBreakdown[session.status] ?? 0) + 1;
    projectNames.set(session.projectId, session.projectName || (session.projectId === 0 ? "General" : String(session.projectId)));

    const sessFacts = factsBySession.get(session.id) ?? [];

    // Model ledgers: session.modelUsage, fallback to response facts usage if no modelUsage
    const sessionModelLedger = new Map<string, AnalyticsMetrics>();
    if (session.modelUsage && Object.keys(session.modelUsage).length > 0) {
      for (const [mKey, mMetrics] of Object.entries(session.modelUsage)) {
        let m = sessionModelLedger.get(mKey);
        if (!m) {
          m = empty();
          sessionModelLedger.set(mKey, m);
        }
        add(m, mMetrics);
      }
    } else {
      for (const f of sessFacts) {
        if (f.kind === "response" && f.model && f.usage) {
          try {
            const parsedUsage = JSON.parse(f.usage);
            let m = sessionModelLedger.get(f.model);
            if (!m) {
              m = empty();
              sessionModelLedger.set(f.model, m);
            }
            add(m, parsedUsage);
          } catch {}
        }
      }
    }

    // Tools ledgers from toolUsage
    if (session.toolUsage) {
      for (const [tKey, tMetrics] of Object.entries(session.toolUsage)) {
        let total = toolMap.get(tKey);
        if (!total) {
          total = empty();
          toolMap.set(tKey, total);
        }
        add(total, tMetrics);
      }
    }

    // Aggregate models into global modelMap & totals
    for (const [mKey, mUsage] of sessionModelLedger.entries()) {
      const row = getModel(mKey);
      row.sessions++;
      add(row.usage, mUsage);
      add(totals, mUsage);
    }

    // Build session usage
    const sessionUsage = empty();
    for (const mMetrics of sessionModelLedger.values()) {
      add(sessionUsage, mMetrics);
    }

    // Projects breakdown
    const pid = session.projectId;
    let ps = projectStatsMap.get(pid);
    if (!ps) {
      ps = { usage: empty(), sessions: 0 };
      projectStatsMap.set(pid, ps);
    }
    ps.sessions++;
    add(ps.usage, sessionUsage);

    // Workers breakdown
    const rawWorker = session.worker;
    const workerNum = rawWorker === "main" || rawWorker == null || rawWorker === "" ? null : Number(rawWorker);
    const wKey = workerNum == null ? "main" : String(workerNum);
    let ws = workerStatsMap.get(wKey);
    if (!ws) {
      ws = { worker: Number.isFinite(workerNum) ? workerNum : null, sessions: 0, usage: empty() };
      workerStatsMap.set(wKey, ws);
    }
    ws.sessions++;
    add(ws.usage, sessionUsage);

    // Aggregate session facts
    let sessResponses = 0;
    let sessErrors = 0;
    let sessAborted = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    const sessionSkills = new Set<string>();

    for (const f of sessFacts) {
      if (f.kind === "response") {
        sessResponses++;
        if (f.error) sessErrors++;
        if (f.aborted) sessAborted++;

        if (f.model) {
          const row = getModel(f.model);
          row.responses++;
          if (f.error) row.errors++;
          if (f.aborted) row.aborted++;

          const ts = f.ts;
          if (typeof ts === "number" && Number.isFinite(ts)) {
            const date = new Date(ts);
            if (Number.isFinite(date.getTime())) {
              const iso = date.toISOString();
              if (row.firstSeen === null || iso < row.firstSeen) row.firstSeen = iso;
              if (row.lastSeen === null || iso > row.lastSeen) row.lastSeen = iso;

              const dateKey = iso.slice(0, 10);
              const dates = daily.get(row.key)!;
              let bucket = dates.get(dateKey);
              if (!bucket) {
                bucket = { date: dateKey, responses: 0, usage: empty() };
                dates.set(dateKey, bucket);
              }
              bucket.responses++;
              if (f.usage) {
                try {
                  add(bucket.usage, JSON.parse(f.usage));
                } catch {}
              }

              let dErr = dailyErrors.get(dateKey);
              if (!dErr) {
                dErr = { responses: 0, errors: 0, aborted: 0 };
                dailyErrors.set(dateKey, dErr);
              }
              dErr.responses++;
              if (f.error) dErr.errors++;
              if (f.aborted) dErr.aborted++;

              const pname = projectNames.get(pid) ?? (pid === 0 ? "General" : String(pid));
              const pdKey = `${pid}|${dateKey}`;
              let pd = projectDailyMap.get(pdKey);
              if (!pd) {
                pd = { date: dateKey, projectId: pid, projectName: pname, responses: 0, usage: empty() };
                projectDailyMap.set(pdKey, pd);
              }
              pd.responses++;
              if (f.usage) {
                try {
                  add(pd.usage, JSON.parse(f.usage));
                } catch {}
              }
            }
          }
        }
      } else if (f.kind === "tool") {
        toolCalls++;
        if (f.error) toolErrors++;
        const toolName = f.name ?? "unknown";
        toolCallsGlobal.set(toolName, (toolCallsGlobal.get(toolName) ?? 0) + 1);
        if (f.error) {
          toolErrorsGlobal.set(toolName, (toolErrorsGlobal.get(toolName) ?? 0) + 1);
        }
      } else if (f.kind === "skill") {
        const skillName = f.name;
        if (skillName) {
          sessionSkills.add(skillName);
          let entry = skillGlobal.get(skillName);
          if (!entry) {
            entry = { invocations: 0, sessions: new Set<string>(), lastUsed: null };
            skillGlobal.set(skillName, entry);
          }
          entry.invocations++;
          entry.sessions.add(String(session.id));
          if (f.ts != null && (entry.lastUsed == null || f.ts > entry.lastUsed)) {
            entry.lastUsed = f.ts;
          }
        }
      }
    }

    const sessModels = [...sessionModelLedger.keys()].sort();
    let durationMs: number | null = null;
    if (session.lastActivity != null && session.createdAt != null) {
      durationMs = Math.max(0, session.lastActivity - session.createdAt);
    }
    const totalTurns = session.userTurns + session.assistantTurns;
    const avgTokensPerTurn = totalTurns ? sessionUsage.totalTokens / totalTurns : null;

    sessionRows.push({
      id: String(session.id),
      title: session.title,
      archived: session.archived,
      pinned: session.pinned,
      parent: session.parentId,
      status: session.status as AnalyticsSession["status"],
      statusReason: session.statusReason,
      lastActivity: session.lastActivity ? new Date(session.lastActivity).toISOString() : null,
      createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      worker: Number.isFinite(workerNum) ? workerNum : null,
      usage: sessionUsage,
      responses: sessResponses,
      errors: sessErrors,
      aborted: sessAborted,
      models: sessModels,
      turns: { user: session.userTurns, assistant: session.assistantTurns },
      durationMs,
      subagentCount: session.subagentCount,
      forkDepth: session.forkDepth,
      toolCalls,
      toolErrors,
      skills: [...sessionSkills].sort(),
      avgTokensPerTurn,
      projectId: session.projectId,
      projectName: session.projectName ?? null,
    });
  }

  // Phase 3: Global Aggregates outside commits
  sessionRows.sort(
    (a, b) =>
      (b.lastActivity ?? b.createdAt ?? "").localeCompare(a.lastActivity ?? a.createdAt ?? "") ||
      Number(b.id) - Number(a.id),
  );

  for (const row of modelMap.values()) {
    row.daily = [...daily.get(row.key)!.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  const toolsDetailed: AnalyticsToolDetailed[] = [...toolMap.entries()]
    .map(([name, usage]) => {
      const calls = toolCallsGlobal.get(name) ?? 0;
      const errors = toolErrorsGlobal.get(name) ?? 0;
      return { name, calls, errors, errorRate: calls ? errors / calls : null, usage };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  for (const [name, calls] of toolCallsGlobal.entries()) {
    if (!toolMap.has(name)) {
      const errors = toolErrorsGlobal.get(name) ?? 0;
      toolsDetailed.push({ name, calls, errors, errorRate: calls ? errors / calls : null, usage: empty() });
    }
  }
  toolsDetailed.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  const skills: AnalyticsSkill[] = [...skillGlobal.entries()]
    .map(([name, v]) => ({
      name,
      invocations: v.invocations,
      sessions: v.sessions.size,
      lastUsed: v.lastUsed ? new Date(v.lastUsed).toISOString() : null,
    }))
    .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name));

  const projects: AnalyticsProject[] = [...projectStatsMap.entries()]
    .map(([id, v]) => ({
      id,
      name: projectNames.get(id) ?? String(id),
      sessions: v.sessions,
      usage: v.usage,
    }))
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);

  const workers: AnalyticsWorker[] = [...workerStatsMap.values()]
    .map((v) => ({
      worker: v.worker,
      sessions: v.sessions,
      usage: v.usage,
      label: v.worker == null ? "main" : `worker #${v.worker}`,
    }))
    .sort((a, b) => (a.worker ?? -1) - (b.worker ?? -1));

  const reliability = {
    byModel: [...modelMap.values()]
      .map((m) => ({
        key: m.key,
        provider: m.provider,
        model: m.model,
        responses: m.responses,
        errors: m.errors,
        aborted: m.aborted,
        errorRate: m.responses ? m.errors / m.responses : null,
        abortRate: m.responses ? m.aborted / m.responses : null,
      }))
      .sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0)),
    dailyErrors: [...dailyErrors.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };

  const projectDaily = [...projectDailyMap.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.projectId - b.projectId,
  );

  const contentActions = {
    reads: toolCallsGlobal.get("read") ?? 0,
    writes: toolCallsGlobal.get("write") ?? 0,
    edits: toolCallsGlobal.get("edit") ?? 0,
    bashes: (toolCallsGlobal.get("bash") ?? 0) + (toolCallsGlobal.get("worker_exec") ?? 0),
    boards: toolCallsGlobal.get("board") ?? 0,
  };

  timings.aggregationMs = Math.max(0, performance.now() - started);

  return {
    performance: timings,
    generatedAt: new Date().toISOString(),
    scope:
      "All retained conversations, including archived sessions and subagents. Deleted conversations are excluded. Fork history is counted only at its original owner. Rendered via compatibility adapter.",
    totals,
    sessions: sessionRows.length,
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
      "Compatibility adapter snapshot served exclusively from persistent analytics db.",
      "Model totals come from recorded usage ledgers and include compaction attempts. They survive context reset and compaction.",
      "Costs are recorded USD estimates, not invoices or subscription charges. Current catalog rates do not recalculate historical costs.",
      "Zero cost can mean unpriced usage, a subscription adapter, or a zero rate. It does not prove usage was free.",
      "Uncached input is not proof of a cache miss. Providers do not report a separate cache-miss counter.",
      "Reasoning tokens are part of output. One-hour cache writes are part of cache writes. Optional counters sum reported values only.",
      "Daily charts and response counts use retained assistant messages. Undated compaction attempts are excluded, so chart sums can differ from ledger totals.",
      "Tool-reported usage is shown separately and is not added to model totals because it can overlap.",
      "Per-session status reflects the snapshot time. Refresh to update active, failed, or waiting sessions.",
      "Tool calls and skill invocations are counted from retained entries. Fork parents do not duplicate child tool history.",
      "Project and worker breakdowns use luna_session_projects and ExecTarget. General holds sessions without a project.",
      "Analytics uses an eventually consistent multi-read snapshot across conversations to avoid monopolizing the mutation queue.",
    ],
  };
}
