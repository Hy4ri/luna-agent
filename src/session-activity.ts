import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

// Missing timestamps in older databases stay unknown. Never use first-read time as creation time.
export const SessionCreated = defineDoc({ checkpointWhen: () => false, kind: "luna.session-created", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ at: null as number | null }) });

/** Find the newest message, not the largest timestamp in the conversation's entire history. */
export async function newestMessageTime(tx: Pick<Tx, "scanEntries">, id: ConversationId): Promise<number | null> {
  // The newest message is usually among the last few entries. Start small: tool results make entries large to parse.
  let cursor, size = 16;
  do {
    const page = await tx.scanEntries({ conversationId: id, order: "descending" }, size, cursor);
    size = Math.min(size * 4, 200);
    for (const entry of page.items) {
      const role = (entry.kind === "pi.user" || entry.kind === "luna.xsession.msg") ? "user" : entry.kind === "pi.assistant" ? "assistant" : null;
      if (!role) continue;
      let timestamp: number | null = null;
      for (const message of entry.model ?? []) {
        if (message.role !== role || !Number.isFinite(message.timestamp) || message.timestamp < 0) continue;
        timestamp = Math.max(timestamp ?? 0, message.timestamp);
      }
      if (timestamp !== null) return timestamp;
    }
    cursor = page.next;
  } while (cursor);
  return null;
}
