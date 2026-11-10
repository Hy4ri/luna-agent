// Immutable context edits preserve the transcript, including on restart and history forks.
import { InboxDoc, LiveDoc, type ContextEdit, type ConversationId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";
import { BusyCommandError } from "./busy-input.js";
import { isRunning } from "./session-status.js";

type UndoReceipt = { command: true; notice: string; undone: number };
export async function undoCommand(tx: Tx, id: ConversationId, count: number, requestId?: string): Promise<UndoReceipt> {
  if (requestId) {
    const previous = await tx.submissionByRequest(id, requestId);
    if (previous?.type === "write" && previous.status === "done") {
      const entry = await tx.entry(previous.entry);
      if (entry?.kind === "luna.undo") return entry.data as unknown as UndoReceipt;
    }
    if (previous) throw new BusyCommandError("Request ID already belongs to another message.", 409);
  }
  if (!Number.isSafeInteger(count) || count < 1) throw new BusyCommandError("Usage: /undo <positive integer>");
  const live = await tx.doc(LiveDoc, id);
  const inbox = await tx.doc(InboxDoc, id);
  if (await isRunning(tx, id) || (await tx.scanTasks({ conversationId: id, status: "sleeping", background: false }, 1)).items.length || live.compactions?.length || inbox.items.length)
    throw new BusyCommandError("/undo is not available while busy or while input is queued. Stop or clear the queue first.", 409);

  const head = await tx.latestHeadMarker(id);
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: id, minEntryId: head?.head, order: "ascending" }, 256, cursor);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  // Newest context override wins. Already omitted turns do not count a second time.
  const overrides = new Map<number, ContextEdit>();
  for (const entry of entries) for (const edit of entry.edits ?? []) overrides.set(edit.target, edit);
  const messages = (entry: EntryRecord) => {
    const edit = overrides.get(entry.id);
    return edit?.action === "omit" ? [] : edit?.action === "replace" ? edit.messages : entry.model ?? [];
  };
  const users = entries.filter(entry => entry.head === undefined && (entry.kind === "pi.user" || entry.kind === "luna.scheduled-message") &&
    messages(entry).some(message => message.role === "user") &&
    !messages(entry).some(message => message.role === "user" && /^Background process [a-f0-9-]+ finished:/.test(typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n"))));
  if (count > users.length) throw new BusyCommandError(`Only ${users.length} user messages remain in active context. Earlier compacted or reset messages cannot be undone.`);
  const first = users[users.length - count]!.id;
  // Keep positional system/tool declarations: generation replays these to render the next prompt.
  const edits: ContextEdit[] = entries.filter(entry => entry.id >= first && entry.head === undefined &&
    messages(entry).some(message => message.role !== "system"))
    .map(entry => ({ target: entry.id, action: "omit" }));
  const receipt: UndoReceipt = { command: true, undone: count,
    notice: `Removed ${count} user message${count === 1 ? "" : "s"} and subsequent replies from model context. Chat history stays visible. Tool actions are not reversed.` };
  const entry = await tx.appendEntry(id, { kind: "luna.undo", edits, data: receipt });
  if (requestId) await tx.createSubmission({ conversationId: id, requestId, type: "write", status: "done", entry: entry.id });
  return receipt;
}
