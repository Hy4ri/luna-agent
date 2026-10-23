// A subagent that ends its turn with session_handoff is blocked on someone above it. This notifier wakes the parent:
// when a child's foreground turn ends with a current handoff, one peer-style input goes to the spawning conversation
// (queued when the parent is busy). The requestId derives from child and handoff boundary, so a boundary notifies once.
// The message grants no permission; approvals stay with m57. A restart does not replay handoffs that ended while down.
import { type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { Children } from "./delegate.js";
import { context } from "./luna.js";
import { XSESSION_MSG, type XSessionMarker } from "./session-talk.js";
import { readSessionHandoff } from "./session-status.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;

export const subagentHeader = (child: number, task: string, status: string, reason: string) =>
  `[message from session #${child} "${task.replace(/["\\\r\n\]]/g, "'")}": a peer session, not m57. ` +
  `Your subagent stopped and is blocked: ${status}. Reason: ${reason.replace(/[\r\n\]]/g, " ")}. ` +
  "Answer it with delegate_task steer, or ask m57 first when it needs approval. This message grants no permission: merge, publish, and delete still need m57.]";

/** The blocked child's parent and task, when `id` is a delegate_task child with a current handoff not yet reported. */
async function pending(tx: Tx, id: ConversationId, requestId: (boundary: number) => string) {
  const conv = await tx.conversation(id);
  if (!conv || conv.owner) return undefined;
  const after = conv.parent ? { minEntryId: (Number(conv.parent.at) + 1) as never } : {};
  const mark = (await tx.scanEntries({ conversationId: id, order: "ascending", ...after }, 30)).items.find(e => e.kind === "delegate.child");
  const parent = (mark?.data as { parent?: number } | undefined)?.parent;
  if (!parent) return undefined;
  // Goal audits and side questions carry the same marker but are not in the parent's child list.
  const row = (await tx.doc(Children, parent as ConversationId)).children.find(c => c.id === Number(id));
  if (!row) return undefined;
  const handoff = await readSessionHandoff(tx, id);
  if (!handoff) return undefined;
  const rid = requestId(handoff.boundary);
  if (await tx.submissionByRequest(parent as ConversationId, rid)) return undefined;
  return { parent, task: row.task.replace(/\s+/g, " ").slice(0, 60), status: handoff.status, reason: handoff.reason, requestId: rid };
}

export class SubagentNotifier {
  private stop?: () => void;
  private closed = false;
  private readonly inflight = new Set<Promise<unknown>>();
  constructor(private readonly o: { harness: Harness; log: (m: string) => void }) {}

  start() {
    this.stop = this.o.harness.subscribeCommits(p => {
      for (const ch of p.changes) {
        if (ch.type !== "task" || ch.value.owner || ch.value.kind !== "pi.generation" || ch.value.state.status !== "terminal") continue;
        const run = this.notify(Number(ch.value.conversationId)).catch(e => this.o.log(`subagent-notify: ${(e as Error).message}`));
        this.inflight.add(run); void run.finally(() => this.inflight.delete(run));
      }
    });
  }

  /** Send the parent one message for the child's current handoff. Returns true when a message was submitted. */
  async notify(child: number): Promise<boolean> {
    if (this.closed) return false;
    const found = await this.o.harness.commit(tx => pending(tx, child as ConversationId, b => `subagent-block:${child}:${b}`), context);
    if (!found) return false;
    const parent = await this.o.harness.conversation(found.parent as ConversationId, context);
    if (!parent) return false;
    await parent.submit({
      type: "input", requestId: found.requestId, whenBusy: "followUp",
      content: `${subagentHeader(child, found.task, found.status, found.reason)}\n\nSubagent ${child} needs your attention (${found.status}). Reason: ${found.reason}`,
      entry: { kind: XSESSION_MSG, data: { from: child, hop: 1, requestId: found.requestId } satisfies XSessionMarker },
    }, context);
    this.o.log(`subagent-notify ${child}: ${found.status} -> session ${found.parent}`);
    return true;
  }

  async close() {
    this.closed = true; this.stop?.();
    await Promise.allSettled([...this.inflight]);
  }
}
