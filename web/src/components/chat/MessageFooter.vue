<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { AlertCircle, Check, Copy, GitFork } from '@lucide/vue';
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
      <AlertCircle v-if="forkFailed" :size="14" class="copy-err" aria-hidden="true" />
      <Check v-else-if="forked" :size="14" aria-hidden="true" />
      <GitFork v-else :size="14" aria-hidden="true" />
    </button>
    <button
      v-if="text"
      type="button"
      class="icon-button copy-btn"
      aria-label="Copy message"
      title="Copy message"
      @click="handleCopy"
    >
      <Copy v-if="!copied && !failed" :size="14" aria-hidden="true" />
      <Check v-else-if="copied" :size="14" aria-hidden="true" />
      <AlertCircle v-else :size="14" class="copy-err" aria-hidden="true" />
    </button>
    <span class="sr-only" aria-live="polite">
      {{ copied ? 'Copied to clipboard' : failed ? 'Failed to copy' : forkFailed ? 'Fork failed' : '' }}
    </span>
  </div>
</template>

<style scoped>
.message-footer { color: var(--muted-foreground); }
.copy-err { color: var(--destructive); }
@media (max-width: 760px), (pointer: coarse) {
  .message-footer { gap: 4px; }
  .message-footer .icon-button { min-width: 44px; min-height: 44px; width: 44px; height: 44px; }
}
</style>
