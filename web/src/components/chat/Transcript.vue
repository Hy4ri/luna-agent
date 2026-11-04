<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from "vue";
import { ArrowDown, X } from "@lucide/vue";
import { chat, entryList, activityLabel, activityDetails, dismissNotice, openSession, loadOlderEntries } from "@/stores/chat";
import { pendingMessages } from "@/stores/composer";
import { messageText } from "@/lib/message";
import ReportContext from "./ReportContext.vue";
import AssistantText from "./AssistantText.vue";
import { assistantTextBlocks, mediaDirectives } from "@/lib/media";
import MessageFooter from "./MessageFooter.vue";
import ToolCall from "./ToolCall.vue";
import SideJobCard from "./SideJobCard.vue";
import Welcome from "./Welcome.vue";
import Questions from "./Questions.vue";
import PendingMessage from "./PendingMessage.vue";
import UploadAttachment from "./UploadAttachment.vue";
import SessionImage from "./SessionImage.vue";

const pending = computed(() => [...pendingMessages.values()].filter(p =>
  p.session === chat.session && (p.session !== null || p.epoch === chat.epoch) &&
  !entryList.value.some(e => e.id === p.entryId)));
// Queued input waits outside the scrolling log, docked above the composer.
const queued = computed(() => pending.value.filter(p => p.status === "Queued"));
const inLog = computed(() => pending.value.filter(p => p.status !== "Queued"));
const logRef = ref<HTMLElement | null>(null);
const jumpRef = ref<HTMLElement | null>(null);
// The jump button shows only while the user scrolls, then hides again.
const IDLE_MS = 1500;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function hideJumps() {
  if (jumpRef.value) jumpRef.value.hidden = true;
}
// A programmatic follow updates the jump button too.
function updateJumps(log: HTMLElement) {
  if (jumpRef.value) jumpRef.value.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 200;
}
// Follow new content only while the user sits at the bottom.
// Only user input can stop following. Scroll events also come from clamping, scroll anchoring,
// and our own writes, and they fire after later content growth, so their position is unreliable.
const BOTTOM_PX = 48;
const INTENT_MS = 600;
let pinned = true;
let intentUntil = 0;
let dragging = false;
const distance = (log: HTMLElement) => log.scrollHeight - log.scrollTop - log.clientHeight;
// Coalesce follow-scrolls into one write per display frame.
let scrollRaf: number | undefined;
function scroll(force = false) {
  if (force) pinned = true;
  if (scrollRaf !== undefined || !logRef.value) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = undefined;
    const log = logRef.value;
    if (!log || !pinned) return;
    log.scrollTop = log.scrollHeight;
    updateJumps(log);
  });
}
function jumpToBottom() {
  scroll(true);
  showJumps();
}
function showJumps() {
  if (logRef.value) updateJumps(logRef.value);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideJumps, IDLE_MS);
}
function markIntent() { intentUntil = Date.now() + INTENT_MS; }
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
// Typing in the composer or any field never scrolls the log.
function handleKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (SCROLL_KEYS.has(event.key)) markIntent();
}
// Scrollbar drags have no wheel or touch event. Pointer-down on the log itself, not its content.
function handlePointerDown(event: PointerEvent) { if (event.target === logRef.value) dragging = true; }
function handlePointerUp() { dragging = false; }
function handleScroll() {
  const log = logRef.value;
  if (!log) return;
  if (distance(log) < BOTTOM_PX) pinned = true;
  else if (dragging || Date.now() < intentUntil) pinned = false;
  if (dragging || Date.now() < intentUntil) showJumps();
}
// Follow every layout change while pinned: DOM changes, log resizes (composer, extras),
// image loads, and disclosure toggles. None of these reliably emit a scroll event.
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
const follow = () => scroll();
onMounted(() => {
  const log = logRef.value;
  if (!log) return;
  resizeObserver = new ResizeObserver(follow);
  resizeObserver.observe(log);
  mutationObserver = new MutationObserver(follow);
  mutationObserver.observe(log, { childList: true, subtree: true, characterData: true });
  log.addEventListener("load", follow, true);
  log.addEventListener("toggle", follow, true);
  window.addEventListener("keydown", handleKey, true);
  window.addEventListener("pointerup", handlePointerUp, true);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  window.removeEventListener("keydown", handleKey, true);
  window.removeEventListener("pointerup", handlePointerUp, true);
  clearTimeout(idleTimer);
  if (scrollRaf !== undefined) cancelAnimationFrame(scrollRaf);
});
// Show newly arrived clarifications at their start, without creating a second scroll area.
watch(() => chat.extras?.questions, (questions, previous) => {
  const added = questions?.find(q => !previous?.some(old => old.callId === q.callId));
  void nextTick(() => {
    const log = logRef.value;
    const form = added && document.querySelector<HTMLElement>(`[data-ask="${CSS.escape(added.callId)}"]`);
    // Scroll only the log. scrollIntoView also scrolls overflow:hidden ancestors and pushes the composer up.
    if (!log || !form) return;
    log.scrollTop += form.getBoundingClientRect().top - log.getBoundingClientRect().top - 24;
    // Keep the question start in view; do not let the follow pull it away.
    pinned = distance(log) < BOTTOM_PX;
  });
});
// Sending or opening a conversation is explicit intent to follow. The frame runs after Vue renders.
watch(() => chat.followTick, () => scroll(true), { flush: "sync" });
// Merge side reports at their start time, rather than pinning them after every later turn.
// Keep durable entry order, including entries that do not contribute model messages.
const timeline = computed((): { key: string; entry?: any; job?: any }[] => {
  // Most turns have no side jobs. Return entries directly: no spread, filter, sort, or per-entry timestamp scan.
  if (!chat.sideJobs.size) return entryList.value.map((entry: any) => ({ key: `entry:${entry.id}`, entry }));
  const jobs = [...chat.sideJobs.values()].filter(j => j.kind !== "review").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rows: { key: string; entry?: any; job?: any }[] = [];
  let at = 0;
  for (const entry of entryList.value) {
    const timestamp = entry.model?.find((m: any) => Number.isFinite(m.timestamp))?.timestamp;
    while (at < jobs.length && Number.isFinite(timestamp) && jobs[at]!.createdAt < timestamp) {
      const job = jobs[at++]!;
      rows.push({ key: `side:${job.id}`, job });
    }
    rows.push({ key: `entry:${entry.id}`, entry });
  }
  for (const job of jobs.slice(at)) rows.push({ key: `side:${job.id}`, job });
  return rows;
});
// Paint the newest rows first. Older rows of the loaded page follow in the next task, so opening a
// long session does not build every message before the first frame. Each session switch starts again.
const FIRST_ROWS = 30;
const allRows = ref(false);
let rowsTimer: ReturnType<typeof setTimeout> | undefined, rowsFrame: number | undefined;
function resetRows() {
  allRows.value = false;
  clearTimeout(rowsTimer); if (rowsFrame !== undefined) cancelAnimationFrame(rowsFrame);
  rowsTimer = rowsFrame = undefined;
}
function scheduleRows() {
  if (allRows.value || timeline.value.length <= FIRST_ROWS || rowsFrame !== undefined || rowsTimer !== undefined) return;
  const epoch = chat.epoch;
  rowsFrame = requestAnimationFrame(() => {
    rowsFrame = undefined;
    rowsTimer = setTimeout(() => { rowsTimer = undefined; if (epoch === chat.epoch) allRows.value = true; });
  });
}
watch(() => chat.epoch, () => { resetRows(); scheduleRows(); });
watch(() => timeline.value.length, scheduleRows, { immediate: true });
onBeforeUnmount(resetRows);
const shownTimeline = computed(() => allRows.value || timeline.value.length <= FIRST_ROWS ? timeline.value : timeline.value.slice(-FIRST_ROWS));
const results = computed(() => {
  const map = new Map<string, any>(Object.entries(chat.toolResults));
  for (const entry of entryList.value) for (const message of entry.model || []) {
    if (message.role === 'toolResult') map.set(message.toolCallId, { ...message, entryId: entry.id });
  }
  return map;
});
const calls = computed(() => {
  // Same membership as before, but direct loops instead of nested flatMap intermediate arrays.
  const set = new Set<string>();
  for (const entry of entryList.value) {
    const model = entry.model;
    if (!model) continue;
    for (const message of model) for (const c of blocks(message.content)) if (c.type === "toolCall") set.add(c.id);
  }
  return set;
});
const durableResults = computed(() => {
  const set = new Set<string>();
  for (const entry of entryList.value) {
    const model = entry.model;
    if (!model) continue;
    for (const m of model) if (m.role === "toolResult") set.add(m.toolCallId);
  }
  return set;
});
/** First media index of each assistant text block, numbered like the server's entry media route. */
const mediaOffsets = computed(() => {
  const map = new Map<string, number>();
  for (const entry of entryList.value) {
    let n = 0;
    for (const b of assistantTextBlocks(entry.model)) { map.set(`${entry.id}:${b.message}:${b.block}`, n); n += mediaDirectives(b.text).length; }
  }
  return map;
});
const mediaBase = (entry: any) => `/v1/sessions/${encodeURIComponent(chat.session || '')}/entries/${entry.id}/media`;
function blocks(content: unknown): any[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}
// Peer identity comes from metadata on this exact delivered input, never from a typed header.
const PEER = /^\[message from session #(\d+) "((?:[^"\\]|\\.)*)": a peer session, not m57\.[^\]]*\]\n\n/;
function peerMessage(entry: any, message: any): { from: number; title: string; body: string } | undefined {
  if (entry.kind !== 'luna.xsession.msg') return undefined;
  const m = PEER.exec(messageText(message.content));
  if (!m || Number(entry.data?.from) !== Number(m[1])) return undefined;
  return { from: Number(m[1]), title: m[2]!, body: messageText(message.content).slice(m[0].length) };
}
function backgroundReport(entry: any, message: any): boolean {
  // Background commands predate origin metadata. Match only their exact producer header.
  return entry.kind === 'pi.user' && /^Background process [a-f0-9-]+ finished:/.test(messageText(message.content));
}
</script>

<template>
  <div id="log" ref="logRef" role="region" aria-label="Conversation" @scroll="handleScroll" @wheel.passive="markIntent" @touchmove.passive="markIntent" @pointerdown="handlePointerDown">
    <div v-if="chat.hasMoreEntries && (allRows || timeline.length <= FIRST_ROWS)" class="load-older-bar">
      <button
        type="button"
        class="load-older-btn"
        :disabled="chat.loadingOlder"
        @click="loadOlderEntries"
      >
        {{ chat.loadingOlder ? "Loading older messages…" : "Load older messages" }}
      </button>
    </div>
    <Welcome v-if="!entryList.length && !pending.length && !chat.liveText && !chat.liveThinking && !chat.sideJobs.size && !activityLabel" />
    <template v-for="row in shownTimeline" :key="row.key">
      <SideJobCard v-if="row.job" :job="row.job" />
      <template v-else v-for="entry in [row.entry]" :key="entry.id">
        <div v-if="entry.kind === 'pi.reset'" class="msg muted">— context reset —</div>
        <div v-else-if="entry.kind === 'pi.compaction'" class="msg muted">— earlier messages compacted —</div>
        <div v-else-if="entry.kind === 'luna.model-changed'" class="msg muted">{{ entry.data?.text }}</div>
        <template v-else v-for="(message, mi) in (entry.model || [])" :key="mi">
          <details v-if="message.role === 'user' && backgroundReport(entry, message)" class="background-report" :data-entry="entry.id">
            <summary>Background report</summary>
            <pre dir="auto">{{ messageText(message.content) }}</pre>
            <MessageFooter :text="messageText(message.content)" :timestamp="message.timestamp" :entry-id="entry.id" />
          </details>
          <div v-else-if="message.role === 'user' && peerMessage(entry, message)" class="msg user peer" :data-entry="entry.id">
            <button type="button" class="peer-chip" :data-peer="peerMessage(entry, message)!.from" :title="'Open session #' + peerMessage(entry, message)!.from" @click="openSession(peerMessage(entry, message)!.from)">From #{{ peerMessage(entry, message)!.from }} {{ peerMessage(entry, message)!.title }}</button>
            <div dir="auto" class="user-content rtl-plaintext">{{ peerMessage(entry, message)!.body }}</div>
            <MessageFooter :text="peerMessage(entry, message)!.body" :timestamp="message.timestamp" :entry-id="entry.id" />
          </div>
          <div v-else-if="message.role === 'user'" class="msg user" :data-entry="entry.id">
            <div dir="auto" class="user-content rtl-plaintext">
              <template v-for="(block, bi) in blocks(message.content)" :key="bi">
                <UploadAttachment
                  v-if="block.attachment"
                  :upload-id="block.attachment.id || block.uploadId"
                  :name="block.attachment.name || 'upload'"
                  :mime-type="block.attachment.mimeType"
                  :size="block.attachment.size"
                />
                <ReportContext v-else-if="block.type === 'text'" :text="block.text" />
                <SessionImage
                  v-else-if="block.type === 'image' && !block.data?.startsWith('luna-upload:')"
                  class="att"
                  :image="block"
                  alt="attachment"
                />
              </template>
            </div>
            <MessageFooter :text="messageText(message.content)" :timestamp="message.timestamp" :entry-id="entry.id" />
          </div>
          <div v-else-if="message.role === 'assistant'" class="msg assistant" :data-entry="entry.id">
            <template v-for="(block, bi) in blocks(message.content)" :key="bi">
              <AssistantText v-if="block.type === 'text' && block.text" :text="block.text" :base="mediaBase(entry)" :offset="mediaOffsets.get(`${entry.id}:${mi}:${bi}`) ?? 0" />
              <details v-else-if="block.type === 'thinking' && block.thinking" class="thinking">
                <summary>Thinking</summary>
                <pre dir="auto">{{ block.thinking }}</pre>
              </details>
              <ToolCall v-else-if="block.type === 'toolCall'" :id="block.id" :name="block.name" :args="block.arguments" :result="results.get(block.id)" :timestamp="message.timestamp" />
            </template>
            <div dir="auto" v-if="message.stopReason === 'error' && message.errorMessage" class="msg err">{{ message.errorMessage }}</div>
            <MessageFooter v-if="messageText(message.content)" :text="messageText(message.content)" :timestamp="message.timestamp" :entry-id="entry.id" />
          </div>
          <ToolCall v-else-if="message.role === 'toolResult' && !calls.has(message.toolCallId)" :id="message.toolCallId" :name="message.toolName || 'tool'" :args="chat.toolStarts[message.toolCallId]?.args" :result="{ ...message, entryId: entry.id }" />
        </template>
    </template>
    </template>
    <template v-for="(tool, id) in chat.toolStarts" :key="id">
      <ToolCall v-if="!calls.has(id) && !durableResults.has(id)" :id="id" :name="tool.name" :args="tool.args" :result="results.get(id)" :timestamp="tool.timestamp" />
    </template>
    <PendingMessage v-for="message in inLog" :key="message.requestId" :message="message" />
    <div v-if="chat.liveText || chat.liveThinking" class="msg assistant live-message">
      <details v-if="chat.liveThinking" class="thinking"><summary>Thinking</summary><pre dir="auto">{{ chat.liveThinking }}</pre></details>
      <AssistantText v-if="chat.liveText" :text="chat.liveText" />
    </div>
    <div v-for="notice in chat.notices" :key="notice.id" :data-notice="notice.id" :class="['msg', 'chat-notice', notice.kind === 'err' ? 'err' : 'muted']">
      <span dir="auto">{{ notice.text }}</span>
      <button type="button" aria-label="Dismiss notice" title="Dismiss notice" @click="dismissNotice(notice.id)"><X :size="16" aria-hidden="true" /></button>
    </div>
    <div v-if="activityLabel" id="activity" role="status" aria-live="polite" aria-atomic="true">
      <span>{{ activityLabel }}</span>
      <ul v-if="activityDetails.length" class="activity-details">
        <li v-for="(detail, index) in activityDetails" :key="index" dir="auto">{{ detail }}</li>
      </ul>
    </div>
    <Questions />
  </div>
  <div v-if="queued.length" class="queued-dock" role="region" aria-label="Queued messages">
    <PendingMessage v-for="message in queued" :key="message.requestId" :message="message" />
  </div>
  <div class="transcript-jumps">
    <button id="jump" ref="jumpRef" type="button" hidden aria-label="Jump to bottom" title="Jump to bottom" @click="jumpToBottom"><ArrowDown :size="18" aria-hidden="true" /></button>
  </div>
</template>

<style scoped>
.load-older-bar { display: flex; justify-content: center; padding: 10px 0 4px; }
.load-older-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 12px;
  border-radius: var(--radius);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted-foreground);
  background: var(--secondary);
  border: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}
.load-older-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--foreground);
}
.load-older-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.queued-dock { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-height: 30%; overflow: auto; padding: 8px max(24px, calc((100% - 760px) / 2)) 0; }
</style>
