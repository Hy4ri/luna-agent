import { MailAuthStore, parseGoogleCredentialsInput, type StoredAccountAuth } from "./auth.js";
import { GmailClient, parseGmailThread } from "./gmail.js";
import { buildRawMime } from "./mime.js";
import { MailStore } from "./store.js";
import {
  MailError,
  type MailFolder,
  type MailStatus,
  type MailThreadDetail,
  type MailThreadSummary,
} from "./types.js";

export type MailModifyAction =
  | "archive"
  | "unarchive"
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar"
  | "trash"
  | "untrash";

export interface MailSyncResult {
  email: string;
  syncedThreads: number;
  mode: "incremental" | "full";
}

export class MailService {
  readonly auth: MailAuthStore;
  readonly store: MailStore;
  readonly gmail: GmailClient;
  private readonly log: (msg: string) => void;
  private syncing = new Map<string, Promise<MailSyncResult>>();

  constructor(opts: { dataDir: string; fetch?: typeof fetch; log?: (msg: string) => void }) {
    this.log = opts.log ?? (() => {});
    this.auth = new MailAuthStore(opts.dataDir, opts.fetch);
    this.store = new MailStore(opts.dataDir);
    this.gmail = new GmailClient(this.auth, opts.fetch);
    for (const acc of this.auth.listAccounts()) {
      this.store.upsertAccount(acc.email, acc.displayName);
      this.store.setSyncState(acc.email, { syncStatus: "idle" });
    }
  }

  close(): void {
    this.store.close();
  }

  status(): MailStatus {
    const accounts = this.store.listAccounts();
    return {
      oauthConfigured: this.auth.hasOAuthClient(),
      accounts,
      unreadTotal: this.store.unreadCount(),
    };
  }

  configureOAuth(input: { clientId?: string; clientSecret?: string; credentialsJson?: string }): void {
    const cfg = parseGoogleCredentialsInput(input);
    this.auth.setOAuthClient(cfg);
  }

  startOAuth(redirectUri: string): { url: string; state: string; redirectUri: string } {
    return this.auth.startOAuth(redirectUri);
  }

  async finishOAuth(code: string, state: string): Promise<StoredAccountAuth> {
    const account = await this.auth.finishOAuth(code, state);
    this.store.upsertAccount(account.email, account.displayName);
    // Kick off initial sync in the background so the redirect returns immediately.
    void this.syncAccount(account.email, { full: true }).catch((e) => {
      this.log(`initial mail sync failed for ${account.email}: ${e instanceof Error ? e.message : String(e)}`);
    });
    return account;
  }

  removeAccount(email: string): boolean {
    const removed = this.auth.removeAccount(email);
    this.store.removeAccount(email);
    return removed;
  }

  private resolveAccountEmail(accountEmail?: string): string {
    if (accountEmail?.trim()) {
      const key = accountEmail.trim().toLowerCase();
      if (!this.auth.getAccount(key)) throw new MailError(`Mail account not connected: ${accountEmail}`, 404);
      return key;
    }
    const accounts = this.auth.listAccounts();
    if (accounts.length === 0) throw new MailError("No Gmail account connected", 400);
    return accounts[0]!.email;
  }

  async syncAll(opts: { full?: boolean } = {}): Promise<MailSyncResult[]> {
    const accounts = this.auth.listAccounts();
    return Promise.all(accounts.map((a) => this.syncAccount(a.email, opts)));
  }

  syncAccount(email: string, opts: { full?: boolean; maxResults?: number } = {}): Promise<MailSyncResult> {
    const key = this.resolveAccountEmail(email);
    const existing = this.syncing.get(key);
    if (existing) return existing;

    const p = this.runSync(key, opts).finally(() => {
      this.syncing.delete(key);
    });
    this.syncing.set(key, p);
    return p;
  }

  private async runSync(email: string, opts: { full?: boolean; maxResults?: number }): Promise<MailSyncResult> {
    this.store.setSyncState(email, { syncStatus: "syncing", lastError: null });
    try {
      const acc = this.store.getAccount(email);
      const historyId = !opts.full ? acc?.historyId : null;
      if (historyId) {
        try {
          const result = await this.incrementalSync(email, historyId);
          this.store.setSyncState(email, {
            syncStatus: "idle",
            lastSyncAt: Date.now(),
            lastError: null,
          });
          return result;
        } catch (e) {
          // Gmail returns 404 when historyId is too old; fall back to full sync.
          if (!(e instanceof MailError) || e.status !== 404) throw e;
        }
      }

      const result = await this.fullSync(email, opts.maxResults ?? 40);
      this.store.setSyncState(email, {
        syncStatus: "idle",
        lastSyncAt: Date.now(),
        lastError: null,
      });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.store.setSyncState(email, { syncStatus: "error", lastError: msg });
      throw e;
    }
  }

  private async incrementalSync(email: string, startHistoryId: string): Promise<MailSyncResult> {
    const changedThreadIds = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;

    do {
      const page = await this.gmail.listHistory(email, startHistoryId, pageToken);
      if (page.historyId) latestHistoryId = page.historyId;
      for (const h of page.history ?? []) {
        for (const item of h.messagesAdded ?? []) if (item.message?.threadId) changedThreadIds.add(item.message.threadId);
        for (const item of h.messagesDeleted ?? []) if (item.message?.threadId) changedThreadIds.add(item.message.threadId);
        for (const item of h.labelsAdded ?? []) if (item.message?.threadId) changedThreadIds.add(item.message.threadId);
        for (const item of h.labelsRemoved ?? []) if (item.message?.threadId) changedThreadIds.add(item.message.threadId);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    const ids = [...changedThreadIds];
    await this.fetchAndStoreThreads(email, ids);
    this.store.setSyncState(email, { syncStatus: "syncing", historyId: latestHistoryId });
    return { email, syncedThreads: ids.length, mode: "incremental" };
  }

  private async fullSync(email: string, maxResults: number): Promise<MailSyncResult> {
    const [profile, list] = await Promise.all([
      this.gmail.getProfile(email),
      this.gmail.listThreads(email, { maxResults }),
    ]);
    const ids = (list.threads ?? []).map((t) => t.id);
    await this.fetchAndStoreThreads(email, ids);
    if (profile.historyId) {
      this.store.setSyncState(email, { syncStatus: "syncing", historyId: profile.historyId });
    }
    return { email, syncedThreads: ids.length, mode: "full" };
  }

  private async fetchAndStoreThreads(email: string, threadIds: string[]): Promise<number> {
    let count = 0;
    const batchSize = 5;
    for (let i = 0; i < threadIds.length; i += batchSize) {
      const batch = threadIds.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (id) => {
          try {
            const raw = await this.gmail.getThread(email, id);
            if (!raw.messages || raw.messages.length === 0) {
              this.store.deleteThread(email, id);
              return;
            }
            const parsed = parseGmailThread(email, raw);
            this.store.upsertThread(parsed.summary, parsed.messages);
            count++;
          } catch (e) {
            if (e instanceof MailError && e.status === 404) {
              this.store.deleteThread(email, id);
              return;
            }
            throw e;
          }
        }),
      );
    }
    return count;
  }

  listThreads(opts: {
    accountEmail?: string;
    folder?: MailFolder;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}): { threads: MailThreadSummary[]; total: number } {
    return this.store.listThreads(opts);
  }

  async searchRemote(opts: { accountEmail?: string; q: string; maxResults?: number }): Promise<MailThreadSummary[]> {
    const email = this.resolveAccountEmail(opts.accountEmail);
    const list = await this.gmail.listThreads(email, { q: opts.q, maxResults: opts.maxResults ?? 20 });
    const ids = (list.threads ?? []).map((t) => t.id);
    if (ids.length > 0) await this.fetchAndStoreThreads(email, ids);
    return this.store.listThreads({ accountEmail: email, folder: "ALL", q: opts.q, limit: opts.maxResults ?? 20 }).threads;
  }

  async getThread(threadId: string, accountEmail?: string): Promise<MailThreadDetail> {
    if (accountEmail) {
      const local = this.store.getThread(accountEmail, threadId);
      if (local) return local;
      await this.fetchAndStoreThreads(accountEmail.toLowerCase(), [threadId]);
      const fetched = this.store.getThread(accountEmail, threadId);
      if (!fetched) throw new MailError("Thread not found", 404);
      return fetched;
    }
    const local = this.store.findThreadById(threadId);
    if (local) return local;
    const accounts = this.auth.listAccounts();
    for (const acc of accounts) {
      try {
        await this.fetchAndStoreThreads(acc.email, [threadId]);
        const fetched = this.store.getThread(acc.email, threadId);
        if (fetched) return fetched;
      } catch {}
    }
    throw new MailError("Thread not found", 404);
  }

  async modifyThread(threadId: string, action: MailModifyAction, accountEmail?: string): Promise<MailThreadSummary> {
    const thread = await this.getThread(threadId, accountEmail);
    const email = thread.accountEmail;

    if (action === "trash") {
      await this.gmail.trashThread(email, threadId);
      return this.store.applyLabelMutation(email, threadId, ["TRASH"], ["INBOX"]) ?? thread;
    }
    if (action === "untrash") {
      await this.gmail.untrashThread(email, threadId);
      return this.store.applyLabelMutation(email, threadId, ["INBOX"], ["TRASH"]) ?? thread;
    }

    const add: string[] = [];
    const remove: string[] = [];
    if (action === "archive") remove.push("INBOX");
    else if (action === "unarchive") add.push("INBOX");
    else if (action === "markRead") remove.push("UNREAD");
    else if (action === "markUnread") add.push("UNREAD");
    else if (action === "star") add.push("STARRED");
    else if (action === "unstar") remove.push("STARRED");

    await this.gmail.modifyThread(email, threadId, add, remove);
    return this.store.applyLabelMutation(email, threadId, add, remove) ?? thread;
  }

  private async buildOutgoingRaw(input: {
    accountEmail?: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text: string;
    html?: string;
    replyToThreadId?: string;
  }): Promise<{ resolvedEmail: string; raw: string }> {
    let email = input.accountEmail?.trim().toLowerCase();
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let subject = input.subject.trim();

    if (input.replyToThreadId) {
      const thread = await this.getThread(input.replyToThreadId, email);
      email = thread.accountEmail;
      const last = thread.messages[thread.messages.length - 1];
      if (last?.messageIdHeader) {
        inReplyTo = last.messageIdHeader;
        references = [last.referencesHeader, last.messageIdHeader].filter(Boolean).join(" ").trim();
      }
      if (!subject) {
        subject = thread.subject.toLowerCase().startsWith("re:") ? thread.subject : `Re: ${thread.subject}`;
      }
    }

    const resolvedEmail = this.resolveAccountEmail(email);
    const account = this.auth.getAccount(resolvedEmail);
    const from = account?.displayName && account.displayName !== resolvedEmail
      ? `"${account.displayName.replace(/"/g, "")}" <${resolvedEmail}>`
      : resolvedEmail;

    const raw = buildRawMime({
      from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: subject || "(no subject)",
      text: input.text,
      html: input.html,
      inReplyTo,
      references,
    });
    return { resolvedEmail, raw };
  }

  async sendMessage(input: {
    accountEmail?: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text: string;
    html?: string;
    replyToThreadId?: string;
  }): Promise<{ id: string; threadId: string; accountEmail: string }> {
    const { resolvedEmail, raw } = await this.buildOutgoingRaw(input);
    const sent = await this.gmail.sendMessage(resolvedEmail, raw, input.replyToThreadId);
    // Sync the thread so the sent message appears immediately in the UI.
    void this.fetchAndStoreThreads(resolvedEmail, [sent.threadId]).catch(() => {});
    return { id: sent.id, threadId: sent.threadId, accountEmail: resolvedEmail };
  }

  async saveDraft(input: {
    accountEmail?: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text: string;
    html?: string;
    replyToThreadId?: string;
  }): Promise<{ draftId: string; messageId?: string; threadId?: string; accountEmail: string }> {
    const { resolvedEmail, raw } = await this.buildOutgoingRaw(input);
    const draft = await this.gmail.createDraft(resolvedEmail, raw, input.replyToThreadId);
    if (draft.message?.threadId) {
      void this.fetchAndStoreThreads(resolvedEmail, [draft.message.threadId]).catch(() => {});
    }
    return {
      draftId: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      accountEmail: resolvedEmail,
    };
  }

  async getAttachment(accountEmail: string, messageId: string, attachmentId: string): Promise<Buffer> {
    const email = this.resolveAccountEmail(accountEmail);
    return this.gmail.getAttachment(email, messageId, attachmentId);
  }
}
