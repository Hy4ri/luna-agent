import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  MailAccountStatus,
  MailAttachment,
  MailFolder,
  MailMessage,
  MailThreadDetail,
  MailThreadSummary,
} from "./types.js";

export class MailStore {
  readonly db: Database;

  constructor(dataDir: string) {
    const dbPath = join(dataDir, "mail.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        email TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        history_id TEXT,
        last_sync_at INTEGER,
        sync_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT NOT NULL,
        account_email TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        snippet TEXT NOT NULL DEFAULT '',
        participants_json TEXT NOT NULL DEFAULT '[]',
        label_ids_json TEXT NOT NULL DEFAULT '[]',
        unread INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        in_inbox INTEGER NOT NULL DEFAULT 0,
        in_sent INTEGER NOT NULL DEFAULT 0,
        is_draft INTEGER NOT NULL DEFAULT 0,
        in_trash INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 1,
        synced_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_email, id),
        FOREIGN KEY (account_email) REFERENCES accounts(email) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        account_email TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        from_addr TEXT NOT NULL DEFAULT '',
        to_addrs TEXT NOT NULL DEFAULT '',
        cc_addrs TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        date_ms INTEGER NOT NULL DEFAULT 0,
        snippet TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL DEFAULT '',
        label_ids_json TEXT NOT NULL DEFAULT '[]',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        message_id_header TEXT NOT NULL DEFAULT '',
        references_header TEXT NOT NULL DEFAULT '',
        is_unread INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_email, id),
        FOREIGN KEY (account_email, thread_id) REFERENCES threads(account_email, id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_threads_inbox ON threads (account_email, in_inbox, in_trash, last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_unread ON threads (account_email, unread, in_trash, last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_last ON threads (last_message_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (account_email, thread_id, date_ms ASC);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(email: string, displayName: string): void {
    const key = email.toLowerCase();
    this.db.prepare(`
      INSERT INTO accounts (email, display_name)
      VALUES (?, ?)
      ON CONFLICT(email) DO UPDATE SET display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE accounts.display_name END
    `).run(key, displayName);
  }

  removeAccount(email: string): void {
    this.db.prepare("DELETE FROM accounts WHERE email = ?").run(email.toLowerCase());
  }

  setSyncState(email: string, state: {
    syncStatus: "idle" | "syncing" | "error";
    historyId?: string | null;
    lastSyncAt?: number | null;
    lastError?: string | null;
  }): void {
    const key = email.toLowerCase();
    const sets: string[] = ["sync_status = ?"];
    const params: any[] = [state.syncStatus];
    if (state.historyId !== undefined) {
      sets.push("history_id = ?");
      params.push(state.historyId);
    }
    if (state.lastSyncAt !== undefined) {
      sets.push("last_sync_at = ?");
      params.push(state.lastSyncAt);
    }
    if (state.lastError !== undefined) {
      sets.push("last_error = ?");
      params.push(state.lastError);
    }
    params.push(key);
    this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE email = ?`).run(...params);
  }

  getAccount(email: string): MailAccountStatus | undefined {
    const key = email.toLowerCase();
    const row = this.db.prepare(`
      SELECT email, display_name, history_id, last_sync_at, sync_status, last_error
      FROM accounts WHERE email = ?
    `).get(key) as any;
    if (!row) return undefined;
    return {
      email: row.email,
      displayName: row.display_name || row.email,
      historyId: row.history_id ?? null,
      lastSyncAt: row.last_sync_at ?? null,
      syncStatus: (row.sync_status as "idle" | "syncing" | "error") ?? "idle",
      lastError: row.last_error ?? null,
      unreadCount: this.unreadCount(row.email),
    };
  }

  listAccounts(): MailAccountStatus[] {
    const rows = this.db.prepare(`
      SELECT email, display_name, history_id, last_sync_at, sync_status, last_error
      FROM accounts ORDER BY email ASC
    `).all() as any[];
    return rows.map((row) => ({
      email: row.email,
      displayName: row.display_name || row.email,
      historyId: row.history_id ?? null,
      lastSyncAt: row.last_sync_at ?? null,
      syncStatus: (row.sync_status as "idle" | "syncing" | "error") ?? "idle",
      lastError: row.last_error ?? null,
      unreadCount: this.unreadCount(row.email),
    }));
  }

  unreadCount(accountEmail?: string): number {
    if (accountEmail) {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM threads
        WHERE account_email = ? AND unread = 1 AND in_inbox = 1 AND in_trash = 0
      `).get(accountEmail.toLowerCase()) as { cnt: number };
      return row?.cnt ?? 0;
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM threads
      WHERE unread = 1 AND in_inbox = 1 AND in_trash = 0
    `).get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  upsertThread(thread: MailThreadSummary, messages: MailMessage[]): void {
    const accountKey = thread.accountEmail.toLowerCase();
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO threads (
          id, account_email, subject, snippet, participants_json, label_ids_json,
          unread, starred, in_inbox, in_sent, is_draft, in_trash,
          last_message_at, message_count, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_email, id) DO UPDATE SET
          subject = excluded.subject,
          snippet = excluded.snippet,
          participants_json = excluded.participants_json,
          label_ids_json = excluded.label_ids_json,
          unread = excluded.unread,
          starred = excluded.starred,
          in_inbox = excluded.in_inbox,
          in_sent = excluded.in_sent,
          is_draft = excluded.is_draft,
          in_trash = excluded.in_trash,
          last_message_at = excluded.last_message_at,
          message_count = excluded.message_count,
          synced_at = excluded.synced_at
      `).run(
        thread.id,
        accountKey,
        thread.subject,
        thread.snippet,
        JSON.stringify(thread.participants),
        JSON.stringify(thread.labelIds),
        thread.unread ? 1 : 0,
        thread.starred ? 1 : 0,
        thread.inInbox ? 1 : 0,
        thread.inSent ? 1 : 0,
        thread.isDraft ? 1 : 0,
        thread.inTrash ? 1 : 0,
        thread.lastMessageAt,
        thread.messageCount,
        now,
      );

      this.db.prepare("DELETE FROM messages WHERE account_email = ? AND thread_id = ?").run(accountKey, thread.id);

      const insertMsg = this.db.prepare(`
        INSERT INTO messages (
          id, account_email, thread_id, from_addr, to_addrs, cc_addrs, subject,
          date_ms, snippet, body_text, body_html, label_ids_json, attachments_json,
          message_id_header, references_header, is_unread
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of messages) {
        insertMsg.run(
          m.id,
          accountKey,
          thread.id,
          m.from,
          m.to,
          m.cc,
          m.subject,
          m.dateMs,
          m.snippet,
          m.bodyText,
          m.bodyHtml,
          JSON.stringify(m.labelIds),
          JSON.stringify(m.attachments),
          m.messageIdHeader,
          m.referencesHeader,
          m.unread ? 1 : 0,
        );
      }
    });
    tx();
  }

  deleteThread(accountEmail: string, threadId: string): void {
    this.db.prepare("DELETE FROM threads WHERE account_email = ? AND id = ?").run(accountEmail.toLowerCase(), threadId);
  }

  listThreads(opts: {
    accountEmail?: string;
    folder?: MailFolder;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}): { threads: MailThreadSummary[]; total: number } {
    const where: string[] = [];
    const params: any[] = [];

    if (opts.accountEmail) {
      where.push("t.account_email = ?");
      params.push(opts.accountEmail.toLowerCase());
    }

    const folder = opts.folder ?? "INBOX";
    if (folder === "INBOX") {
      where.push("t.in_inbox = 1 AND t.in_trash = 0");
    } else if (folder === "UNREAD") {
      where.push("t.unread = 1 AND t.in_trash = 0");
    } else if (folder === "STARRED") {
      where.push("t.starred = 1 AND t.in_trash = 0");
    } else if (folder === "SENT") {
      where.push("t.in_sent = 1 AND t.in_trash = 0");
    } else if (folder === "DRAFT") {
      where.push("t.is_draft = 1 AND t.in_trash = 0");
    } else if (folder === "TRASH") {
      where.push("t.in_trash = 1");
    } else if (folder === "ALL") {
      where.push("t.in_trash = 0");
    }

    if (opts.q?.trim()) {
      const like = `%${opts.q.trim().toLowerCase()}%`;
      where.push(`(
        lower(t.subject) LIKE ? OR
        lower(t.snippet) LIKE ? OR
        lower(t.participants_json) LIKE ? OR
        EXISTS (
          SELECT 1 FROM messages m
          WHERE m.account_email = t.account_email AND m.thread_id = t.id
          AND (lower(m.body_text) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.to_addrs) LIKE ?)
        )
      )`);
      params.push(like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM threads t ${whereSql}`).get(...params) as { cnt: number };

    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);

    const rows = this.db.prepare(`
      SELECT t.* FROM threads t
      ${whereSql}
      ORDER BY t.last_message_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      threads: rows.map(rowToThreadSummary),
      total: countRow?.cnt ?? 0,
    };
  }

  getThread(accountEmail: string, threadId: string): MailThreadDetail | undefined {
    const key = accountEmail.toLowerCase();
    const row = this.db.prepare("SELECT * FROM threads WHERE account_email = ? AND id = ?").get(key, threadId) as any;
    if (!row) return undefined;
    const msgRows = this.db.prepare(`
      SELECT * FROM messages WHERE account_email = ? AND thread_id = ?
      ORDER BY date_ms ASC
    `).all(key, threadId) as any[];
    return {
      ...rowToThreadSummary(row),
      messages: msgRows.map(rowToMessage),
    };
  }

  findThreadById(threadId: string): MailThreadDetail | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ? LIMIT 1").get(threadId) as any;
    if (!row) return undefined;
    return this.getThread(row.account_email, threadId);
  }

  applyLabelMutation(accountEmail: string, threadId: string, addLabels: string[], removeLabels: string[]): MailThreadSummary | undefined {
    const key = accountEmail.toLowerCase();
    const existing = this.db.prepare("SELECT * FROM threads WHERE account_email = ? AND id = ?").get(key, threadId) as any;
    if (!existing) return undefined;

    const labels = new Set<string>(safeJsonArray<string>(existing.label_ids_json));
    for (const l of addLabels) labels.add(l);
    for (const l of removeLabels) labels.delete(l);

    const arr = [...labels];
    const unread = labels.has("UNREAD") ? 1 : 0;
    const starred = labels.has("STARRED") ? 1 : 0;
    const inInbox = labels.has("INBOX") ? 1 : 0;
    const inSent = labels.has("SENT") ? 1 : 0;
    const isDraft = labels.has("DRAFT") ? 1 : 0;
    const inTrash = labels.has("TRASH") ? 1 : 0;

    this.db.prepare(`
      UPDATE threads
      SET label_ids_json = ?, unread = ?, starred = ?, in_inbox = ?, in_sent = ?, is_draft = ?, in_trash = ?
      WHERE account_email = ? AND id = ?
    `).run(JSON.stringify(arr), unread, starred, inInbox, inSent, isDraft, inTrash, key, threadId);

    if (addLabels.includes("UNREAD") || removeLabels.includes("UNREAD")) {
      this.db.prepare("UPDATE messages SET is_unread = ? WHERE account_email = ? AND thread_id = ?").run(unread, key, threadId);
    }

    const updated = this.db.prepare("SELECT * FROM threads WHERE account_email = ? AND id = ?").get(key, threadId) as any;
    return updated ? rowToThreadSummary(updated) : undefined;
  }
}

function safeJsonArray<T>(raw: string | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rowToThreadSummary(row: any): MailThreadSummary {
  return {
    id: row.id,
    accountEmail: row.account_email,
    subject: row.subject || "(no subject)",
    snippet: row.snippet || "",
    participants: safeJsonArray<string>(row.participants_json),
    labelIds: safeJsonArray<string>(row.label_ids_json),
    unread: Boolean(row.unread),
    starred: Boolean(row.starred),
    inInbox: Boolean(row.in_inbox),
    inSent: Boolean(row.in_sent),
    isDraft: Boolean(row.is_draft),
    inTrash: Boolean(row.in_trash),
    lastMessageAt: Number(row.last_message_at || 0),
    messageCount: Number(row.message_count || 1),
  };
}

function rowToMessage(row: any): MailMessage {
  return {
    id: row.id,
    accountEmail: row.account_email,
    threadId: row.thread_id,
    from: row.from_addr || "",
    to: row.to_addrs || "",
    cc: row.cc_addrs || "",
    subject: row.subject || "(no subject)",
    dateMs: Number(row.date_ms || 0),
    snippet: row.snippet || "",
    bodyText: row.body_text || "",
    bodyHtml: row.body_html || "",
    labelIds: safeJsonArray<string>(row.label_ids_json),
    attachments: safeJsonArray<MailAttachment>(row.attachments_json),
    messageIdHeader: row.message_id_header || "",
    referencesHeader: row.references_header || "",
    unread: Boolean(row.is_unread),
  };
}
