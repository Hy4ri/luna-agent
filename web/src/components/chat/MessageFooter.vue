<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { formatTime, formatDateIso, copyToClipboard } from '@/lib/message';

const props = defineProps<{
  text: string;
  timestamp?: number | string;
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

onUnmounted(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="message-footer">
    <time v-if="timeDisplay" :datetime="isoDate" :title="fullDateTitle">
      {{ timeDisplay }}
    </time>
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
      {{ copied ? 'Copied to clipboard' : failed ? 'Failed to copy' : '' }}
    </span>
  </div>
</template>
