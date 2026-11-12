// Lightweight index of every user message in a conversation, including entries inherited from fork parents.
// Reads SQLite directly: the luna_entries_by_conversation_kind index lets SQLite skip the large assistant,
// tool-result, and system records without parsing them, so only the few candidate records are read.
import type { Database } from "bun:sqlite";

/** Entry kinds whose model messages are never user messages. All other kinds are checked. */
const NON_USER_KINDS = ["pi.assistant", "pi.tool-result", "pi.system"] as const;
const LABEL_MAX = 80;

export type UserMessageLabel = { id: number; label: string };

export type Segment = { conversationId: number; upper?: number };

/** Fork chain from the conversation to its root. Each parent segment ends at its fork point. */
export function segments(db: Database, conversationId: number): Segment[] {
  const read = db.query<{ parent: string | null }, [number]>("SELECT json_extract(record, '$.parent') AS parent FROM conversations WHERE id = ?");
  const out: Segment[] = [];
  let current: Segment | undefined = { conversationId };
  for (let guard = 0; current && guard < 1000; guard++) {
    out.push(current);
    const row = read.get(current.conversationId);
    const parent = row?.parent ? JSON.parse(row.parent) as { conversationId: number; at: number } : undefined;
    if (!parent) break;
    const at: number = current.upper === undefined ? Number(parent.at) : Math.min(current.upper, Number(parent.at));
    current = { conversationId: Number(parent.conversationId), upper: at };
  }
  return out.reverse();
}

function label(entry: { kind?: string; model?: unknown[] }): string | undefined {
  const user = (entry.model ?? []).find((m: any) => m?.role === "user") as any;
  if (!user) return undefined;
  const text = (typeof user.content === "string" ? user.content
    : Array.isArray(user.content) ? user.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "")
    .replace(/\s+/g, " ").trim();
  if (entry.kind === "pi.user" && /^Background process [a-f0-9-]+ finished:/.test(text)) return undefined;
  return text.length > LABEL_MAX ? text.slice(0, LABEL_MAX) + "…" : text || "Message";
}

/** User message labels, oldest first. */
export function userMessageLabels(db: Database, conversationId: number): UserMessageLabel[] {
  // Two steps, because the planner is not reliable here. Step 1 reads only the covering kind index, never a
  // record (0.1 ms on a 33 MB session). A combined query that also reads `model`, or one with bound kind
  // parameters, made SQLite pick the id index and parse every record (20 ms). Step 2 reads the few candidates
  // by primary key. Kinds are literal constants so the planner can match the indexed expression.
  const kinds = NON_USER_KINDS.map(kind => `'${kind}'`).join(", ");
  const candidates = db.query<{ id: number; kind: string | null }, [number]>(
    `SELECT id, json_extract(record, '$.kind') AS kind FROM entries
     WHERE conversation_id = ? AND json_extract(record, '$.kind') NOT IN (${kinds})`);
  const model = db.query<{ model: string | null }, [number]>("SELECT json_extract(record, '$.model') AS model FROM entries WHERE id = ?");
  const out: UserMessageLabel[] = [];
  for (const segment of segments(db, conversationId)) {
    const rows = candidates.all(segment.conversationId)
      .filter(row => segment.upper === undefined || row.id <= segment.upper)
      .sort((a, b) => a.id - b.id);
    for (const row of rows) {
      const raw = model.get(row.id)?.model;
      if (!raw) continue;
      const text = label({ kind: row.kind ?? undefined, model: JSON.parse(raw) });
      if (text !== undefined) out.push({ id: Number(row.id), label: text });
    }
  }
  return out;
}
