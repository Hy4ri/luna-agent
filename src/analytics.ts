import type { Models, Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId, type EntryId } from "@earendil-works/pi-durable";
import { setImmediate } from "node:timers/promises";
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
// Metrics start empty, so the first priced part sets the provenance and later parts can only lower it.
const priced = new WeakSet<object>();
function add(target: AnalyticsMetrics, usage: Partial<Usage>) {
  if (valid(usage.cost?.total)) {
    const reported = usage.cost.totalFromProvider === true;
    target.cost.totalFromProvider = priced.has(target) ? target.cost.totalFromProvider === true && reported : reported;
    priced.add(target);
  }
  for (const key of counters) if (valid(usage[key])) target[key] += usage[key];
  for (const key of subsets) if (valid(usage[key])) target[key] = (target[key] ?? 0) + usage[key];
  for (const key of costCounters) if (valid(usage.cost?.[key])) target.cost[key] += usage.cost[key];
  const denominator = target.input + target.cacheRead + target.cacheWrite;
  target.cacheHitRate = denominator ? target.cacheRead / denominator : null;
}

/** Storage-derived input of one conversation. Only its own entries count, so fork parents never change it. */
interface ConversationPart {
  generation: number;
  lastEntryId?: EntryId;
  fallbackTitle?: string | null;
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
/** Keep append-only history summaries; generations independently refresh usage ledgers. */
export interface AnalyticsCache { parts: Map<string, ConversationPart>; generations: Map<string, number>; epoch: number }
/** Returns undefined when commits cannot be observed: a cache without invalidation would serve stale data. */
export function createAnalyticsCache(harness: Harness): AnalyticsCache | undefined {
  const cache: AnalyticsCache = { parts: new Map(), generations: new Map(), epoch: 0 };
  try {
    const observation = harness.observeCommits({
      advance(publication) {
        for (const change of publication.changes) {
          const id = change.type === "conversation" ? change.value.id
            : change.type === "entry" || change.type === "task" || change.type === "submission" ? change.value.conversationId
            : change.conversationId;
          if (id === undefined) { cache.parts.clear(); cache.epoch++; continue; }
          const k = String(id);
          // Structural changes and retired documents take the conservative rebuild path.
          if (change.type === "conversation" || (change.type === "document" && change.kind === "retire") ||
              (change.type === "entry" && (change.value.head !== undefined || change.value.edits !== undefined))) cache.parts.delete(k);
          cache.generations.set(k, (cache.generations.get(k) ?? 0) + 1);
        }
      },
      end() {
        cache.parts.clear();
        cache.generations.clear();
        cache.epoch++;
      },
    });
    void observation;
  } catch { return undefined; }
  return cache;
}

/** One in-flight computation per daemon, with short-lived completed snapshot reuse. */
export function createAnalyticsReader(harness: Harness, models?: Models) {
  const parts = createAnalyticsCache(harness);
  let snapshot: Awaited<ReturnType<typeof readAnalytics>> | undefined;
  let expiresAt = 0;
  let pending: Promise<Awaited<ReturnType<typeof readAnalytics>>> | undefined;
  return (force = false) => {
    if (pending) return pending;
    if (!force && snapshot && Date.now() < expiresAt) return Promise.resolve(snapshot);
    pending = readAnalytics(harness, models, parts).then(next => {
      snapshot = next;
      expiresAt = Date.now() + 15_000;
      return next;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

interface ConversationSessionData {
  status: SessionStatus;
  statusReason: string | null;
  lastActivity: string | null;
  createdAt: string | null;
  worker: number | null;
  lastTs: number | null;
  createdTs: number | null;
  subagentCount: number;
}

/** Reads retained ledgers and dated response history across conversations.
 * Work is split across bounded per-conversation commits so analytics does not hold
 * the global mutation queue. The returned snapshot represents an eventually consistent view.
 */
export async function readAnalytics(harness: Harness, models?: Models, cache?: AnalyticsCache) {
  const started = performance.now();
  const timings = { scanMs: 0, aggregationMs: 0, metadataMs: 0, entriesScanned: 0, conversationsScanned: 0, cacheHits: 0 };
  const modelMap = new Map<string, AnalyticsModel>();
  const daily = new Map<string, Map<string, AnalyticsModel["daily"][number]>>();
  const toolMap = new Map<string, AnalyticsMetrics>();
  const totals = empty();
  const sessionRows: AnalyticsSession[] = [];
  const statusBreakdown: Record<string, number> = {};
  let metaDb: ReturnType<typeof conversationStorage>["db"] | undefined;
  try { metaDb = conversationStorage(harness).db; } catch { metaDb = undefined; }

  const metadataStarted = performance.now();
  const conversationMeta = new Map<number, { title: string | null; archived: number; pinned: number }>();
  if (metaDb) {
    try {
      const rows = metaDb.prepare("SELECT id, title, archived, pinned FROM luna_conversations").all() as
        { id: number; title: string | null; archived: number; pinned: number }[];
      for (const row of rows) conversationMeta.set(row.id, row);
    } catch {}
  }

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

  timings.metadataMs = performance.now() - metadataStarted;

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

  // Phase 1: Read conversation list and parent relations in one initial commit
  const conversationList: { id: ConversationId; parent: unknown }[] = [];
  await harness.commit(async tx => {
    let cursor;
    do {
      const page = await tx.scanConversations({ order: "ascending" }, 100, cursor);
      for (const conversation of page.items) {
        conversationList.push({ id: conversation.id, parent: (conversation as unknown as { parent?: unknown }).parent ?? null });
      }
      cursor = page.next;
    } while (cursor);
  }, context);
  // Count sessions actually read; deletion can occur between commits.

  // Purges can run through raw SQL and have no conversation publication.
  if (cache) {
    const retained = new Set(conversationList.map(c => String(c.id)));
    for (const id of cache.parts.keys()) if (!retained.has(id)) cache.parts.delete(id);
    for (const id of cache.generations.keys()) if (!retained.has(id)) cache.generations.delete(id);
  }

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

  const readCachedSession = async (tx: Parameters<Parameters<Harness["commit"]>[0]>[0], id: ConversationId): Promise<ConversationSessionData | undefined> => {
    let sStatus: SessionStatus = "ready", sStatusReason: string | null = null;
    let sLastActivity: string | null = null, sCreatedAt: string | null = null, sWorker: number | null = null;
    let sLastTs: number | null = null, sCreatedTs: number | null = null;
    try {
      const running = await isRunning(tx, id);
      const s = await readSessionStatus(tx, id, running);
      sStatus = s.status; sStatusReason = s.statusReason;
      const ts = await newestMessageTime(tx, id);
      if (ts !== null) { sLastTs = ts; sLastActivity = new Date(ts).toISOString(); }
      const createdRaw: unknown = (await tx.doc(SessionCreated, id)).at;
      if (typeof createdRaw === "number" && Number.isFinite(createdRaw)) { sCreatedTs = createdRaw; sCreatedAt = new Date(createdRaw).toISOString(); }
      try {
        const target = await (tx.doc as unknown as (doc: unknown, id: ConversationId) => Promise<{ worker: number | null }>)(ExecTarget as unknown as never, id).catch(() => null);
        if (target && typeof (target as { worker: unknown }).worker !== "undefined") sWorker = (target as { worker: number | null }).worker ?? null;
      } catch {}
    } catch {}
    let sSubagentCount = 0;
    try {
      const children = await tx.doc(Children, id);
      sSubagentCount = Array.isArray((children as { children?: unknown[] }).children) ? (children as { children: unknown[] }).children.length : 0;
    } catch {}
    return {
      status: sStatus, statusReason: sStatusReason, lastActivity: sLastActivity,
      createdAt: sCreatedAt, worker: sWorker, lastTs: sLastTs, createdTs: sCreatedTs,
      subagentCount: sSubagentCount,
    };
  };
  // Session status for cache-valid conversations is read in small batches: one commit per
  // conversation dominated the warm path. Batches stay bounded so the mutation queue is released often.
  const prefetched = new Map<string, ConversationSessionData | undefined>();
  if (cache) {
    const ready = conversationList.filter(c => {
      const k = String(c.id), part = cache.parts.get(k);
      return part && part.generation === (cache.generations.get(k) ?? 0)
        && (!!conversationMeta.get(Number(c.id))?.title || part.fallbackTitle !== undefined);
    });
    for (let i = 0; i < ready.length; i += 20) {
      const batch = ready.slice(i, i + 20);
      const rows = await harness.commit(async tx => {
        const out: [string, ConversationSessionData | undefined][] = [];
        for (const c of batch) out.push([String(c.id), (await tx.conversation(c.id)) ? await readCachedSession(tx, c.id) : undefined]);
        return out;
      }, context);
      for (const [k, v] of rows) prefetched.set(k, v);
      await setImmediate();
    }
  }

  // Phase 2: Per-conversation reads with independent commits
  let lastYield = performance.now();
  for (const c of conversationList) {
    if (performance.now() - lastYield >= 20) {
      await setImmediate();
      lastYield = performance.now();
    }
    const id = c.id;
    const parent = c.parent;
    const k = String(id);
    let part = cache?.parts.get(k);

    const neededPart = !part || part.generation !== (cache?.generations.get(k) ?? 0);
    const needFallbackTitle = !conversationMeta.get(Number(id))?.title && (part?.fallbackTitle === undefined);

    let sessionData: ConversationSessionData;
    if (neededPart || needFallbackTitle) {
      const genBefore = cache?.generations.get(k) ?? 0;
      const epochBefore = cache?.epoch ?? 0;
      if (!neededPart) timings.cacheHits++;
      const res = await harness.commit(async tx => {
        if (!(await tx.conversation(id))) return undefined;
        let loadedPart: ConversationPart | undefined;
        if (neededPart) {
          const scanStarted = performance.now();
          timings.conversationsScanned++;
          let prev = part;
          if (prev?.lastEntryId && !(await tx.entry(prev.lastEntryId))) prev = undefined;
          const usage = await tx.doc(UsageDoc, id);
          loadedPart = {
            generation: genBefore,
            lastEntryId: prev?.lastEntryId,
            fallbackTitle: prev?.fallbackTitle ?? undefined,
            ledger: JSON.parse(JSON.stringify({ models: Object.entries(usage.models), tools: Object.entries(usage.tools) })),
            responses: prev ? prev.responses.slice() : [],
            userTurns: 0,
            assistantTurns: 0,
            toolCalls: [],
            toolErrors: [],
            totalToolCalls: 0,
            totalToolErrors: 0,
            skillCounts: [],
            skillLastUsed: [],
          };
          const callMap = new Map<string, number>(prev?.toolCalls);
          const errMap = new Map<string, number>(prev?.toolErrors);
          const skillMap = new Map<string, number>(prev?.skillCounts);
          const skillLast = new Map<string, number>(prev?.skillLastUsed);
          let userTurns = prev?.userTurns ?? 0, assistantTurns = prev?.assistantTurns ?? 0;
          let cursor;
          let pageYieldAt = performance.now();
          do {
            if (performance.now() - pageYieldAt >= 20) {
              await setImmediate();
              pageYieldAt = performance.now();
            }
            const page = await tx.scanEntries({ conversationId: id, minEntryId: prev?.lastEntryId, order: "ascending" }, 200, cursor);
            for (const entry of page.items) {
              timings.entriesScanned++;
              if (prev?.lastEntryId !== undefined && entry.id <= prev.lastEntryId) continue;
              loadedPart.lastEntryId = entry.id;
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
                    loadedPart.responses.push({ key: `${provider}/${model}`, stopReason: (message as unknown as { stopReason?: string }).stopReason, timestamp: (message as unknown as { timestamp?: unknown }).timestamp, usage: (message as unknown as { usage?: Usage }).usage });
                  } else {
                    const mk = provider || model ? `${provider ?? "unknown"}/${model ?? "unknown"}` : "unknown/unknown";
                    if (provider || model) loadedPart.responses.push({ key: mk, stopReason: (message as unknown as { stopReason?: string }).stopReason, timestamp: (message as unknown as { timestamp?: unknown }).timestamp, usage: (message as unknown as { usage?: Usage }).usage });
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
                          const p = skillLast.get(sname) ?? 0;
                          if (t > p) skillLast.set(sname, t);
                        }
                      }
                    }
                  }
                } else if (role === "toolResult") {
                  const toolName = (message as unknown as { toolName?: string }).toolName;
                  const isError = !!(message as unknown as { isError?: boolean }).isError;
                  if (isError) {
                    const errKey = toolName ?? "_unknown";
                    errMap.set(errKey, (errMap.get(errKey) ?? 0) + 1);
                  }
                }
              }
            }
            cursor = page.next;
          } while (cursor);
          loadedPart.userTurns = userTurns;
          loadedPart.assistantTurns = assistantTurns;
          loadedPart.totalToolCalls = [...callMap.values()].reduce((a, b) => a + b, 0);
          loadedPart.totalToolErrors = [...errMap.values()].reduce((a, b) => a + b, 0);
          loadedPart.toolCalls = [...callMap.entries()];
          loadedPart.toolErrors = [...errMap.entries()];
          loadedPart.skillCounts = [...skillMap.entries()];
          loadedPart.skillLastUsed = [...skillLast.entries()];
          timings.scanMs += performance.now() - scanStarted;
        }

        let fallbackTitle: string | null = null;
        if (needFallbackTitle) {
          try {
            const titleScanStarted = performance.now();
            const titleEntries = await tx.scanEntries({ conversationId: id, order: "ascending" }, 30);
            timings.entriesScanned += titleEntries.items.length;
            timings.scanMs += performance.now() - titleScanStarted;
            const first = titleEntries.items.find(e => e.kind === "pi.user");
            const txt = (first as unknown as { model?: Array<{ content?: unknown }> })?.model?.[0]?.content ?? "";
            const t = typeof txt === "string" ? txt : Array.isArray(txt) ? (txt as Array<{ text?: string }>).map((b) => b.text || "").join(" ") : "";
            fallbackTitle = t.replace(/\s+/g, " ").slice(0, 60) || null;
          } catch {}
        }

        let sStatus: SessionStatus = "ready", sStatusReason: string | null = null;
        let sLastActivity: string | null = null, sCreatedAt: string | null = null, sWorker: number | null = null;
        let sLastTs: number | null = null, sCreatedTs: number | null = null;
        try {
          const running = await isRunning(tx, id);
          const s = await readSessionStatus(tx, id, running);
          sStatus = s.status; sStatusReason = s.statusReason;
          const ts = await newestMessageTime(tx, id);
          if (ts !== null) { sLastTs = ts; sLastActivity = new Date(ts).toISOString(); }
          const createdRaw: unknown = (await tx.doc(SessionCreated, id)).at;
          if (typeof createdRaw === "number" && Number.isFinite(createdRaw)) { sCreatedTs = createdRaw; sCreatedAt = new Date(createdRaw).toISOString(); }
          try {
            const target = await (tx.doc as unknown as (doc: unknown, id: ConversationId) => Promise<{ worker: number | null }>)(ExecTarget as unknown as never, id).catch(() => null);
            if (target && typeof (target as { worker: unknown }).worker !== "undefined") sWorker = (target as { worker: number | null }).worker ?? null;
          } catch {}
        } catch {}
        let sSubagentCount = 0;
        try {
          const children = await tx.doc(Children, id);
          sSubagentCount = Array.isArray((children as { children?: unknown[] }).children) ? (children as { children: unknown[] }).children.length : 0;
        } catch {}

        return {
          part: loadedPart,
          fallbackTitle,
          sessionData: {
            status: sStatus, statusReason: sStatusReason, lastActivity: sLastActivity,
            createdAt: sCreatedAt, worker: sWorker, lastTs: sLastTs, createdTs: sCreatedTs,
            subagentCount: sSubagentCount,
          },
        };
      }, context);

      if (!res) { cache?.parts.delete(k); continue; }
      if (res.part) {
        part = res.part;
        if (res.fallbackTitle !== null) part.fallbackTitle = res.fallbackTitle;
        // Verify generation/epoch validity before publishing into cache
        if (cache && (cache.generations.get(k) ?? 0) === genBefore && cache.epoch === epochBefore) {
          cache.parts.set(k, part);
        }
      } else if (part && res.fallbackTitle !== null) {
        part.fallbackTitle = res.fallbackTitle;
      }
      sessionData = res.sessionData;
    } else {
      timings.cacheHits++;
      const cachedSessionData = prefetched.has(k) ? prefetched.get(k) : await harness.commit(async tx => {
        if (!(await tx.conversation(id))) return undefined;
        return readCachedSession(tx, id);
      }, context);
      if (!cachedSessionData) { cache?.parts.delete(k); continue; }
      sessionData = cachedSessionData;
    }

    if (!part) continue;

    // Aggregate conversation part into global models & tools
    for (const [key, metrics] of part.ledger.models) {
      const row = getModel(key); row.sessions++;
      add(row.usage, metrics); add(totals, metrics);
    }
    for (const [name, metrics] of part.ledger.tools) {
      let total = toolMap.get(name);
      if (!total) { total = empty(); toolMap.set(name, total); }
      add(total, metrics);
    }
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
      let dErr = dailyErrors.get(dateKey);
      if (!dErr) { dErr = { responses: 0, errors: 0, aborted: 0 }; dailyErrors.set(dateKey, dErr); }
      dErr.responses++;
      if (message.stopReason === "error") dErr.errors++;
      if (message.stopReason === "aborted") dErr.aborted++;
      const pid = projectLinks.get(Number(id)) ?? 0;
      const pname = projectNames.get(pid) ?? "General";
      const pdKey = `${pid}|${dateKey}`;
      let pd = projectDailyMap.get(pdKey);
      if (!pd) { pd = { date: dateKey, projectId: pid, projectName: pname, responses: 0, usage: empty() }; projectDailyMap.set(pdKey, pd); }
      pd.responses++;
      if (message.usage) add(pd.usage, message.usage);
    }

    const sessionUsage = empty();
    for (const [, metrics] of part.ledger.models) add(sessionUsage, metrics);
    let sessResponses = 0, sessErrors = 0, sessAborted = 0;
    for (const m of part.responses) { sessResponses++; if (m.stopReason === "error") sessErrors++; if (m.stopReason === "aborted") sessAborted++; }
    const sessModels = [...new Set(part.ledger.models.map(([km]) => km))].sort();

    const forkDepth = forkDepthOf(k);
    let durationMs: number | null = null;
    if (sessionData.lastTs != null && sessionData.createdTs != null) durationMs = Math.max(0, sessionData.lastTs - sessionData.createdTs);
    const totalTurns = part.userTurns + part.assistantTurns;
    const avgTokensPerTurn = totalTurns ? sessionUsage.totalTokens / totalTurns : null;

    let title: string | null = null, archived = false, pinned = false;
    if (metaDb) {
      try {
        const row = conversationMeta.get(Number(id));
        if (row) { title = row.title ?? null; archived = !!row.archived; pinned = !!row.pinned; }
      } catch {}
    }
    title ??= part.fallbackTitle ?? null;
    statusBreakdown[sessionData.status] = (statusBreakdown[sessionData.status] ?? 0) + 1;
    const pid = projectLinks.get(Number(id)) ?? 0;
    const pname = projectNames.get(pid) ?? null;

    let ps = projectStatsMap.get(pid);
    if (!ps) { ps = { usage: empty(), sessions: 0 }; projectStatsMap.set(pid, ps); }
    ps.sessions++;
    add(ps.usage, sessionUsage as unknown as Partial<Usage>);

    const wKey = sessionData.worker == null ? "main" : String(sessionData.worker);
    let ws = workerStatsMap.get(wKey);
    if (!ws) { ws = { worker: sessionData.worker, sessions: 0, usage: empty() }; workerStatsMap.set(wKey, ws); }
    ws.sessions++;
    add(ws.usage, sessionUsage as unknown as Partial<Usage>);

    sessionRows.push({
      id: String(id), title, archived, pinned, parent: parent ?? null,
      status: sessionData.status, statusReason: sessionData.statusReason, lastActivity: sessionData.lastActivity, createdAt: sessionData.createdAt, worker: sessionData.worker,
      usage: sessionUsage, responses: sessResponses, errors: sessErrors, aborted: sessAborted, models: sessModels,
      turns: { user: part.userTurns, assistant: part.assistantTurns },
      durationMs,
      subagentCount: sessionData.subagentCount,
      forkDepth,
      toolCalls: part.totalToolCalls,
      toolErrors: part.totalToolErrors,
      skills: part.skillCounts.map(([n]) => n),
      avgTokensPerTurn,
      projectId: pid,
      projectName: pname,
    });
  }

  // Phase 3: Global Aggregates outside commits
  sessionRows.sort((a, b) => (b.lastActivity ?? b.createdAt ?? "").localeCompare(a.lastActivity ?? a.createdAt ?? "") || Number(b.id) - Number(a.id));
  for (const row of modelMap.values()) row.daily = [...daily.get(row.key)!.values()].sort((a, b) => a.date.localeCompare(b.date));

  const toolsDetailed: AnalyticsToolDetailed[] = [...toolMap.entries()].map(([name, usage]) => {
    const calls = toolCallsGlobal.get(name) ?? 0;
    const errors = toolErrorsGlobal.get(name) ?? 0;
    return { name, calls, errors, errorRate: calls ? errors / calls : null, usage };
  }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
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

  const contentActions = {
    reads: toolCallsGlobal.get("read") ?? 0,
    writes: toolCallsGlobal.get("write") ?? 0,
    edits: toolCallsGlobal.get("edit") ?? 0,
    bashes: (toolCallsGlobal.get("bash") ?? 0) + (toolCallsGlobal.get("machine_exec") ?? 0),
    boards: toolCallsGlobal.get("board") ?? 0,
  };

  timings.aggregationMs = Math.max(0, performance.now() - started - timings.scanMs - timings.metadataMs);
  return {
    performance: timings,
    generatedAt: new Date().toISOString(),
    scope: "All retained conversations, including archived sessions and subagents. Deleted conversations are excluded. Fork history is counted only at its original owner.",
    totals, sessions: sessionRows.length,
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
      "Per-session status reflects the snapshot time. Refresh to update active, failed, or waiting sessions.",
      "Tool calls and skill invocations are counted from retained entries. Fork parents do not duplicate child tool history.",
      "Project and worker breakdowns use luna_session_projects and ExecTarget. General holds sessions without a project.",
      "Analytics uses an eventually consistent multi-read snapshot across conversations to avoid monopolizing the mutation queue.",
    ],
  };
}
