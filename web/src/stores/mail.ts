import { reactive, ref } from "vue";
import { api, serverUrl, token } from "@/lib/api";
import type {
  MailFolder,
  MailStatus,
  MailThreadDetail,
  MailThreadSummary,
} from "../../../src/mail/types";

export type { MailFolder, MailStatus, MailThreadDetail, MailThreadSummary };

export const mailUnreadTotal = ref(0);

export const mailState = reactive({
  status: null as MailStatus | null,
  threads: [] as MailThreadSummary[],
  total: 0,
  selectedAccount: "" as string,
  folder: "INBOX" as MailFolder,
  query: "",
  selectedThreadId: null as string | null,
  detail: null as MailThreadDetail | null,
  loadingStatus: false,
  loadingThreads: false,
  loadingDetail: false,
  syncing: false,
  error: null as string | null,
});

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function loadMailStatus(): Promise<MailStatus | null> {
  mailState.loadingStatus = true;
  try {
    const res = await api("/v1/mail/status");
    const data = await readJson<MailStatus>(res);
    mailState.status = data;
    mailUnreadTotal.value = data.unreadTotal;
    return data;
  } catch (e) {
    mailState.error = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    mailState.loadingStatus = false;
  }
}

export async function loadMailThreads(opts: { remote?: boolean } = {}): Promise<void> {
  mailState.loadingThreads = true;
  mailState.error = null;
  try {
    const params = new URLSearchParams({
      folder: mailState.folder,
      limit: "50",
    });
    if (mailState.selectedAccount) params.set("accountEmail", mailState.selectedAccount);
    if (mailState.query.trim()) params.set("q", mailState.query.trim());
    if (opts.remote && mailState.query.trim()) params.set("remote", "1");

    const res = await api(`/v1/mail/threads?${params.toString()}`, {
      timeoutMs: opts.remote ? 30_000 : 15_000,
    });
    const data = await readJson<{ threads: MailThreadSummary[]; total: number }>(res);
    mailState.threads = data.threads;
    mailState.total = data.total;
  } catch (e) {
    mailState.error = e instanceof Error ? e.message : String(e);
  } finally {
    mailState.loadingThreads = false;
  }
}

export async function openMailThread(threadId: string, accountEmail?: string): Promise<void> {
  mailState.selectedThreadId = threadId;
  mailState.loadingDetail = true;
  mailState.error = null;
  try {
    const qs = accountEmail ? `?accountEmail=${encodeURIComponent(accountEmail)}` : "";
    const res = await api(`/v1/mail/threads/${encodeURIComponent(threadId)}${qs}`);
    const detail = await readJson<MailThreadDetail>(res);
    mailState.detail = detail;
    if (detail.unread) {
      void modifyMailThread(detail.id, "markRead", detail.accountEmail);
    }
  } catch (e) {
    mailState.error = e instanceof Error ? e.message : String(e);
  } finally {
    mailState.loadingDetail = false;
  }
}

export async function syncMail(full = false): Promise<void> {
  mailState.syncing = true;
  mailState.error = null;
  try {
    const res = await api("/v1/mail/sync", {
      method: "POST",
      body: JSON.stringify({
        ...(mailState.selectedAccount ? { accountEmail: mailState.selectedAccount } : {}),
        full,
      }),
      timeoutMs: 60_000,
    });
    const data = await readJson<{ status: MailStatus }>(res);
    mailState.status = data.status;
    mailUnreadTotal.value = data.status.unreadTotal;
    await loadMailThreads();
    if (mailState.selectedThreadId) {
      await openMailThread(mailState.selectedThreadId, mailState.detail?.accountEmail);
    }
  } catch (e) {
    mailState.error = e instanceof Error ? e.message : String(e);
  } finally {
    mailState.syncing = false;
  }
}

export async function modifyMailThread(
  threadId: string,
  action: "archive" | "unarchive" | "markRead" | "markUnread" | "star" | "unstar" | "trash" | "untrash",
  accountEmail?: string,
): Promise<void> {
  const res = await api(`/v1/mail/threads/${encodeURIComponent(threadId)}/modify`, {
    method: "POST",
    body: JSON.stringify({ action, accountEmail }),
  });
  const updated = await readJson<MailThreadSummary>(res);
  const idx = mailState.threads.findIndex((t) => t.id === updated.id && t.accountEmail === updated.accountEmail);
  if (idx !== -1) {
    mailState.threads[idx] = updated;
  }
  if (mailState.detail && mailState.detail.id === updated.id && mailState.detail.accountEmail === updated.accountEmail) {
    mailState.detail = { ...mailState.detail, ...updated };
  }
  if (action === "archive" || action === "trash" || action === "untrash") {
    await loadMailThreads();
    if (mailState.selectedThreadId === threadId && (action === "archive" || action === "trash")) {
      mailState.selectedThreadId = null;
      mailState.detail = null;
    }
  }
  void loadMailStatus();
}

export async function saveOAuthConfig(input: {
  clientId?: string;
  clientSecret?: string;
  credentialsJson?: string;
}): Promise<MailStatus> {
  const res = await api("/v1/mail/oauth/config", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const status = await readJson<MailStatus>(res);
  mailState.status = status;
  return status;
}

export async function startGmailOAuth(): Promise<{ url: string; redirectUri: string }> {
  const origin = serverUrl.value || window.location.origin;
  const res = await api("/v1/mail/oauth/start", {
    method: "POST",
    body: JSON.stringify({ origin }),
  });
  return readJson<{ url: string; redirectUri: string }>(res);
}

export async function disconnectMailAccount(email: string): Promise<void> {
  const res = await api(`/v1/mail/accounts/${encodeURIComponent(email)}`, { method: "DELETE" });
  await readJson(res);
  if (mailState.selectedAccount === email) mailState.selectedAccount = "";
  if (mailState.detail?.accountEmail === email) {
    mailState.selectedThreadId = null;
    mailState.detail = null;
  }
  await Promise.all([loadMailStatus(), loadMailThreads()]);
}

export async function sendMailMessage(input: {
  accountEmail?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  replyToThreadId?: string;
}): Promise<{ id: string; threadId: string; accountEmail: string }> {
  const res = await api("/v1/mail/send", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const out = await readJson<{ id: string; threadId: string; accountEmail: string }>(res);
  await loadMailThreads();
  return out;
}

export async function saveMailDraft(input: {
  accountEmail?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  replyToThreadId?: string;
}): Promise<{ draftId: string }> {
  const res = await api("/v1/mail/drafts", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const out = await readJson<{ draftId: string }>(res);
  await loadMailThreads();
  return out;
}

export async function downloadMailAttachment(
  accountEmail: string,
  messageId: string,
  attachmentId: string,
  filename: string,
  mimeType: string,
): Promise<void> {
  const params = new URLSearchParams({ accountEmail, filename, mimeType });
  const headers: Record<string, string> = {};
  if (token.value) headers.authorization = `Bearer ${token.value}`;
  const res = await fetch(
    `${serverUrl.value}/v1/mail/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}?${params.toString()}`,
    { headers },
  );
  if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
}
