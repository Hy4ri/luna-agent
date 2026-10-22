<script setup lang="ts">
import { ref, computed, nextTick, watch, onBeforeUnmount } from "vue";
import { ArrowUp, ArrowDown, X } from "@lucide/vue";
import { chat, entryList, activityLabel, dismissNotice, openSession } from "@/stores/chat";
import { pendingMessages } from "@/stores/composer";
import { messageText } from "@/lib/message";
import Markdown from "./Markdown.vue";
import AssistantText from "./AssistantText.vue";
import { assistantTextBlocks, mediaDirectives } from "@/lib/media";
import MessageFooter from "./MessageFooter.vue";
import ToolCall from "./ToolCall.vue";
import SideJobCard from "./SideJobCard.vue";
import Welcome from "./Welcome.vue";
import Questions from "./Questions.vue";

const pending = computed(() => [...pendingMessages.values()].filter(p =>
  p.session === chat.session && (p.session !== null || p.epoch === chat.epoch) &&
  !entryList.value.some(e => e.id === p.entryId)));
const logRef = ref<HTMLElement | null>(null);
const jumpRef = ref<HTMLElement | null>(null);
const jumpTopRef = ref<HTMLElement | null>(null);
// The jump buttons show only while the user scrolls, then hide again.
const IDLE_MS = 1500;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let programmaticAt = 0;
let programmaticTop = -1;
function hideJumps() {
  if (jumpRef.value) jumpRef.value.hidden = true;
  if (jumpTopRef.value) jumpTopRef.value.hidden = true;
}
// Follow new content only while the user sits at the bottom. Track this from user scrolls:
// measuring after content grows would read a tall new block as "scrolled up".
const BOTTOM_PX = 48;
let pinned = true;
function scroll(force = false) {
  const log = logRef.value;
  if (force) pinned = true;
  if (log && pinned) {
    programmaticAt = Date.now();
    log.scrollTop = log.scrollHeight;
    programmaticTop = log.scrollTop;
  }
}
function jumpToTop() {
  programmaticAt = Date.now();
  if (logRef.value) logRef.value.scrollTop = programmaticTop = 0;
  handleScroll();
}
function jumpToBottom() {
  scroll(true);
  handleScroll();
}
function handleScroll(event?: Event) {
  const log = logRef.value;
  if (!log) return;
  if (event?.type === "scroll" && Date.now() - programmaticAt < 150 && log.scrollTop === programmaticTop) return;
  if (event?.type === "scroll") pinned = log.scrollHeight - log.scrollTop - log.clientHeight < BOTTOM_PX;
  if (jumpRef.value) jumpRef.value.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < 200;
  if (jumpTopRef.value) jumpTopRef.value.hidden = log.scrollTop < 200;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideJumps, IDLE_MS);
}
onBeforeUnmount(() => clearTimeout(idleTimer));
// Show newly arrived clarifications at their start, without creating a second scroll area.
watch(() => chat.extras?.questions, (questions, previous) => {
  const added = questions?.find(q => !previous?.some(old => old.callId === q.callId));
  void nextTick(() => {
    const log = logRef.value;
    const form = added && document.querySelector<HTMLElement>(`[data-ask="${CSS.escape(added.callId)}"]`);
    // Scroll only the log. scrollIntoView also scrolls overflow:hidden ancestors and pushes the composer up.
    if (log && form) log.scrollTop += form.getBoundingClientRect().top - log.getBoundingClientRect().top - 24;
  });
});
watch(() => pending.value.length, (length, previous) => { if (length > previous) void nextTick(() => scroll(true)); });
watch(() => chat.followTick, () => nextTick(() => scroll(true)));
watch(() => [chat.rev, chat.liveText, chat.liveThinking, chat.sideJobs.size, chat.notices.length, activityLabel.value], () => nextTick(() => scroll()));
// Merge side reports at their start time, rather than pinning them after every later turn.
// Keep durable entry order, including entries that do not contribute model messages.
const timeline = computed(() => {
  const jobs = [...chat.sideJobs.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rows: { key: string; entry?: any; job?: typeof jobs[number] }[] = [];
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
const results = computed(() => {
  const map = new Map<string, any>(Object.entries(chat.toolResults));
  for (const entry of entryList.value) for (const message of entry.model || []) {
    if (message.role === 'toolResult') map.set(message.toolCallId, message);
  }
  return map;
});
const calls = computed(() => new Set<string>(entryList.value.flatMap(e => (e.model || []).flatMap((m: any) => blocks(m.content).filter(c => c.type === 'toolCall').map(c => c.id)))));
const durableResults = computed(() => new Set<string>(entryList.value.flatMap(e => (e.model || []).filter((m: any) => m.role === 'toolResult').map((m: any) => m.toolCallId))));
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
  <div id="log" ref="logRef" role="region" aria-label="Conversation" @scroll="handleScroll" @wheel.passive="handleScroll" @touchmove.passive="handleScroll">
    <Welcome v-if="!entryList.length && !pending.length && !chat.liveText && !chat.liveThinking && !chat.sideJobs.size && !activityLabel" />
    <template v-for="row in timeline" :key="row.key">
      <SideJobCard v-if="row.job" :job="row.job" />
      <template v-else v-for="entry in [row.entry]" :key="entry.id">
        <div v-if="entry.kind === 'pi.reset'" class="msg muted">— context reset —</div>
        <div v-else-if="entry.kind === 'pi.compaction'" class="msg muted">— earlier messages compacted —</div>
        <template v-else v-for="(message, mi) in (entry.model || [])" :key="mi">
          <details v-if="message.role === 'user' && backgroundReport(entry, message)" class="background-report" :data-entry="entry.id">
            <summary>Background report</summary>
            <pre>{{ messageText(message.content) }}</pre>
            <MessageFooter :text="messageText(message.content)" :timestamp="message.timestamp" />
          </details>
          <div v-else-if="message.role === 'user' && peerMessage(entry, message)" class="msg user peer" :data-entry="entry.id">
            <button type="button" class="peer-chip" :data-peer="peerMessage(entry, message)!.from" :title="'Open session #' + peerMessage(entry, message)!.from" @click="openSession(peerMessage(entry, message)!.from)">From #{{ peerMessage(entry, message)!.from }} {{ peerMessage(entry, message)!.title }}</button>
            <div class="user-content">{{ peerMessage(entry, message)!.body }}</div>
            <MessageFooter :text="peerMessage(entry, message)!.body" :timestamp="message.timestamp" />
          </div>
          <div v-else-if="message.role === 'user'" class="msg user" :data-entry="entry.id">
            <div class="user-content"><template v-for="(block, bi) in blocks(message.content)" :key="bi"><span v-if="block.type === 'text'">{{ block.text }}</span><img v-else-if="block.type === 'image'" class="att" :src="`data:${block.mimeType};base64,${block.data}`" alt="attachment" /></template></div>
            <MessageFooter :text="messageText(message.content)" :timestamp="message.timestamp" />
          </div>
          <div v-else-if="message.role === 'assistant'" class="msg assistant" :data-entry="entry.id">
            <template v-for="(block, bi) in blocks(message.content)" :key="bi">
              <AssistantText v-if="block.type === 'text' && block.text" :text="block.text" :base="mediaBase(entry)" :offset="mediaOffsets.get(`${entry.id}:${mi}:${bi}`) ?? 0" />
              <details v-else-if="block.type === 'thinking' && block.thinking" class="thinking">
                <summary>Thinking</summary>
                <pre>{{ block.thinking }}</pre>
              </details>
              <ToolCall v-else-if="block.type === 'toolCall'" :id="block.id" :name="block.name" :args="block.arguments" :result="results.get(block.id)" :timestamp="message.timestamp" />
            </template>
            <div v-if="message.stopReason === 'error' && message.errorMessage" class="msg err">{{ message.errorMessage }}</div>
            <MessageFooter v-if="messageText(message.content)" :text="messageText(message.content)" :timestamp="message.timestamp" />
          </div>
          <ToolCall v-else-if="message.role === 'toolResult' && !calls.has(message.toolCallId)" :id="message.toolCallId" :name="message.toolName || 'tool'" :args="chat.toolStarts[message.toolCallId]?.args" :result="message" />
        </template>
    </template>
    </template>
    <template v-for="(tool, id) in chat.toolStarts" :key="id">
      <ToolCall v-if="!calls.has(id) && !durableResults.has(id)" :id="id" :name="tool.name" :args="tool.args" :result="results.get(id)" :timestamp="tool.timestamp" />
    </template>
    <div v-for="message in pending" :key="message.requestId" class="msg user" :data-pending="message.requestId">
      <div class="user-content"><template v-for="(block, bi) in blocks(message.content)" :key="bi"><span v-if="block.type === 'text'">{{ block.text }}</span><img v-else-if="block.type === 'image'" class="att" :src="`data:${block.mimeType};base64,${block.data}`" alt="attachment" /></template></div>
      <div class="message-footer" role="status">{{ message.status }}</div>
    </div>
    <div v-if="chat.liveText || chat.liveThinking" class="msg assistant live-message">
      <details v-if="chat.liveThinking" class="thinking"><summary>Thinking</summary><pre>{{ chat.liveThinking }}</pre></details>
      <AssistantText v-if="chat.liveText" :text="chat.liveText" />
    </div>
    <div v-for="notice in chat.notices" :key="notice.id" :data-notice="notice.id" :class="['msg', 'chat-notice', notice.kind === 'err' ? 'err' : 'muted']">
      <span>{{ notice.text }}</span>
      <button type="button" aria-label="Dismiss notice" title="Dismiss notice" @click="dismissNotice(notice.id)"><X :size="16" aria-hidden="true" /></button>
    </div>
    <div v-if="activityLabel" id="activity" role="status" aria-live="polite">{{ activityLabel }}</div>
    <Questions />
  </div>
  <div class="transcript-jumps">
    <button id="jump-top" ref="jumpTopRef" type="button" hidden aria-label="Jump to top" title="Jump to top" @click="jumpToTop"><ArrowUp :size="18" aria-hidden="true" /></button>
    <button id="jump" ref="jumpRef" type="button" hidden aria-label="Jump to bottom" title="Jump to bottom" @click="jumpToBottom"><ArrowDown :size="18" aria-hidden="true" /></button>
  </div>
</template>
