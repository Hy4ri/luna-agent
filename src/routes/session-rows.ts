import type { ConversationId, ConversationRecord, Tx } from "@earendil-works/pi-durable";
import { isRunning, readSessionStatus, type SessionState } from "../session-status.js";
import type { RecoverySummary } from "../scheduled-messages.js";
import { newestMessageTime, SessionCreated } from "../session-activity.js";
import { ExecTarget } from "../workers.js";
import { context } from "../luna.js";
import { type RouteCtx, textOf } from "./context.js";

export type SessionRow = SessionState & {
  hidden: boolean;
  parent: unknown;
  firstUser: string;
  running: boolean;
  wait: number | null;
  recovery: RecoverySummary | null;
  lastActivity: number | null;
  createdAt: number | null;
  worker: number | null;
};

export function createSessionRows(ctx: RouteCtx) {
  const { opts, harness } = ctx;
  const rows = new Map<string, SessionRow>();
  const generations = new Map<string, number>();
  let epoch = 0,
    caching = true;

  try {
    harness.observeCommits({ advance(publication) {
      for (const change of publication.changes) {
        const id =
          change.type === "conversation"
            ? change.value.id
            : change.type === "entry" || change.type === "task" || change.type === "submission"
              ? change.value.conversationId
              : change.conversationId;
        if (id === undefined) {
          rows.clear();
          epoch++;
          continue;
        }
        const k = String(id);
        rows.delete(k);
        generations.set(k, (generations.get(k) ?? 0) + 1);
      }
    }, end() {
      caching = false;
      rows.clear();
      generations.clear();
      epoch++;
    } });
  } catch {
    caching = false;
  } // No commit feed means no invalidation: rebuild every row instead.

  const buildRow = async (tx: Tx, r: Pick<ConversationRecord, "id" | "parent">): Promise<SessionRow> => {
    const head = (await tx.scanEntries({ conversationId: r.id, order: "ascending" }, 30)).items;
    const firstUser = textOf(head.find((e) => (e.kind === "pi.user" || e.kind === "luna.scheduled-message")))
      .replace(/\s+/g, " ")
      .slice(0, 60);
    const ownHead = r.parent
      ? (
          await tx.scanEntries(
            { conversationId: r.id, order: "ascending", minEntryId: (Number(r.parent.at) + 1) as never },
            30,
          )
        ).items
      : head;
    if (ownHead.some((e) => e.kind === "delegate.child"))
      return {
        hidden: true,
        parent: null,
        firstUser,
        running: false,
        status: "ready",
        statusReason: null,
        wait: null,
        recovery: null,
        lastActivity: null,
        createdAt: null,
        worker: null,
      };
    const running = await isRunning(tx, r.id);
    return {
      hidden: false,
      parent: r.parent ?? null,
      firstUser,
      running,
      ...(await readSessionStatus(tx, r.id, running)),
      wait: running ? null : (await opts.scheduledMessages?.recovery(tx, r.id))?.resumeAt ?? null,
      recovery: running ? null : ((await opts.scheduledMessages?.recovery(tx, r.id)) ?? null),
      lastActivity: await newestMessageTime(tx, r.id),
      createdAt: (await tx.doc(SessionCreated, r.id)).at ?? null,
      worker: (await tx.doc(ExecTarget, r.id)).worker,
    };
  };

  // Concurrent requests (several tabs reacting to one event) share one storage pass.
  let listing: Promise<[ConversationId, SessionRow][]> | undefined;
  const listRows = () =>
    (listing ??= harness
      .commit(async (tx) => {
        const seen = new Set<string>(),
          out: [ConversationId, SessionRow][] = [];
        let cursor;
        do {
          const page = await tx.scanConversations({ order: "descending" }, 100, cursor);
          for (const r of page.items) {
            const k = String(r.id);
            seen.add(k);
            let row = rows.get(k);
            if (!row) {
              const gen = generations.get(k) ?? 0,
                at = epoch;
              row = await buildRow(tx, r);
              // A commit for this conversation during the read leaves the row uncached; the next request rereads it.
              if (caching && (generations.get(k) ?? 0) === gen && epoch === at) rows.set(k, row);
            }
            out.push([r.id, row]);
          }
          cursor = page.next;
        } while (cursor);
        for (const k of rows.keys()) if (!seen.has(k)) rows.delete(k);
        return out;
      }, context)
      .finally(() => {
        listing = undefined;
      }));

  return { listRows };
}
