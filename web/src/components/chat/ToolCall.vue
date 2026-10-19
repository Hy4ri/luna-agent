<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, CircleAlert, LoaderCircle, ChevronRight } from '@lucide/vue';
import { chat, openSession } from '@/stores/chat';
import { formatTime, formatDateIso } from '@/lib/message';
const props = defineProps<{ id: string; name: string; args?: unknown; result?: any; timestamp?: number | string }>();
const expanded = ref(false);
const result = computed(() => props.result ?? chat.toolResults[props.id]);
const state = computed(() => result.value ? result.value.isError === true ? 'failed' : 'complete' : chat.activeTools.has(props.id) ? 'running' : 'pending');
const output = computed(() => {
  if (!result.value) return chat.toolLive[props.id] || '';
  const content = result.value.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  return content !== undefined ? JSON.stringify(content, null, 2) : '';
});
const argumentsText = computed(() => props.args === undefined ? '' : JSON.stringify(props.args, null, 2));
const images = computed(() => (Array.isArray(result.value?.content) ? result.value.content : []).filter((b: any) => b.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(b.mimeType) && typeof b.data === 'string'));
const child = computed(() => /spawned child (\d+)/.exec(output.value)?.[1]);
const timestamp = computed(() => result.value?.timestamp ?? chat.toolStarts[props.id]?.timestamp ?? props.timestamp);
const fullDate = computed(() => formatDateIso(timestamp.value) ? new Date(timestamp.value).toLocaleString() : '');
</script>
<template>
  <div class="tool" :data-call="id" :data-state="state">
    <details :open="expanded" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
      <summary>
        <CircleAlert v-if="state === 'failed'" :size="14" class="tool-status-icon" aria-hidden="true" />
        <Check v-else-if="state === 'complete'" :size="14" aria-hidden="true" />
        <LoaderCircle v-else :size="14" aria-hidden="true" />
        <span class="tool-name">{{ name }}</span>
        <span class="tool-state">{{ state === 'failed' ? 'Failed' : state === 'complete' ? 'Complete' : state === 'running' ? 'Running' : 'No result' }}</span>
        <a v-if="child" href="#" @click.prevent.stop="openSession(child)">Child {{ child }}</a>
        <ChevronRight :size="13" class="disclosure-chevron" aria-hidden="true" />
      </summary>
      <div v-if="argumentsText" class="tool-section"><span class="tool-section-label">Arguments</span><pre>{{ argumentsText }}</pre></div>
      <div v-if="state !== 'failed' && output" class="tool-section"><span class="tool-section-label">Output</span><pre>{{ output }}</pre></div>
      <img v-for="(image, i) in images" :key="i" class="tool-image" :src="`data:${image.mimeType};base64,${image.data}`" :alt="name + ' result'" />
    </details>
    <div v-if="state === 'failed'" class="tool-error"><span class="tool-section-label">Error</span><pre>{{ output || 'The tool failed without error details.' }}</pre></div>
    <div v-if="formatTime(timestamp)" class="tool-footer"><time :datetime="formatDateIso(timestamp)" :title="fullDate">{{ formatTime(timestamp) }}</time></div>
  </div>
</template>
