<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { formatTime, formatDateIso, copyToClipboard } from '@/lib/message';
import { post } from '@/lib/api';
import { chat, openSession } from '@/stores/chat';
import { loadSessions } from '@/stores/sessions';

const props = defineProps<{
  text: string;
  timestamp?: number | string;
  entryId?: number | string;
}>();

const copied = ref(false);
const failed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

const hasTimestamp = computed(() => props.timestamp !== undefined && props.timestamp !== null && props.timestamp !== '');
const timeDisplay = computed(() => hasTimestamp.value ? formatTime(props.timestamp) : '');
const isoDate = computed(() => hasTimestamp.value ? formatDateIso(props.timestamp) : '');
const fullDateTitle = computed(() => {
  if (!hasTimestamp.value) return '';
  const d = new Date(typeof props.timestamp === 'number' ? props.timestamp : String(props.timestamp));
  return isNaN(d.getTime()) ? String(props.timestamp) : d.toLocaleString();
});

async function handleCopy() {
  if (timer) clearTimeout(timer);
  const ok = await copyToClipboard(props.text);
  if (disposed) return;
  if (ok) {
    copied.value = true;
    failed.value = false;
  } else {
    failed.value = true;
    copied.value = false;
  }
  timer = setTimeout(() => {
    copied.value = false;
    failed.value = false;
  }, 2000);
}

// Fork this session from this entry: a new session that starts with the model context as of this message.
const forking = ref(false);
const forked = ref(false);
const forkFailed = ref(false);
const forkMsg = ref('');
let forkTimer: ReturnType<typeof setTimeout> | null = null;

async function handleFork() {
  if (forking.value || forked.value || !chat.session || props.entryId === undefined) return;
  forking.value = true;
  forkFailed.value = false;
  try {
    const { id } = await post<{ id: number | string }>(`/v1/sessions/${chat.session}/fork`, { at: props.entryId });
    forked.value = true;
    openSession(id).catch(() => {});
    loadSessions().catch(() => {});
    if (forkTimer) clearTimeout(forkTimer);
    forkTimer = setTimeout(() => { forked.value = false; }, 2000);
  } catch (e) {
    forkFailed.value = true;
    forkMsg.value = (e as Error).message || String(e);
    if (forkTimer) clearTimeout(forkTimer);
    forkTimer = setTimeout(() => { forkFailed.value = false; }, 2000);
  } finally {
    forking.value = false;
  }
}

onUnmounted(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
  if (forkTimer) clearTimeout(forkTimer);
});
</script>

<template>
  <div class="message-footer">
    <time v-if="timeDisplay" :datetime="isoDate" :title="fullDateTitle">
      {{ timeDisplay }}
    </time>
    <button
      v-if="props.entryId !== undefined && chat.session"
      type="button"
      class="icon-button fork-btn"
      aria-label="Fork from this message"
      :title="forkFailed ? 'Fork failed: ' + forkMsg : 'Fork from this message'"
      :disabled="forking"
      @click="handleFork"
    >
      <span v-if="forkFailed" class="copy-err" aria-label="Fork failed" :title="forkMsg">!</span>
      <svg v-else-if="forked" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
    </button>
    <button
      v-if="text"
      type="button"
      class="icon-button copy-btn"
      aria-label="Copy message"
      title="Copy message"
      @click="handleCopy"
    >
      <svg v-if="!copied && !failed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      <svg v-else-if="copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      <span v-else class="copy-err" aria-label="Copy failed">!</span>
    </button>
    <span class="sr-only" aria-live="polite">
      {{ copied ? 'Copied to clipboard' : failed ? 'Failed to copy' : forkFailed ? 'Fork failed' : '' }}
    </span>
  </div>
</template>
