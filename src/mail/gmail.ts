import type { MailAuthStore } from "./auth.js";
import { base64UrlDecode, extractGmailParts, headerValue, parseParticipants, type GmailMessagePart } from "./mime.js";
import { MailError, type MailMessage, type MailThreadSummary } from "./types.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailRawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface GmailRawThread {
  id: string;
  historyId?: string;
  messages?: GmailRawMessage[];
}

export function parseGmailThread(accountEmail: string, raw: GmailRawThread): {
  summary: MailThreadSummary;
  messages: MailMessage[];
  historyId?: string;
} {
  const rawMessages = raw.messages ?? [];
  const messages: MailMessage[] = rawMessages.map((m) => {
    const headers = m.payload?.headers;
    const from = headerValue(headers, "From");
    const to = headerValue(headers, "To");
    const cc = headerValue(headers, "Cc");
    const subject = headerValue(headers, "Subject") || "(no subject)";
    const messageIdHeader = headerValue(headers, "Message-ID") || headerValue(headers, "Message-Id");
    const referencesHeader = headerValue(headers, "References");
    const dateMs = m.internalDate ? Number(m.internalDate) : Date.parse(headerValue(headers, "Date")) || Date.now();
    const labelIds = m.labelIds ?? [];
    const { bodyText, bodyHtml, attachments } = extractGmailParts(m.payload);
    return {
      id: m.id,
      accountEmail: accountEmail.toLowerCase(),
      threadId: raw.id,
      from,
      to,
      cc,
      subject,
      dateMs,
      snippet: decodeHtmlEntities(m.snippet ?? ""),
      bodyText,
      bodyHtml,
      labelIds,
      attachments,
      messageIdHeader,
      referencesHeader,
      unread: labelIds.includes("UNREAD"),
    };
  });

  messages.sort((a, b) => a.dateMs - b.dateMs);

  const labelSet = new Set<string>();
  const participantSet = new Set<string>();
  const participants: string[] = [];
  for (const m of messages) {
    for (const l of m.labelIds) labelSet.add(l);
    for (const p of parseParticipants(m.from, m.to)) {
      if (!participantSet.has(p.toLowerCase())) {
        participantSet.add(p.toLowerCase());
        participants.push(p);
      }
    }
  }

  const last = messages[messages.length - 1];
  const first = messages[0];
  const labelIds = [...labelSet];

  const summary: MailThreadSummary = {
    id: raw.id,
    accountEmail: accountEmail.toLowerCase(),
    subject: first?.subject || last?.subject || "(no subject)",
    snippet: last?.snippet || first?.snippet || "",
    participants,
    labelIds,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
    inInbox: labelIds.includes("INBOX"),
    inSent: labelIds.includes("SENT"),
    isDraft: labelIds.includes("DRAFT"),
    inTrash: labelIds.includes("TRASH"),
    lastMessageAt: last?.dateMs ?? Date.now(),
    messageCount: messages.length,
  };

  return { summary, messages, historyId: raw.historyId };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export class GmailClient {
  private readonly auth: MailAuthStore;
  private readonly fetchImpl: typeof fetch;

  constructor(auth: MailAuthStore, fetchImpl: typeof fetch = fetch) {
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  private async request<T>(email: string, path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await this.auth.getAccessToken(email, retried);
    const res = await this.fetchImpl(`${GMAIL_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401 && !retried) {
      return this.request<T>(email, path, init, true);
    }

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      const msg = errBody?.error?.message || `Gmail API error (${res.status})`;
      const status = (res.status === 404 ? 404 : res.status === 403 ? 403 : res.status === 401 ? 401 : res.status === 400 ? 400 : 502) as MailError["status"];
      throw new MailError(msg, status);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getProfile(email: string): Promise<{ emailAddress: string; historyId?: string }> {
    return this.request(email, "/profile");
  }

  async listThreads(email: string, opts: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string } = {}): Promise<{
    threads?: Array<{ id: string; historyId?: string; snippet?: string }>;
    nextPageToken?: string;
  }> {
    const params = new URLSearchParams();
    if (opts.q?.trim()) params.set("q", opts.q.trim());
    if (opts.maxResults) params.set("maxResults", String(opts.maxResults));
    if (opts.pageToken) params.set("pageToken", opts.pageToken);
    for (const l of opts.labelIds ?? []) params.append("labelIds", l);
    const qs = params.toString();
    return this.request(email, `/threads${qs ? `?${qs}` : ""}`);
  }

  async getThread(email: string, threadId: string): Promise<GmailRawThread> {
    return this.request(email, `/threads/${encodeURIComponent(threadId)}?format=full`);
  }

  async listHistory(email: string, startHistoryId: string, pageToken?: string): Promise<{
    history?: Array<{
      id?: string;
      messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
      messagesDeleted?: Array<{ message?: { id?: string; threadId?: string } }>;
      labelsAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
      labelsRemoved?: Array<{ message?: { id?: string; threadId?: string } }>;
    }>;
    historyId?: string;
    nextPageToken?: string;
  }> {
    const params = new URLSearchParams({ startHistoryId });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request(email, `/history?${params.toString()}`);
  }

  async modifyThread(email: string, threadId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.request(email, `/threads/${encodeURIComponent(threadId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  async trashThread(email: string, threadId: string): Promise<void> {
    await this.request(email, `/threads/${encodeURIComponent(threadId)}/trash`, {
      method: "POST",
    });
  }

  async untrashThread(email: string, threadId: string): Promise<void> {
    await this.request(email, `/threads/${encodeURIComponent(threadId)}/untrash`, {
      method: "POST",
    });
  }

  async sendMessage(email: string, raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
    return this.request(email, "/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    });
  }

  async createDraft(email: string, raw: string, threadId?: string): Promise<{ id: string; message?: { id: string; threadId: string } }> {
    return this.request(email, "/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
    });
  }

  async getAttachment(email: string, messageId: string, attachmentId: string): Promise<Buffer> {
    const res = await this.request<{ data?: string }>(
      email,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return base64UrlDecode(res.data ?? "");
  }
}
