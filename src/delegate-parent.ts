// Resolve a native child through its own marker and the parent's durable ownership list.
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Children, DELEGATE_CHILD } from "./delegate-state.js";

export async function delegateParent(tx: Tx, child: ConversationId): Promise<ConversationId | undefined> {
  const conversation = await tx.conversation(child);
  if (!conversation || conversation.owner) return undefined;
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: child, order: "ascending",
      ...(conversation.parent ? { minEntryId: (Number(conversation.parent.at) + 1) as never } : {}) }, 100, cursor);
    for (const entry of page.items) {
      if (entry.conversationId !== child || entry.kind !== DELEGATE_CHILD) continue;
      const parent = (entry.data as { parent?: number } | undefined)?.parent as ConversationId | undefined;
      if (!parent || !await tx.conversation(parent)) return undefined;
      return (await tx.doc(Children, parent)).children.some(row => row.id === Number(child)) ? parent : undefined;
    }
    cursor = page.next;
  } while (cursor);
  return undefined;
}
