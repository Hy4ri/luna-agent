export type MailFolder = "INBOX" | "UNREAD" | "STARRED" | "SENT" | "DRAFT" | "TRASH" | "ALL";

export interface MailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  inline?: boolean;
}

export interface MailMessage {
  id: string;
  accountEmail: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  dateMs: number;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  labelIds: string[];
  attachments: MailAttachment[];
  messageIdHeader: string;
  referencesHeader: string;
  unread: boolean;
}

export interface MailThreadSummary {
  id: string;
  accountEmail: string;
  subject: string;
  snippet: string;
  participants: string[];
  labelIds: string[];
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  inSent: boolean;
  isDraft: boolean;
  inTrash: boolean;
  lastMessageAt: number;
  messageCount: number;
}

export interface MailThreadDetail extends MailThreadSummary {
  messages: MailMessage[];
}

export interface MailAccountStatus {
  email: string;
  displayName: string;
  historyId: string | null;
  lastSyncAt: number | null;
  syncStatus: "idle" | "syncing" | "error";
  lastError: string | null;
  unreadCount: number;
}

export interface MailStatus {
  oauthConfigured: boolean;
  accounts: MailAccountStatus[];
  unreadTotal: number;
}

export type MailHttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503 | 504;

export class MailError extends Error {
  readonly status: MailHttpStatus;
  constructor(message: string, status: MailHttpStatus = 500) {
    super(message);
    this.name = "MailError";
    this.status = status;
  }
}
