// Durable at-most-once admission for background slash commands. Some commands have
// effects outside a harness transaction, so an interrupted admission must not be replayed.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface BackgroundCommandReceipt {
  state: "pending" | "done";
  status?: number;
  result?: unknown;
}
export class BackgroundCommandStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_background_commands (
      session_id INTEGER NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status INTEGER, result TEXT, PRIMARY KEY(session_id, request_id)
    ) STRICT;`);
  }
  read(session: number, request: string): BackgroundCommandReceipt | undefined {
    const row = this.db.prepare("SELECT status,result FROM luna_background_commands WHERE session_id=? AND request_id=?")
      .get(session, request) as { status: number | null; result: string | null } | undefined;
    return row ? row.status === null ? { state: "pending" }
      : { state: "done", status: row.status, result: JSON.parse(row.result!) } : undefined;
  }
  /** Called on the harness mutation line. False means never execute this identity again. */
  claim(session: number, request: string, content: unknown): boolean {
    const fingerprint = createHash("sha256").update(JSON.stringify(content, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    const prior = this.db.prepare("SELECT fingerprint FROM luna_background_commands WHERE session_id=? AND request_id=?")
      .get(session, request) as { fingerprint: string } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("conflicting requestId reuse");
      return false;
    }
    this.db.prepare("INSERT INTO luna_background_commands(session_id,request_id,fingerprint) VALUES (?,?,?)")
      .run(session, request, fingerprint);
    return true;
  }
  finish(session: number, request: string, status: number, result: unknown): void {
    this.db.prepare("UPDATE luna_background_commands SET status=?,result=? WHERE session_id=? AND request_id=?")
      .run(status, JSON.stringify(result), session, request);
  }
}
