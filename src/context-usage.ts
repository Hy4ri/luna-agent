import type { ContextView } from "@earendil-works/pi-durable";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

/** Match pi-durable's request-size estimate, never its cumulative usage ledger.
 * A summary invalidates usage from before its head marker.
 */
export function activeContextTokens(view: ContextView): number {
  let measured;
  const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
  for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
    if (view.entries[index]!.id <= after) continue;
    measured = view.contributions[index]!.findLast(message =>
      message.role === "assistant" && calculateContextTokens(message.usage) > 0);
  }
  const from = measured === undefined ? 0 : view.messages.lastIndexOf(measured) + 1;
  let tokens = measured?.role === "assistant" ? calculateContextTokens(measured.usage) : 0;
  for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
  return tokens;
}
