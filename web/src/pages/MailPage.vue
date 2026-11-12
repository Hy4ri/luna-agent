<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { backToChat, setDrawer } from "@/stores/app";
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
  Menu,
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

const showSetup = ref(false);
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

// Quick reply form
const replyOpen = ref(false);
const replyText = ref("");
const replyBusy = ref(false);
const replyErr = ref("");

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

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wrapEmailHtml(rawHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body { margin: 12px; font-family: system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.5; background: #ffffff; color: #18181b; word-break: break-word; }
    img { max-width: 100%; height: auto; }
    a { color: #990000; }
    pre { overflow-x: auto; }
  </style></head><body>${rawHtml}</body></html>`;
}

async function copyRedirectUri() {
  try {
    await navigator.clipboard.writeText(redirectUri.value);
    copiedUri.value = true;
    setTimeout(() => { copiedUri.value = false; }, 1500);
  } catch {}
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
    setupMsg.value = "OAuth client saved. Click Connect Gmail Account to sign in.";
  } catch (e) {
    setupErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    setupBusy.value = false;
  }
}

async function handleConnectGmail() {
  setupBusy.value = true;
  setupErr.value = "";
  setupMsg.value = "";
  try {
    const { url } = await startGmailOAuth();
    const popup = window.open(url, "luna-gmail-oauth", "width=540,height=680");
    if (!popup) {
      window.location.href = url;
    }
  } catch (e) {
    setupErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    setupBusy.value = false;
  }
}

function onOAuthMessage(event: MessageEvent) {
  const data = event.data as { type?: string; ok?: boolean; email?: string; message?: string } | null;
  if (!data || data.type !== "luna-mail-oauth") return;
  if (data.ok) {
    setupMsg.value = `Connected ${data.email ?? "Gmail"}! Syncing recent threads...`;
    setupErr.value = "";
    showSetup.value = false;
    void loadMailStatus().then(() => loadMailThreads());
  } else {
    setupErr.value = data.message || "OAuth failed";
  }
}

function selectFolder(folder: MailFolder) {
  mailState.folder = folder;
  mailState.selectedThreadId = null;
  mailState.detail = null;
  void loadMailThreads();
}

function handleSearch() {
  mailState.query = searchInput.value;
  void loadMailThreads({ remote: Boolean(searchInput.value.trim()) });
}

function openCompose() {
  composeAccount.value = mailState.selectedAccount || accounts.value[0]?.email || "";
  composeTo.value = "";
  composeCc.value = "";
  composeBcc.value = "";
  composeSubject.value = "";
  composeBody.value = "";
  composeErr.value = "";
  showCcBcc.value = false;
  showCompose.value = true;
}

async function handleComposeSend(asDraft = false) {
  composeBusy.value = true;
  composeErr.value = "";
  try {
    if (asDraft) {
      await saveMailDraft({
        accountEmail: composeAccount.value || undefined,
        to: composeTo.value,
        cc: composeCc.value || undefined,
        bcc: composeBcc.value || undefined,
        subject: composeSubject.value,
        text: composeBody.value,
      });
    } else {
      await sendMailMessage({
        accountEmail: composeAccount.value || undefined,
        to: composeTo.value,
        cc: composeCc.value || undefined,
        bcc: composeBcc.value || undefined,
        subject: composeSubject.value,
        text: composeBody.value,
      });
    }
    showCompose.value = false;
  } catch (e) {
    composeErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    composeBusy.value = false;
  }
}

async function handleReplySend(asDraft = false) {
  const detail = mailState.detail;
  if (!detail || !replyText.value.trim()) return;
  replyBusy.value = true;
  replyErr.value = "";
  try {
    const last = detail.messages[detail.messages.length - 1];
    const replyTo = last?.from && !last.from.toLowerCase().includes(detail.accountEmail.toLowerCase())
      ? last.from
      : last?.to || detail.participants[0] || "";
    if (asDraft) {
      await saveMailDraft({
        accountEmail: detail.accountEmail,
        to: replyTo,
        subject: detail.subject.toLowerCase().startsWith("re:") ? detail.subject : `Re: ${detail.subject}`,
        text: replyText.value,
        replyToThreadId: detail.id,
      });
    } else {
      await sendMailMessage({
        accountEmail: detail.accountEmail,
        to: replyTo,
        subject: detail.subject.toLowerCase().startsWith("re:") ? detail.subject : `Re: ${detail.subject}`,
        text: replyText.value,
        replyToThreadId: detail.id,
      });
      await openMailThread(detail.id, detail.accountEmail);
    }
    replyText.value = "";
    replyOpen.value = false;
  } catch (e) {
    replyErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    replyBusy.value = false;
  }
}

async function handleSendToChat() {
  const detail = mailState.detail;
  if (!detail) return;
  const last = detail.messages[detail.messages.length - 1];
  const prompt = [
    `Email thread (${detail.accountEmail}): "${detail.subject}"`,
    `Thread ID: ${detail.id}`,
    `From: ${last?.from ?? detail.participants.join(", ")}`,
    `Date: ${last ? new Date(last.dateMs).toISOString() : ""}`,
    "",
    (last?.bodyText || detail.snippet || "").slice(0, 4000),
  ].join("\n");
  await startItemSession(prompt);
  backToChat();
}

watch(() => mailState.selectedAccount, () => {
  mailState.selectedThreadId = null;
  mailState.detail = null;
  void loadMailThreads();
});

onMounted(async () => {
  window.addEventListener("message", onOAuthMessage);
  const status = await loadMailStatus();
  if (status && status.accounts.length > 0) {
    await loadMailThreads();
  } else {
    showSetup.value = true;
  }
});

onUnmounted(() => {
  window.removeEventListener("message", onOAuthMessage);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <!-- Top Header -->
    <header class="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3 md:px-4">
      <div class="flex min-w-0 items-center gap-2">
        <button
          id="mail-menu"
          type="button"
          class="icon-button md:hidden"
          aria-label="Open menu"
          @click="setDrawer(true)"
        >
          <Menu :size="18" />
        </button>
        <Mail :size="18" class="shrink-0 text-primary-text" />
        <h1 class="truncate text-sm font-semibold">Mail</h1>
        <select
          v-if="accounts.length > 1"
          v-model="mailState.selectedAccount"
          aria-label="Filter account"
          class="ml-2 max-w-[200px] truncate rounded-[1px] border border-input bg-card px-2 py-1 text-xs"
        >
          <option value="">All accounts ({{ accounts.length }})</option>
          <option v-for="acc in accounts" :key="acc.email" :value="acc.email">
            {{ acc.email }} ({{ acc.unreadCount }})
          </option>
        </select>
        <span v-else-if="accounts.length === 1" class="hidden truncate text-xs text-muted-foreground sm:inline">
          {{ accounts[0]!.email }}
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-1.5">
        <button
          v-if="hasAccounts"
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-[1px] border border-border bg-card px-2.5 text-xs hover:bg-accent disabled:opacity-50"
          :disabled="mailState.syncing"
          @click="syncMail(false)"
        >
          <RefreshCw :size="14" :class="{ 'animate-spin': mailState.syncing }" />
          <span class="hidden sm:inline">{{ mailState.syncing ? "Syncing" : "Sync" }}</span>
        </button>
        <button
          v-if="hasAccounts"
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-[1px] bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          @click="openCompose"
        >
          <Plus :size="14" />
          <span>Compose</span>
        </button>
        <button
          type="button"
          class="icon-button"
          :class="{ 'text-primary-text': showSetup }"
          aria-label="Mail accounts and OAuth settings"
          title="Accounts & OAuth"
          @click="showSetup = !showSetup"
        >
          <Settings2 :size="16" />
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="Close Mail"
          title="Back to chat"
          @click="backToChat"
        >
          <X :size="16" />
        </button>
      </div>
    </header>

    <!-- Account & OAuth Setup Drawer/Panel -->
    <section v-if="showSetup || !hasAccounts" class="border-b border-border bg-card p-4 text-sm">
      <div class="mx-auto grid max-w-3xl gap-4">
        <div class="flex items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold">Gmail Connection</h2>
            <p class="text-xs text-muted-foreground">
              Connect one or more Gmail accounts via Google OAuth2. Credentials stay in <code class="font-mono">mail-auth.json</code> (0600).
            </p>
          </div>
          <button
            v-if="hasAccounts"
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground"
            @click="showSetup = false"
          >
            Hide
          </button>
        </div>

        <!-- Connected accounts -->
        <div v-if="accounts.length" class="grid gap-2">
          <div
            v-for="acc in accounts"
            :key="acc.email"
            class="flex flex-wrap items-center justify-between gap-2 rounded-[1px] border border-border bg-background px-3 py-2 text-xs"
          >
            <div class="min-w-0">
              <div class="font-medium text-foreground">{{ acc.displayName }} <span class="text-muted-foreground">&lt;{{ acc.email }}&gt;</span></div>
              <div class="text-muted-foreground">
                Status: {{ acc.syncStatus }}
                <span v-if="acc.lastSyncAt"> · Last sync {{ formatTime(acc.lastSyncAt) }}</span>
                <span v-if="acc.lastError" class="text-destructive"> · {{ acc.lastError }}</span>
              </div>
            </div>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-[1px] border border-border px-2 py-1 text-xs text-destructive hover:bg-accent"
              @click="disconnectMailAccount(acc.email)"
            >
              <Unplug :size="12" />
              Disconnect
            </button>
          </div>
        </div>

        <!-- Step 1: OAuth Client -->
        <details :open="!oauthConfigured" class="rounded-[1px] border border-border bg-background p-3">
          <summary class="cursor-pointer text-xs font-medium">
            Step 1: Google OAuth Client {{ oauthConfigured ? "(Configured)" : "(Required)" }}
          </summary>
          <div class="mt-3 grid gap-3 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-[1px] border border-border bg-card px-2.5 py-2">
              <div class="min-w-0">
                <div class="text-muted-foreground">Authorized Redirect URI (add to Google Cloud OAuth Client):</div>
                <code class="block truncate font-mono text-foreground">{{ redirectUri }}</code>
              </div>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-[1px] border border-border px-2 py-1 hover:bg-accent"
                @click="copyRedirectUri"
              >
                <Check v-if="copiedUri" :size="12" class="text-ok" />
                <Copy v-else :size="12" />
                {{ copiedUri ? "Copied" : "Copy" }}
              </button>
            </div>

            <label class="grid gap-1">
              <span class="text-muted-foreground">Paste Google <code class="font-mono">credentials.json</code> (or fill Client ID &amp; Secret below)</span>
              <textarea
                v-model="credentialsJson"
                rows="3"
                placeholder='{"web":{"client_id":"...","client_secret":"..."}}'
                class="w-full rounded-[1px] border border-input bg-card p-2 font-mono text-xs"
              />
            </label>

            <div class="grid gap-2 sm:grid-cols-2">
              <label class="grid gap-1">
                <span class="text-muted-foreground">Client ID</span>
                <input v-model="clientId" type="text" placeholder="12345.apps.googleusercontent.com" class="rounded-[1px] border border-input bg-card px-2.5 py-1.5 font-mono text-xs" />
              </label>
              <label class="grid gap-1">
                <span class="text-muted-foreground">Client Secret</span>
                <input v-model="clientSecret" type="password" placeholder="GOCSPX-..." class="rounded-[1px] border border-input bg-card px-2.5 py-1.5 font-mono text-xs" />
              </label>
            </div>

            <div>
              <button
                type="button"
                class="rounded-[1px] border border-border bg-secondary px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
                :disabled="setupBusy"
                @click="handleSaveOAuth"
              >
                Save OAuth Client
              </button>
            </div>
          </div>
        </details>

        <!-- Step 2: Connect -->
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-[1px] bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            :disabled="!oauthConfigured || setupBusy"
            @click="handleConnectGmail"
          >
            <Mail :size="14" />
            Connect Gmail Account
          </button>
          <span v-if="setupMsg" class="text-xs text-ok">{{ setupMsg }}</span>
          <span v-if="setupErr" class="text-xs text-destructive">{{ setupErr }}</span>
        </div>
      </div>
    </section>

    <!-- Fixed Filter Chips & Search Bar -->
    <div v-if="hasAccounts" class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card/50 px-3 py-2">
      <div class="flex flex-wrap items-center gap-1">
        <button
          v-for="f in FOLDERS"
          :key="f.id"
          type="button"
          class="inline-flex h-7 items-center gap-1 rounded-[1px] border px-2.5 text-xs transition-colors"
          :class="mailState.folder === f.id
            ? 'border-primary bg-acc-soft text-primary-text font-medium'
            : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'"
          @click="selectFolder(f.id)"
        >
          <Inbox v-if="f.id === 'INBOX'" :size="12" />
          <MailOpen v-else-if="f.id === 'UNREAD'" :size="12" />
          <Star v-else-if="f.id === 'STARRED'" :size="12" />
          <Send v-else-if="f.id === 'SENT'" :size="12" />
          <FileText v-else-if="f.id === 'DRAFT'" :size="12" />
          <Trash2 v-else-if="f.id === 'TRASH'" :size="12" />
          <span>{{ f.label }}</span>
        </button>
      </div>

      <form class="flex w-full items-center gap-1.5 sm:w-auto sm:min-w-[260px]" @submit.prevent="handleSearch">
        <div class="relative flex-1">
          <Search :size="13" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            v-model="searchInput"
            type="search"
            placeholder="Search Gmail (Enter for live search)"
            class="h-7 w-full rounded-[1px] border border-input bg-background pl-8 pr-2 text-xs"
          />
        </div>
      </form>
    </div>

    <!-- Error Banner -->
    <div v-if="mailState.error" class="flex items-center justify-between gap-2 border-b border-destructive/40 bg-err-soft px-3 py-2 text-xs text-destructive">
      <span>{{ mailState.error }}</span>
      <button type="button" class="underline" @click="loadMailThreads()">Retry</button>
    </div>

    <!-- Main Split Pane -->
    <div v-if="hasAccounts" class="flex min-h-0 flex-1 overflow-hidden">
      <!-- Thread List -->
      <aside
        class="flex min-h-0 w-full flex-col border-r border-border md:w-80 lg:w-96"
        :class="{ 'hidden md:flex': !!mailState.selectedThreadId }"
      >
        <div v-if="mailState.loadingThreads && !mailState.threads.length" class="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <LoaderCircle :size="15" class="animate-spin" />
          Loading threads...
        </div>
        <div v-else-if="!mailState.threads.length" class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
          <Mail :size="24" class="opacity-50" />
          <p>No emails in {{ mailState.folder.toLowerCase() }}.</p>
          <button type="button" class="rounded-[1px] border border-border px-2.5 py-1 hover:bg-accent" @click="syncMail(false)">
            Sync now
          </button>
        </div>
        <div v-else class="flex-1 overflow-y-auto divide-y divide-border">
          <div
            v-for="t in mailState.threads"
            :key="`${t.accountEmail}:${t.id}`"
            class="group flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-accent/60"
            :class="{
              'bg-acc-soft': mailState.selectedThreadId === t.id,
              'bg-card/40': t.unread && mailState.selectedThreadId !== t.id,
            }"
            @click="openMailThread(t.id, t.accountEmail)"
          >
            <span
              class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
              :class="t.unread ? 'bg-primary-text' : 'bg-transparent'"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-xs" :class="t.unread ? 'font-semibold text-foreground' : 'text-muted-foreground'">
                  {{ t.participants.slice(0, 2).join(", ") || "Unknown" }}
                </span>
                <span class="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {{ formatTime(t.lastMessageAt) }}
                </span>
              </div>
              <div class="mt-0.5 flex items-center gap-1.5">
                <span class="truncate text-xs" :class="t.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'">
                  {{ t.subject }}
                </span>
                <span v-if="t.messageCount > 1" class="shrink-0 rounded-[1px] bg-secondary px-1 text-[10px] tabular-nums text-muted-foreground">
                  {{ t.messageCount }}
                </span>
              </div>
              <p class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {{ t.snippet }}
              </p>
            </div>
            <button
              type="button"
              class="mt-0.5 shrink-0 p-1 text-muted-foreground hover:text-foreground"
              :aria-label="t.starred ? 'Unstar thread' : 'Star thread'"
              @click.stop="modifyMailThread(t.id, t.starred ? 'unstar' : 'star', t.accountEmail)"
            >
              <Star :size="13" :class="t.starred ? 'fill-warn text-warn' : ''" />
            </button>
          </div>
        </div>
      </aside>

      <!-- Thread Reader -->
      <main
        class="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
        :class="{ 'hidden md:flex': !mailState.selectedThreadId }"
      >
        <div v-if="mailState.loadingDetail" class="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle :size="16" class="animate-spin" />
          Loading conversation...
        </div>

        <div v-else-if="!mailState.detail" class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground">
          <MailOpen :size="28" class="opacity-40" />
          <p>Select a conversation to read.</p>
        </div>

        <template v-else>
          <!-- Thread Toolbar -->
          <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                class="icon-button md:hidden"
                aria-label="Back to list"
                @click="mailState.selectedThreadId = null; mailState.detail = null"
              >
                <ArrowLeft :size="16" />
              </button>
              <button
                type="button"
                class="inline-flex h-7 items-center gap-1 rounded-[1px] border border-border bg-card px-2 text-xs hover:bg-accent"
                @click="replyOpen = !replyOpen"
              >
                <Reply :size="13" />
                Reply
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="mailState.detail.inInbox ? 'Archive' : 'Move to Inbox'"
                :title="mailState.detail.inInbox ? 'Archive' : 'Move to Inbox'"
                @click="modifyMailThread(mailState.detail.id, mailState.detail.inInbox ? 'archive' : 'unarchive', mailState.detail.accountEmail)"
              >
                <Archive v-if="mailState.detail.inInbox" :size="15" />
                <ArchiveRestore v-else :size="15" />
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="mailState.detail.unread ? 'Mark as read' : 'Mark as unread'"
                :title="mailState.detail.unread ? 'Mark as read' : 'Mark as unread'"
                @click="modifyMailThread(mailState.detail.id, mailState.detail.unread ? 'markRead' : 'markUnread', mailState.detail.accountEmail)"
              >
                <MailOpen v-if="mailState.detail.unread" :size="15" />
                <Mail v-else :size="15" />
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="mailState.detail.starred ? 'Unstar' : 'Star'"
                :title="mailState.detail.starred ? 'Unstar' : 'Star'"
                @click="modifyMailThread(mailState.detail.id, mailState.detail.starred ? 'unstar' : 'star', mailState.detail.accountEmail)"
              >
                <Star :size="15" :class="mailState.detail.starred ? 'fill-warn text-warn' : ''" />
              </button>
              <button
                type="button"
                class="icon-button text-destructive"
                :aria-label="mailState.detail.inTrash ? 'Restore from trash' : 'Move to trash'"
                :title="mailState.detail.inTrash ? 'Restore from trash' : 'Move to trash'"
                @click="modifyMailThread(mailState.detail.id, mailState.detail.inTrash ? 'untrash' : 'trash', mailState.detail.accountEmail)"
              >
                <Trash2 :size="15" />
              </button>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="rounded-[1px] border border-border bg-card px-2 py-1 text-xs hover:bg-accent"
                @click="htmlMode = !htmlMode"
              >
                {{ htmlMode ? "Plain text" : "Rich HTML" }}
              </button>
              <button
                type="button"
                class="inline-flex h-7 items-center gap-1 rounded-[1px] border border-border bg-card px-2 text-xs text-primary-text hover:bg-accent"
                title="Open this email thread in a new Luna chat"
                @click="handleSendToChat"
              >
                <MessageSquarePlus :size="13" />
                <span>Send to chat</span>
              </button>
            </div>
          </div>

          <!-- Messages -->
          <div class="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <h2 class="text-base font-semibold">{{ mailState.detail.subject }}</h2>
              <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>{{ mailState.detail.accountEmail }}</span>
                <span>·</span>
                <span>{{ mailState.detail.messages.length }} message{{ mailState.detail.messages.length === 1 ? "" : "s" }}</span>
              </div>
            </div>

            <article
              v-for="(msg, idx) in mailState.detail.messages"
              :key="msg.id"
              class="rounded-[1px] border border-border bg-card"
            >
              <details :open="idx === mailState.detail.messages.length - 1">
                <summary class="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-3 py-2.5 text-xs hover:bg-accent/40">
                  <div class="min-w-0">
                    <span class="font-medium text-foreground">{{ msg.from || "Unknown sender" }}</span>
                    <span v-if="msg.to" class="ml-2 text-muted-foreground">to {{ msg.to }}</span>
                  </div>
                  <span class="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {{ new Date(msg.dateMs).toLocaleString() }}
                  </span>
                </summary>

                <div class="border-t border-border p-3 space-y-3">
                  <div v-if="msg.cc" class="text-xs text-muted-foreground">Cc: {{ msg.cc }}</div>

                  <div v-if="msg.attachments.length" class="flex flex-wrap gap-1.5">
                    <button
                      v-for="att in msg.attachments"
                      :key="att.attachmentId"
                      type="button"
                      class="inline-flex items-center gap-1.5 rounded-[1px] border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
                      @click="downloadMailAttachment(msg.accountEmail, msg.id, att.attachmentId, att.filename, att.mimeType)"
                    >
                      <Paperclip :size="12" class="text-muted-foreground" />
                      <span class="max-w-[180px] truncate">{{ att.filename }}</span>
                      <span v-if="att.size" class="text-muted-foreground">({{ formatSize(att.size) }})</span>
                    </button>
                  </div>

                  <iframe
                    v-if="htmlMode && msg.bodyHtml"
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    referrerpolicy="no-referrer"
                    :srcdoc="wrapEmailHtml(msg.bodyHtml)"
                    class="h-[420px] w-full rounded-[1px] border border-border bg-white"
                    title="Email content"
                  />
                  <pre v-else class="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground">{{ msg.bodyText || "(empty message)" }}</pre>
                </div>
              </details>
            </article>

            <!-- Quick Reply -->
            <div v-if="replyOpen" class="rounded-[1px] border border-border bg-card p-3 space-y-2.5">
              <div class="text-xs font-medium text-muted-foreground">Quick Reply</div>
              <textarea
                v-model="replyText"
                rows="5"
                placeholder="Write your reply..."
                class="w-full rounded-[1px] border border-input bg-background p-2.5 text-sm"
              />
              <div v-if="replyErr" class="text-xs text-destructive">{{ replyErr }}</div>
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  class="rounded-[1px] border border-border px-3 py-1.5 text-xs hover:bg-accent"
                  :disabled="replyBusy"
                  @click="replyOpen = false"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="rounded-[1px] border border-border bg-secondary px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
                  :disabled="replyBusy || !replyText.trim()"
                  @click="handleReplySend(true)"
                >
                  Save Draft
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 rounded-[1px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  :disabled="replyBusy || !replyText.trim()"
                  @click="handleReplySend(false)"
                >
                  <Send :size="12" />
                  Send Reply
                </button>
              </div>
            </div>
          </div>
        </template>
      </main>
    </div>

    <!-- Compose Modal -->
    <div
      v-if="showCompose"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="showCompose = false"
    >
      <div class="w-full max-w-xl rounded-[1px] border border-border bg-card p-4 shadow-xl space-y-3" role="dialog" aria-modal="true" aria-label="Compose email">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">New Message</h2>
          <button type="button" class="icon-button" aria-label="Close compose" @click="showCompose = false">
            <X :size="16" />
          </button>
        </div>

        <div class="grid gap-2 text-xs">
          <label v-if="accounts.length > 1" class="grid gap-1">
            <span class="text-muted-foreground">From</span>
            <select v-model="composeAccount" class="rounded-[1px] border border-input bg-background px-2.5 py-1.5">
              <option v-for="acc in accounts" :key="acc.email" :value="acc.email">{{ acc.email }}</option>
            </select>
          </label>
          <label class="grid gap-1">
            <div class="flex items-center justify-between">
              <span class="text-muted-foreground">To</span>
              <button type="button" class="text-muted-foreground hover:text-foreground" @click="showCcBcc = !showCcBcc">
                {{ showCcBcc ? "Hide Cc/Bcc" : "Cc/Bcc" }}
              </button>
            </div>
            <input v-model="composeTo" type="text" placeholder="recipient@example.com" class="rounded-[1px] border border-input bg-background px-2.5 py-1.5" />
          </label>
          <div v-if="showCcBcc" class="grid gap-2 sm:grid-cols-2">
            <label class="grid gap-1">
              <span class="text-muted-foreground">Cc</span>
              <input v-model="composeCc" type="text" class="rounded-[1px] border border-input bg-background px-2.5 py-1.5" />
            </label>
            <label class="grid gap-1">
              <span class="text-muted-foreground">Bcc</span>
              <input v-model="composeBcc" type="text" class="rounded-[1px] border border-input bg-background px-2.5 py-1.5" />
            </label>
          </div>
          <label class="grid gap-1">
            <span class="text-muted-foreground">Subject</span>
            <input v-model="composeSubject" type="text" placeholder="Subject" class="rounded-[1px] border border-input bg-background px-2.5 py-1.5" />
          </label>
          <label class="grid gap-1">
            <span class="text-muted-foreground">Message</span>
            <textarea v-model="composeBody" rows="8" placeholder="Write your message..." class="rounded-[1px] border border-input bg-background p-2.5 text-sm" />
          </label>
        </div>

        <div v-if="composeErr" class="text-xs text-destructive">{{ composeErr }}</div>

        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="rounded-[1px] border border-border px-3 py-1.5 text-xs hover:bg-accent"
            :disabled="composeBusy"
            @click="showCompose = false"
          >
            Discard
          </button>
          <button
            type="button"
            class="rounded-[1px] border border-border bg-secondary px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            :disabled="composeBusy || !composeTo.trim()"
            @click="handleComposeSend(true)"
          >
            Save Draft
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-[1px] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            :disabled="composeBusy || !composeTo.trim() || !composeBody.trim()"
            @click="handleComposeSend(false)"
          >
            <Send :size="12" />
            Send
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
