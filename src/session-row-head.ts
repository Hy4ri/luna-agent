// Session list row inputs read from SQLite indexes instead of full records.
// buildRow used to parse the first 30 entries and the newest ones of every session (83 MB of JSON for 493
// sessions) on a cold list. The covering luna_entries_by_conversation_kind index gives ids and kinds without
// reading records; only the one or two records that matter are then read by primary key.
import type { Database } from "bun:sqlite";
import { segments } from "./user-messages.js";
import { kindIndexReady, KIND_INDEX } from "./kind-index.js";
import { textOf } from "./routes/context.js";

const HEAD = 30;
const USER_KINDS = new Set(["pi.user", "luna.scheduled-message"]);

/** Entry kind that keeps a top-level conversation out of the session list, e.g. runs of a hidden cron job. */
export const HIDDEN_SESSION = "luna.hidden-session";

/** True for head entries that keep a row out of the session list: subagent markers and the hidden-session marker. */
export const hidesRow = (kind: string | null | undefined) => kind === "delegate.child" || kind === HIDDEN_SESSION;

export type RowHead = { firstUser: string; hidden: boolean; lastActivity: number | null };

export function readRowHead(db: Database, conversationId: number, parentAt?: number): RowHead {
  const index = db.query<{ id: number; kind: string | null }, [number]>(
    `SELECT id, json_extract(record, '$.kind') AS kind FROM entries ${kindIndexReady(db) ? `INDEXED BY ${KIND_INDEX}` : ''} WHERE conversation_id = ?`);
  const model = db.query<{ model: string | null }, [number]>("SELECT json_extract(record, '$.model') AS model FROM entries WHERE id = ?");
  const readModel = (id: number): unknown[] => {
    const raw = model.get(id)?.model;
    return raw ? (JSON.parse(raw) as unknown[]) : [];
  };
  // Same stream as tx.scanEntries: fork ancestors up to their fork point, then the conversation itself.
  const all: { id: number; kind: string | null }[] = [];
  for (const segment of segments(db, conversationId)) {
    const rows = index.all(segment.conversationId).filter(row => segment.upper === undefined || row.id <= segment.upper);
    rows.sort((a, b) => a.id - b.id);
    for (const row of rows) all.push(row);
  }
  const head = all.slice(0, HEAD);
  const first = head.find(row => row.kind !== null && USER_KINDS.has(row.kind));
  const firstUser = first ? textOf({ model: readModel(first.id) }).replace(/\s+/g, " ").slice(0, 60) : "";
  const own = parentAt === undefined ? head : all.filter(row => row.id > parentAt).slice(0, HEAD);
  const hidden = own.some(row => hidesRow(row.kind));
  return { firstUser, hidden, lastActivity: hidden ? null : newest(all, readModel) };
}

/** Same result as newestMessageTime: the newest user or assistant message timestamp. */
function newest(all: { id: number; kind: string | null }[], readModel: (id: number) => unknown[]): number | null {
  for (let i = all.length - 1; i >= 0; i--) {
    const kind = all[i]!.kind;
    const role = kind === "pi.user" || kind === "luna.scheduled-message" || kind === "luna.xsession.msg" ? "user" : kind === "pi.assistant" ? "assistant" : null;
    if (!role) continue;
    let timestamp: number | null = null;
    for (const message of readModel(all[i]!.id) as { role?: string; timestamp?: number }[]) {
      if (message?.role !== role || !Number.isFinite(message.timestamp) || message.timestamp! < 0) continue;
      timestamp = Math.max(timestamp ?? 0, message.timestamp!);
    }
    if (timestamp !== null) return timestamp;
  }
  return null;
}
