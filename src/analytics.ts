import type { Models, Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId } from "@earendil-works/pi-durable";
import { context } from "./luna.js";

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

/** One consistent view of retained ledgers and their own dated response history.
 * Usage documents include undated compaction attempts. They must not be rebuilt from entries.
 * Fork scans include inherited entries; counting only their owning conversation prevents duplication.
 */
export async function readAnalytics(harness: Harness, models?: Models) {
  return harness.commit(async tx => {
    const modelMap = new Map<string, AnalyticsModel>();
    const daily = new Map<string, Map<string, AnalyticsModel["daily"][number]>>();
    const toolMap = new Map<string, AnalyticsMetrics>();
    const totals = empty();
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
    const readConversation = async (id: ConversationId) => {
      // tx.doc initializes an absent ledger to empty; genuine storage errors must propagate.
      const usage = await tx.doc(UsageDoc, id);
      for (const [key, metrics] of Object.entries(usage.models)) {
        const row = getModel(key); row.sessions++;
        add(row.usage, metrics); add(totals, metrics);
      }
      for (const [name, metrics] of Object.entries(usage.tools)) {
        let total = toolMap.get(name);
        if (!total) { total = empty(); toolMap.set(name, total); }
        add(total, metrics);
      }
      let cursor;
      do {
        const page = await tx.scanEntries({ conversationId: id, order: "ascending" }, 200, cursor);
        for (const entry of page.items) {
          if (entry.conversationId !== id || entry.kind !== "pi.assistant") continue;
          for (const message of entry.model ?? []) {
            if (message.role !== "assistant") continue;
            const row = getModel(`${message.provider}/${message.model}`);
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
          }
        }
        cursor = page.next;
      } while (cursor);
    };
    let cursor, sessions = 0;
    do {
      const page = await tx.scanConversations({ order: "ascending" }, 100, cursor);
      for (const conversation of page.items) { sessions++; await readConversation(conversation.id); }
      cursor = page.next;
    } while (cursor);
    for (const row of modelMap.values()) row.daily = [...daily.get(row.key)!.values()].sort((a, b) => a.date.localeCompare(b.date));
    return {
      generatedAt: new Date().toISOString(),
      scope: "All retained conversations, including archived sessions and subagents. Deleted conversations are excluded. Fork history is counted only at its original owner.",
      totals, sessions,
      models: [...modelMap.values()].sort((a, b) => a.key.localeCompare(b.key)),
      tools: [...toolMap].sort(([a], [b]) => a.localeCompare(b)).map(([name, usage]) => ({ name, usage })),
      notes: [
        "Model totals come from recorded usage ledgers and include compaction attempts. They survive context reset and compaction.",
        "Costs are recorded USD estimates, not invoices or subscription charges. Current catalog rates do not recalculate historical costs.",
        "Zero cost can mean unpriced usage, a subscription adapter, or a zero rate. It does not prove usage was free.",
        "Uncached input is not proof of a cache miss. Providers do not report a separate cache-miss counter.",
        "Reasoning tokens are part of output. One-hour cache writes are part of cache writes. Optional counters sum reported values only.",
        "Daily charts and response counts use retained assistant messages. Undated compaction attempts are excluded, so chart sums can differ from ledger totals.",
        "Tool-reported usage is shown separately and is not added to model totals because it can overlap.",
      ],
    };
  }, context);
}
