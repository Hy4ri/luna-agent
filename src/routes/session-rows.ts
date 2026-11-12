import type { ConversationId, ConversationRecord, Tx } from "@earendil-works/pi-durable";
import { isRunning, readSessionStatus, type SessionState } from "../session-status.js";
import { ScheduledMessagesDoc, type RecoverySummary } from "../scheduled-messages.js";
import { RecoveryStateDoc } from "../recovery-state.js";
import { newestMessageTime, SessionCreated } from "../session-activity.js";
import { ExecTarget } from "../workers.js";
import { context } from "../luna.js";
import type { Database } from "bun:sqlite";
import { conversationStorage } from "../conversation-storage.js";
import { readRowHead, type RowHead } from "../session-row-head.js";
import { type RouteCtx, textOf } from "./context.js";

export type SessionRow = SessionState & {
  hidden: boolean;
  parent: unknown;
  firstUser: string;
  running: boolean;
  wait: number | null;
  recovery: RecoverySummary | null;
  scheduled?: { count: number; version: string };
  lastActivity: number | null;
  createdAt: number | null;
  worker: number | null;
};

/** Session-scope documents that no row field reads. Their writes leave every cached row valid. */
const UNUSED_GLOBAL_DOCS = new Set(["luna.limit-waits", "luna.session-creation", "luna.scheduled-messages-history"]);

/**
 * Per-conversation slice of a session-scope document that a row reads: `scheduled` and `recovery` read
 * ScheduledMessagesDoc schedules; `recovery` reads RecoveryStateDoc attempts keyed "<conversation>:<boundary>".
 * Undefined means rows do not know this document kind.
 */
function rowSlices(kind: string, value: unknown): Map<string, string> | undefined {
  const out = new Map<string, unknown[]>();
  const add = (id: unknown, item: unknown) => {
    const k = String(id);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  };
  const v = (value ?? {}) as { schedules?: Record<string, { conversationId?: unknown }>; attempts?: Record<string, unknown> };
  if (kind === "luna.scheduled-messages") {
    for (const [key, s] of Object.entries(v.schedules ?? {})) add(s?.conversationId, [key, s]);
  } else if (kind === "luna.scheduled-recovery") {
    for (const [key, a] of Object.entries(v.attempts ?? {})) add(key.split(":")[0], [key, a]);
  } else return undefined;
  return new Map([...out].map(([k, items]) => [k, JSON.stringify(items)]));
}

export function createSessionRows(ctx: RouteCtx) {
  const { opts, harness } = ctx;
  const rows = new Map<string, SessionRow>();
  const generations = new Map<string, number>();
  // Last seen row slices per session-scope document kind, to invalidate only the conversations a write changed.
  const slices = new Map<string, Map<string, string>>();
  let epoch = 0,
    caching = true;
  const invalidate = (k: string) => {
    rows.delete(k);
    generations.set(k, (generations.get(k) ?? 0) + 1);
  };
  const clearAll = () => {
    rows.clear();
    epoch++;
  };

  try {
    harness.observeCommits({ advance(publication) {
      for (const change of publication.changes) {
        const id =
          change.type === "conversation"
            ? change.value.id
            : change.type === "entry" || change.type === "task" || change.type === "submission"
              ? change.value.conversationId
              : change.conversationId;
        if (id !== undefined) {
          invalidate(String(id));
          continue;
        }
        // A session-scope document. Clearing every row here made the next list rebuild all sessions on the main
        // thread (1.8 s warm, 9.8 s cold on 493 sessions), and any such write during that rebuild discarded it again.
        const kind = change.type === "document" ? change.record.kind : undefined;
        if (kind !== undefined && UNUSED_GLOBAL_DOCS.has(kind)) continue;
        const next = kind !== undefined && change.type === "document" ? rowSlices(kind, change.kind === "change" ? change.value : undefined) : undefined;
        const previous = kind !== undefined ? slices.get(kind) : undefined;
        if (kind !== undefined && next) slices.set(kind, next);
        // Unknown kind, or the first write seen for a kind (its earlier state is unknown): rebuild every row once.
        if (!next || !previous) {
          clearAll();
          continue;
        }
        for (const k of new Set([...previous.keys(), ...next.keys()])) if (previous.get(k) !== next.get(k)) invalidate(k);
      }
    }, end() {
      caching = false;
      slices.clear();
      generations.clear();
      clearAll();
    } });
  } catch {
    caching = false;
  } // No commit feed means no invalidation: rebuild every row instead.

  let db: Database | undefined;
  try {
    db = conversationStorage(harness).db;
  } catch {} // Non-Luna storage: fall back to entry scans.

  const scanHead = async (tx: Tx, r: Pick<ConversationRecord, "id" | "parent">): Promise<RowHead> => {
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
    const delegateChild = ownHead.some((e) => e.kind === "delegate.child");
    return { firstUser, delegateChild, lastActivity: delegateChild ? null : await newestMessageTime(tx, r.id) };
  };

  const buildRow = async (tx: Tx, r: Pick<ConversationRecord, "id" | "parent">): Promise<SessionRow> => {
    const { firstUser, delegateChild, lastActivity } = db
      ? readRowHead(db, Number(r.id), r.parent ? Number(r.parent.at) : undefined)
      : await scanHead(tx, r);
    if (delegateChild)
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
    const recovery = running ? null : ((await opts.scheduledMessages?.recovery(tx, r.id)) ?? null);
    const scheduled = await opts.scheduledMessages?.summary(tx, Number(r.id));
    return {
      hidden: false,
      parent: r.parent ?? null,
      firstUser,
      running,
      ...(await readSessionStatus(tx, r.id, running)),
      wait: recovery?.resumeAt ?? null,
      recovery,
      scheduled,
      lastActivity,
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
        // Baseline for per-conversation invalidation. A slice already set by a newer write is kept; an older
        // baseline only makes the next diff invalidate more rows, never fewer.
        if (!slices.has("luna.scheduled-messages"))
          slices.set("luna.scheduled-messages", rowSlices("luna.scheduled-messages", await tx.doc(ScheduledMessagesDoc))!);
        if (!slices.has("luna.scheduled-recovery"))
          slices.set("luna.scheduled-recovery", rowSlices("luna.scheduled-recovery", await tx.doc(RecoveryStateDoc))!);
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
