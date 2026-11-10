// Busy chat policy uses the harness inbox. There is no second message queue.
import { defineDoc, InboxDoc, type ConversationId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";

export type BusyMode = "queue" | "steer";
export type BusyAction = "started" | "queued" | "steered";
export interface BusyPolicy { mode: BusyMode; acknowledgements: boolean }
export const DEFAULT_BUSY_INPUT: BusyPolicy = { mode: "steer", acknowledgements: true };
export const BusyFeedback = defineDoc<{ lastAck: number; tips: string[] }>({
  checkpointWhen: () => false,
  kind: "luna.busy.feedback", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ lastAck: 0, tips: [] }),
});
const tips: Record<BusyMode, string> = {
  queue: "Busy input: run each message later as a separate turn. Use /steer to override.",
  steer: "Busy input: add the message at the next boundary, after the current tool batch or answer. The current response is not stopped. Use /queue to override.",
};
/** How the harness admitted `id`, read in the admitting commit: a steer or follow-up in the inbox, else started. */
export async function admittedAction(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<BusyAction> {
  const item = (await tx.doc(InboxDoc, conversationId)).items.find(row => row.id === id);
  return item?.mode === "steer" ? "steered" : item ? "queued" : "started";
}
export async function feedback(tx: Tx, id: ConversationId, policy: BusyPolicy, action: BusyAction, now = Date.now()) {
  const doc = await tx.doc(BusyFeedback, id);
  let tip: string | undefined, notice: string | undefined;
  if (!doc.tips.includes(policy.mode)) { doc.tips.push(policy.mode); tip = tips[policy.mode]; }
  if (policy.acknowledgements && action !== "started" && (!doc.lastAck || now - doc.lastAck >= 30_000)) {
    doc.lastAck = now; notice = action[0]!.toUpperCase() + action.slice(1) + ".";
  }
  return { ...(notice ? { notice } : {}), ...(tip ? { tip } : {}) };
}
export class BusyCommandError extends Error { constructor(message: string, readonly status: 400 | 409 = 400) { super(message); } }
export type QueueCommand = { action: "list" | "clear" } | { action: "remove"; index: number } | { action: "edit"; index: number; content: string } | { action: "move"; index: number; to: number };
export function parseQueueCommand(text: string): QueueCommand | undefined {
  if (/^(list|clear)\s*$/.test(text)) return { action: text.trim() as "list" | "clear" };
  let match = /^edit\s+(\d+)\s+([\s\S]+)$/.exec(text);
  if (match) return { action: "edit", index: Number(match[1]), content: match[2]!.trim() };
  match = /^remove\s+(\d+)\s*$/.exec(text);
  if (match) return { action: "remove", index: Number(match[1]) };
  match = /^move\s+(\d+)\s+(?:to\s+)?(\d+)\s*$/.exec(text);
  if (match) return { action: "move", index: Number(match[1]), to: Number(match[2]) };
  return undefined;
}
export async function queueCommand(tx: Tx, id: ConversationId, command: QueueCommand, requestId?: string) {
  // Repeated HTTP requests return their original receipt without repeating a queue mutation.
  if (requestId) {
    const previous = await tx.submissionByRequest(id, requestId);
    if (previous?.type === "write" && previous.status === "done") {
      const entry = await tx.entry(previous.entry);
      if (entry?.kind === "luna.busy.command") return entry.data as unknown as QueueResult;
    }
    if (previous) throw new BusyCommandError("Request ID already belongs to another message.", 409);
  }
  const inbox = await tx.doc(InboxDoc, id);
  const fifo = inbox.items.filter(item => item.mode === "followUp");
  const at = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > fifo.length) throw new BusyCommandError("Queue number is out of range.");
    return fifo[n - 1]!;
  };
  if (command.action === "edit") {
    const item = at(command.index);
    if (!command.content) throw new BusyCommandError("Queue message is empty.");
    if (item.mode !== "write") item.content = command.content;
  } else if (command.action === "move") {
    const item = at(command.index), target = at(command.to);
    const sourceIndex = inbox.items.findIndex(row => row.id === item.id);
    inbox.items.splice(sourceIndex, 1);
    const targetIndex = inbox.items.findIndex(row => row.id === target.id);
    if (item.id === target.id) inbox.items.splice(sourceIndex, 0, item);
    else inbox.items.splice(targetIndex + (command.index < command.to ? 1 : 0), 0, item);
  } else if (command.action === "remove" || command.action === "clear") {
    const remove = command.action === "remove" ? [at(command.index)] : fifo;
    for (const item of remove) {
      inbox.items.splice(inbox.items.findIndex(row => row.id === item.id), 1);
      tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
    }
  }
  const queue = inbox.items.filter(item => item.mode === "followUp").map((item, i) => ({ number: i + 1, content: item.mode === "write" ? null : JSON.parse(JSON.stringify(item.content)) }));
  const result: QueueResult = { command: true, queue, notice: command.action === "list" ? (queue.length ? `${queue.length} queued message(s).` : "Queue is empty.") : "Queue updated." };
  if (requestId) {
    const entry = await tx.appendEntry(id, { kind: "luna.busy.command", data: result as never });
    await tx.createSubmission({ conversationId: id, requestId, type: "write", status: "done", entry: entry.id });
  }
  return result;
}
interface QueueResult { command: true; queue: { number: number; content: unknown }[]; notice: string }
