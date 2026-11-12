<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { startItemSession } from "@/stores/chat";
import { serverUrl } from "@/lib/api";
import {
  disconnectMailAccount,
  downloadMailAttachment,
  loadMailStatus,
  loadMailThreads,
  mailState,
  modifyMailThread,
  openMailThread,
  saveMailDraft,
  saveOAuthConfig,
  sendMailMessage,
  startGmailOAuth,
  syncMail,
  type MailFolder,
} from "@/stores/mail";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Copy,
  FileText,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  MessageSquarePlus,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings2,
  Star,
  Trash2,
  Unplug,
  X,
} from "@lucide/vue";

const FOLDERS: { id: MailFolder; label: string }[] = [
  { id: "INBOX", label: "Inbox" },
  { id: "UNREAD", label: "Unread" },
  { id: "STARRED", label: "Starred" },
  { id: "SENT", label: "Sent" },
  { id: "DRAFT", label: "Drafts" },
  { id: "TRASH", label: "Trash" },
  { id: "ALL", label: "All" },
];

const showSettings = ref(false);
const showCompose = ref(false);
const showCcBcc = ref(false);
const htmlMode = ref(true);
const searchInput = ref("");

// OAuth setup form
const credentialsJson = ref("");
const clientId = ref("");
const clientSecret = ref("");
const setupBusy = ref(false);
const setupMsg = ref("");
const setupErr = ref("");
const copiedUri = ref(false);

// Compose form
const composeAccount = ref("");
const composeTo = ref("");
const composeCc = ref("");
const composeBcc = ref("");
const composeSubject = ref("");
const composeBody = ref("");
const composeBusy = ref(false);
const composeErr = ref("");
const composeThreadId = ref<string | undefined>(undefined);

const accounts = computed(() => mailState.status?.accounts ?? []);
const hasAccounts = computed(() => accounts.value.length > 0);
const oauthConfigured = computed(() => Boolean(mailState.status?.oauthConfigured));
const redirectUri = computed(() => `${(serverUrl.value || window.location.origin).replace(/\/+$/, "")}/oauth/gmail/callback`);

function formatTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function senderName(from: string): string {
  const m = from.match(/^"?([^"<]+)"?\s*<[^>]+>/);
  return m?.[1]?.trim() || from.replace(/<[^>]+>/g, "").trim() || "(unknown)";
}

function openCompose(reply?: { accountEmail: string; to: string; subject: string; threadId?: string }) {
  composeErr.value = "";
  composeAccount.value = reply?.accountEmail || mailState.selectedAccount || accounts.value[0]?.email || "";
  composeTo.value = reply?.to || "";
  composeCc.value = "";
  composeBcc.value = "";
  showCcBcc.value = false;
  composeSubject.value = reply?.subject || "";
  composeBody.value = "";
  composeThreadId.value = reply?.threadId;
  showCompose.value = true;
}

function replyToCurrent() {
  const detail = mailState.detail;
  if (!detail || !detail.messages.length) return;
  const last = detail.messages[detail.messages.length - 1]!;
  const subj = detail.subject.toLowerCase().startsWith("re:") ? detail.subject : `Re: ${detail.subject}`;
  openCompose({
    accountEmail: detail.accountEmail,
    to: last.from,
    subject: subj,
    threadId: detail.id,
  });
}

async function handleSend() {
  if (!composeAccount.value || !composeTo.value.trim()) {
    composeErr.value = "Account and recipient are required.";
    return;
  }
  composeBusy.value = true;
  composeErr.value = "";
  try {
    await sendMailMessage({
      accountEmail: composeAccount.value,
      to: composeTo.value.trim(),
      cc: composeCc.value.trim() || undefined,
      bcc: composeBcc.value.trim() || undefined,
      subject: composeSubject.value.trim(),
      text: composeBody.value,
      replyToThreadId: composeThreadId.value,
    });
    showCompose.value = false;
  } catch (e) {
    composeErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    composeBusy.value = false;
  }
}

async function handleSaveDraft() {
  if (!composeAccount.value) return;
  composeBusy.value = true;
  composeErr.value = "";
  try {
    await saveMailDraft({
      accountEmail: composeAccount.value,
      to: composeTo.value.trim(),
      cc: composeCc.value.trim() || undefined,
      bcc: composeBcc.value.trim() || undefined,
      subject: composeSubject.value.trim(),
      text: composeBody.value,
      replyToThreadId: composeThreadId.value,
    });
    showCompose.value = false;
  } catch (e) {
    composeErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    composeBusy.value = false;
  }
}

async function handleSaveOAuth() {
  setupBusy.value = true;
  setupErr.value = "";
  setupMsg.value = "";
  try {
    await saveOAuthConfig({
      credentialsJson: credentialsJson.value.trim() || undefined,
      clientId: clientId.value.trim() || undefined,
      clientSecret: clientSecret.value.trim() || undefined,
    });
    credentialsJson.value = "";
    clientSecret.value = "";
    setupMsg.value = "OAuth credentials saved. Click Connect Gmail to sign in.";
  } catch (e) {
    setupErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    setupBusy.value = false;
  }
}

async function handleConnectGoogle() {
  setupBusy.value = true;
  setupErr.value = "";
  try {
    const { url } = await startGmailOAuth();
    window.open(url, "luna-gmail-oauth", "width=540,height=680");
  } catch (e) {
    setupErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    setupBusy.value = false;
  }
}

async function copyRedirectUri() {
  try {
    await navigator.clipboard.writeText(redirectUri.value);
    copiedUri.value = true;
    setTimeout(() => (copiedUri.value = false), 1500);
  } catch { /* ignore */ }
}

async function runSearch() {
  mailState.query = searchInput.value.trim();
  await loadMailThreads({ remote: Boolean(mailState.query) });
}

function selectFolder(f: MailFolder) {
  mailState.folder = f;
  mailState.selectedThreadId = null;
  mailState.detail = null;
  void loadMailThreads();
}

function selectAccount(email: string) {
  mailState.selectedAccount = email;
  mailState.selectedThreadId = null;
  mailState.detail = null;
  void loadMailThreads();
}

async function handleToggleRead() {
  const d = mailState.detail;
  if (!d) return;
  await modifyMailThread(d.id, d.unread ? "markRead" : "markUnread", d.accountEmail);
}

async function handleToggleStar() {
  const d = mailState.detail;
  if (!d) return;
  await modifyMailThread(d.id, d.starred ? "unstar" : "star", d.accountEmail);
}

async function handleArchive() {
  const d = mailState.detail;
  if (!d) return;
  await modifyMailThread(d.id, d.inInbox ? "archive" : "unarchive", d.accountEmail);
}

async function handleTrash() {
  const d = mailState.detail;
  if (!d) return;
  await modifyMailThread(d.id, "trash", d.accountEmail);
}

async function askLunaAboutThread() {
  const d = mailState.detail;
  if (!d) return;
  const last = d.messages[d.messages.length - 1];
  const preview = (last?.bodyText || d.snippet || "").slice(0, 1200);
  const prompt = [
    `Regarding this email thread (account: ${d.accountEmail}, threadId: ${d.id}):`,
    `Subject: ${d.subject}`,
    `From: ${last?.from || ""}`,
    `Date: ${last ? new Date(last.dateMs).toISOString() : ""}`,
    "",
    preview,
  ].join("\n");
  await startItemSession(prompt);
}

function handleOAuthMessage(ev: MessageEvent) {
  if (ev.data && typeof ev.data === "object" && (ev.data as { type?: string }).type === "luna:mail-oauth") {
    void loadMailStatus().then(() => loadMailThreads());
    setupMsg.value = `Connected ${(ev.data as { email?: string }).email || "Gmail account"}.`;
  }
}

watch(() => mailState.error, (e) => { if (e) setupErr.value = e; });

onMounted(async () => {
  window.addEventListener("message", handleOAuthMessage);
  await loadMailStatus();
  if (mailState.status?.accounts.length) {
    await loadMailThreads();
  }
});

onUnmounted(() => {
  window.removeEventListener("message", handleOAuthMessage);
});
</script>

<template>
  <div class="mail-pane">
    <!-- Top action bar -->
    <header class="mail-bar">
      <div class="mail-bar-left">
        <button
          v-if="mailState.detail"
          type="button"
          class="mail-btn"
          title="Back to inbox"
          @click="mailState.selectedThreadId = null; mailState.detail = null"
        >
          <ArrowLeft :size="14" />
          <span>Inbox</span>
        </button>
        <template v-else>
          <select
            v-if="accounts.length > 1"
            :value="mailState.selectedAccount"
            class="mail-select"
            aria-label="Account"
            @change="selectAccount(($event.target as HTMLSelectElement).value)"
          >
            <option value="">All accounts</option>
            <option v-for="acc in accounts" :key="acc.email" :value="acc.email">{{ acc.email }}</option>
          </select>
          <select
            :value="mailState.folder"
            class="mail-select"
            aria-label="Folder"
            @change="selectFolder(($event.target as HTMLSelectElement).value as MailFolder)"
          >
            <option v-for="f in FOLDERS" :key="f.id" :value="f.id">{{ f.label }}</option>
          </select>
        </template>
      </div>

      <div class="mail-bar-right">
        <button type="button" class="mail-btn primary" :disabled="!hasAccounts" title="Compose email" @click="openCompose()">
          <Plus :size="14" />
          <span>Compose</span>
        </button>
        <button type="button" class="mail-btn" :disabled="mailState.syncing || !hasAccounts" title="Sync mail" @click="syncMail()">
          <RefreshCw :size="14" :class="{ spin: mailState.syncing }" />
          <span>Sync</span>
        </button>
        <button type="button" class="mail-btn" title="Mail settings & accounts" @click="showSettings = true">
          <Settings2 :size="14" />
          <span>Settings</span>
        </button>
      </div>
    </header>

    <!-- Search bar (only in list view) -->
    <form v-if="!mailState.detail && hasAccounts" class="mail-search" @submit.prevent="runSearch">
      <Search :size="13" class="search-icon" />
      <input
        v-model="searchInput"
        type="search"
        placeholder="Search mail..."
        class="search-input"
      />
      <button v-if="mailState.query" type="button" class="mail-icon-btn" title="Clear search" @click="searchInput = ''; runSearch()">
        <X :size="13" />
      </button>
    </form>

    <p v-if="mailState.error" class="mail-error" role="alert">{{ mailState.error }}</p>

    <!-- Empty / not connected state -->
    <div v-if="!hasAccounts" class="mail-empty">
      <Inbox :size="28" class="empty-icon" />
      <p class="empty-title">No Gmail account connected</p>
      <p class="empty-sub">Open Settings to add OAuth credentials and connect your Gmail account.</p>
      <button type="button" class="mail-btn primary" @click="showSettings = true">
        <Settings2 :size="14" />
        <span>Open Mail Settings</span>
      </button>
    </div>

    <!-- Thread detail view -->
    <div v-else-if="mailState.detail" class="mail-detail">
      <div class="detail-head">
        <h3 class="detail-subject">{{ mailState.detail.subject || "(no subject)" }}</h3>
        <div class="detail-actions">
          <button type="button" class="mail-btn primary" title="Reply" @click="replyToCurrent">
            <Reply :size="13" />
            <span>Reply</span>
          </button>
          <button type="button" class="mail-btn" title="Ask Luna about this email" @click="askLunaAboutThread">
            <MessageSquarePlus :size="13" />
            <span>Ask Luna</span>
          </button>
          <button type="button" class="mail-icon-btn" :title="mailState.detail.unread ? 'Mark read' : 'Mark unread'" @click="handleToggleRead">
            <MailOpen v-if="mailState.detail.unread" :size="14" />
            <Mail v-else :size="14" />
          </button>
          <button type="button" class="mail-icon-btn" :title="mailState.detail.starred ? 'Unstar' : 'Star'" @click="handleToggleStar">
            <Star :size="14" :class="{ starred: mailState.detail.starred }" />
          </button>
          <button type="button" class="mail-icon-btn" :title="mailState.detail.inInbox ? 'Archive' : 'Move to Inbox'" @click="handleArchive">
            <Archive v-if="mailState.detail.inInbox" :size="14" />
            <ArchiveRestore v-else :size="14" />
          </button>
          <button type="button" class="mail-icon-btn danger" title="Delete" @click="handleTrash">
            <Trash2 :size="14" />
          </button>
          <button type="button" class="mail-btn" @click="htmlMode = !htmlMode">
            <FileText :size="13" />
            <span>{{ htmlMode ? "Text" : "HTML" }}</span>
          </button>
        </div>
      </div>

      <div class="detail-messages">
        <article v-for="m in mailState.detail.messages" :key="m.id" class="msg-card">
          <div class="msg-meta">
            <span class="msg-from">{{ senderName(m.from) }}</span>
            <span class="msg-time">{{ formatTime(m.dateMs) }}</span>
          </div>
          <div class="msg-to">To: {{ m.to || "(none)" }}</div>

          <iframe
            v-if="htmlMode && m.bodyHtml"
            :srcdoc="m.bodyHtml"
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer"
            class="msg-iframe"
            title="Email body"
          />
          <pre v-else class="msg-text">{{ m.bodyText || m.snippet || "(empty body)" }}</pre>

          <div v-if="m.attachments.length" class="msg-attachments">
            <button
              v-for="att in m.attachments"
              :key="att.attachmentId"
              type="button"
              class="att-chip"
              @click="downloadMailAttachment(m.accountEmail, m.id, att.attachmentId, att.filename, att.mimeType)"
            >
              <Paperclip :size="12" />
              <span>{{ att.filename }}</span>
            </button>
          </div>
        </article>
      </div>
    </div>

    <!-- Thread list (Inbox) -->
    <div v-else class="mail-list">
      <div v-if="mailState.loadingThreads && !mailState.threads.length" class="mail-empty">
        <LoaderCircle :size="20" class="spin" />
        <p>Loading messages...</p>
      </div>
      <div v-else-if="!mailState.threads.length" class="mail-empty">
        <Inbox :size="24" class="empty-icon" />
        <p>No messages here.</p>
      </div>
      <button
        v-for="t in mailState.threads"
        :key="t.id"
        type="button"
        class="thread-row"
        :class="{ unread: t.unread }"
        @click="openMailThread(t.id, t.accountEmail)"
      >
        <div class="thread-top">
          <span class="thread-from">{{ senderName(t.participants[0] || t.accountEmail) }}</span>
          <span class="thread-time">{{ formatTime(t.lastMessageAt) }}</span>
        </div>
        <div class="thread-subject">
          <Star v-if="t.starred" :size="12" class="starred inline-star" />
          <span>{{ t.subject || "(no subject)" }}</span>
        </div>
        <div class="thread-snippet">{{ t.snippet }}</div>
      </button>
    </div>

    <!-- Settings & Accounts Modal -->
    <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Mail settings">
        <div class="modal-head">
          <h3>Mail Settings & Accounts</h3>
          <button type="button" class="mail-icon-btn" aria-label="Close" @click="showSettings = false"><X :size="16" /></button>
        </div>

        <div class="modal-body">
          <section class="settings-sec">
            <h4>Connected Accounts</h4>
            <div v-if="!accounts.length" class="muted-note">No accounts connected yet.</div>
            <div v-for="acc in accounts" :key="acc.email" class="account-row">
              <div>
                <div class="acc-email">{{ acc.email }}</div>
                <div class="acc-meta">{{ acc.unreadCount }} unread · synced {{ acc.lastSyncAt ? formatTime(acc.lastSyncAt) : "never" }}</div>
              </div>
              <button type="button" class="mail-btn danger" @click="disconnectMailAccount(acc.email)">
                <Unplug :size="13" />
                <span>Disconnect</span>
              </button>
            </div>

            <button type="button" class="mail-btn primary full" :disabled="setupBusy || !oauthConfigured" @click="handleConnectGoogle">
              <Plus :size="14" />
              <span>Connect Gmail Account</span>
            </button>
          </section>

          <section class="settings-sec">
            <h4>Google OAuth Credentials</h4>
            <p class="muted-note">
              Authorized redirect URI:
              <code class="uri-code">{{ redirectUri }}</code>
              <button type="button" class="mail-icon-btn inline" title="Copy redirect URI" @click="copyRedirectUri">
                <Check v-if="copiedUri" :size="12" />
                <Copy v-else :size="12" />
              </button>
            </p>
            <textarea
              v-model="credentialsJson"
              rows="3"
              placeholder='Paste Google OAuth credentials.json here (or enter Client ID & Secret below)'
              class="modal-input"
            />
            <div class="grid-2">
              <input v-model="clientId" type="text" placeholder="Client ID" class="modal-input" />
              <input v-model="clientSecret" type="password" placeholder="Client Secret" class="modal-input" />
            </div>
            <button type="button" class="mail-btn" :disabled="setupBusy" @click="handleSaveOAuth">
              Save OAuth Credentials
            </button>
            <p v-if="setupMsg" class="ok-note">{{ setupMsg }}</p>
            <p v-if="setupErr" class="err-note">{{ setupErr }}</p>
          </section>
        </div>
      </div>
    </div>

    <!-- Compose Modal -->
    <div v-if="showCompose" class="modal-backdrop" @click.self="showCompose = false">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Compose email">
        <div class="modal-head">
          <h3>{{ composeThreadId ? "Reply" : "New Email" }}</h3>
          <button type="button" class="mail-icon-btn" aria-label="Close" @click="showCompose = false"><X :size="16" /></button>
        </div>
        <form class="modal-body" @submit.prevent="handleSend">
          <select v-if="accounts.length > 1" v-model="composeAccount" class="modal-input">
            <option v-for="acc in accounts" :key="acc.email" :value="acc.email">From: {{ acc.email }}</option>
          </select>
          <div class="compose-row">
            <input v-model="composeTo" type="text" placeholder="To" required class="modal-input" />
            <button type="button" class="mail-btn" @click="showCcBcc = !showCcBcc">Cc/Bcc</button>
          </div>
          <template v-if="showCcBcc">
            <input v-model="composeCc" type="text" placeholder="Cc" class="modal-input" />
            <input v-model="composeBcc" type="text" placeholder="Bcc" class="modal-input" />
          </template>
          <input v-model="composeSubject" type="text" placeholder="Subject" class="modal-input" />
          <textarea v-model="composeBody" rows="8" placeholder="Write your message..." class="modal-input" />
          <p v-if="composeErr" class="err-note">{{ composeErr }}</p>
          <div class="modal-foot">
            <button type="button" class="mail-btn" :disabled="composeBusy" @click="handleSaveDraft">Save Draft</button>
            <button type="submit" class="mail-btn primary" :disabled="composeBusy">
              <Send :size="13" />
              <span>{{ composeBusy ? "Sending..." : "Send" }}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mail-pane { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; background: var(--background); color: var(--foreground); }
.mail-bar { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--card); flex-wrap: wrap; }
.mail-bar-left, .mail-bar-right { display: flex; align-items: center; gap: 4px; }
.mail-select { padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 12px; max-width: 150px; }
.mail-btn { display: inline-flex; align-items: center; gap: 5px; padding: 4px 9px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 12px; cursor: pointer; white-space: nowrap; }
.mail-btn:hover:not(:disabled) { background: var(--secondary); }
.mail-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mail-btn.primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
.mail-btn.primary:hover:not(:disabled) { opacity: 0.9; }
.mail-btn.danger { color: var(--destructive); }
.mail-btn.full { width: 100%; justify-content: center; margin-top: 6px; }
.mail-icon-btn { display: inline-grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: var(--radius); background: transparent; color: var(--muted-foreground); cursor: pointer; }
.mail-icon-btn:hover { background: var(--secondary); color: var(--foreground); }
.mail-icon-btn.danger:hover { color: var(--destructive); }
.mail-icon-btn.inline { width: 20px; height: 20px; vertical-align: middle; }
.mail-search { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-bottom: 1px solid var(--border); background: var(--background); }
.search-icon { color: var(--muted-foreground); flex: none; }
.search-input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--foreground); font-size: 12px; outline: none; }
.mail-error { margin: 0; padding: 6px 10px; font-size: 12px; color: var(--destructive); border-bottom: 1px solid var(--border); }
.mail-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 13px; }
.empty-icon { opacity: 0.6; }
.empty-title { margin: 0; color: var(--foreground); font-weight: 600; }
.empty-sub { margin: 0; max-width: 280px; font-size: 12px; }
.mail-list { flex: 1; overflow-y: auto; min-height: 0; }
.thread-row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 10px; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--foreground); text-align: left; cursor: pointer; }
.thread-row:hover { background: var(--secondary); }
.thread-row.unread { background: color-mix(in srgb, var(--primary) 7%, transparent); }
.thread-row.unread .thread-from, .thread-row.unread .thread-subject { font-weight: 600; }
.thread-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
.thread-from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-time { flex: none; font-size: 11px; color: var(--muted-foreground); }
.thread-subject { display: flex; align-items: center; gap: 4px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-snippet { font-size: 11px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.starred { color: #eab308; fill: #eab308; }
.inline-star { flex: none; }
.mail-detail { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; }
.detail-head { padding: 10px; border-bottom: 1px solid var(--border); background: var(--card); display: flex; flex-direction: column; gap: 8px; }
.detail-subject { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.3; }
.detail-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.detail-messages { display: flex; flex-direction: column; gap: 10px; padding: 10px; }
.msg-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; background: var(--card); display: flex; flex-direction: column; gap: 6px; }
.msg-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; font-weight: 600; }
.msg-time { font-weight: 400; color: var(--muted-foreground); }
.msg-to { font-size: 11px; color: var(--muted-foreground); }
.msg-iframe { width: 100%; min-height: 240px; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; }
.msg-text { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.5; font-family: inherit; }
.msg-attachments { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; }
.att-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 11px; cursor: pointer; }
.att-chip:hover { background: var(--secondary); }
.modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
.modal-card { width: 100%; max-width: 480px; max-height: 85vh; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.modal-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
.modal-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; }
.settings-sec { display: flex; flex-direction: column; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.settings-sec:last-child { border-bottom: 0; padding-bottom: 0; }
.settings-sec h4 { margin: 0; font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--muted-foreground); }
.account-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); }
.acc-email { font-size: 13px; font-weight: 500; }
.acc-meta { font-size: 11px; color: var(--muted-foreground); }
.muted-note { margin: 0; font-size: 12px; color: var(--muted-foreground); }
.uri-code { font-family: var(--mono); font-size: 11px; word-break: break-all; }
.modal-input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); font-size: 12px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.compose-row { display: flex; gap: 6px; }
.ok-note { margin: 0; font-size: 12px; color: #22c55e; }
.err-note { margin: 0; font-size: 12px; color: var(--destructive); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
