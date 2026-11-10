// A view over existing per-conversation ledgers, never a second accounting store.
import { UsageDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { Children } from "./delegate-state.js";

export interface DelegateUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  costUsd: number; missingCost: boolean; zeroCostModels: string[];
}
const empty = (): DelegateUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, missingCost: false, zeroCostModels: [] });
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function add(target: DelegateUsage, source: DelegateUsage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "costUsd"] as const) target[key] += source[key];
  target.missingCost ||= source.missingCost;
  target.zeroCostModels = [...new Set([...target.zeroCostModels, ...source.zeroCostModels])];
}
export async function readDelegateUsage(tx: Tx, id: ConversationId): Promise<DelegateUsage> {
  const result = empty();
  const ledger = await tx.doc(UsageDoc, id);
  // Tool-reported spend can overlap model spend. Do not add the tools bucket.
  for (const [name, usage] of Object.entries(ledger.models)) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) if (finite(usage[key])) result[key] += usage[key];
    if (finite(usage.cost?.total)) {
      result.costUsd += usage.cost.total;
      if (usage.cost.total === 0 && usage.totalTokens > 0) result.zeroCostModels.push(name);
    } else result.missingCost = true;
  }
  return result;
}
export async function readDelegationUsage(tx: Tx, id: ConversationId) {
  const parent = await readDelegateUsage(tx, id), childTotal = empty(), total = empty();
  const children: { id: number; usage: DelegateUsage | null }[] = [];
  const seen = new Set<number>();
  for (const child of (await tx.doc(Children, id)).children) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const usage = await tx.conversation(child.id as ConversationId) ? await readDelegateUsage(tx, child.id as ConversationId) : null;
    children.push({ id: child.id, usage });
    if (usage) add(childTotal, usage);
  }
  add(total, parent); add(total, childTotal);
  return { parent, children, childTotal, total, unavailableChildren: children.filter(c => c.usage === null).length,
    note: "Recorded model USD amounts. They are estimates, not invoices: a total can mix provider-reported and catalog-rate parts. Zero cost can mean unpriced, subscription, or free usage. Deleted children are excluded; tool-reported usage is not added." };
}
