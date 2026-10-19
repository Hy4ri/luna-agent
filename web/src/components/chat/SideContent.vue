<script setup lang="ts">
import { computed } from 'vue';
import { chat, type SideJob, type SideMedia } from '@/stores/chat';
import Markdown from './Markdown.vue';
const props = defineProps<{ job: SideJob }>();
const parts = computed(() => {
  const text = props.job.text || '';
  const result: { text?: string; media?: SideMedia }[] = [];
  let at = 0;
  const positions = (props.job.media || []).map(media => ({ media, index: text.indexOf(media.directive) })).filter(p => p.index >= 0).sort((a,b) => a.index-b.index);
  for (const p of positions) {
    if (p.index < at) continue;
    if (p.index > at) result.push({ text: text.slice(at,p.index) });
    result.push({ media:p.media });
    at = p.index+p.media.directive.length;
  }
  if (at < text.length) result.push({ text:text.slice(at) });
  return result;
});
</script>
<template>
  <div class="md">
    <template v-for="(part,i) in parts" :key="i">
      <Markdown v-if="part.text" :content="part.text" />
      <div v-else-if="part.media" class="side-media">
        <span v-if="chat.media[part.media.url]?.error" class="err">{{ chat.media[part.media.url]?.error }}</span>
        <span v-else-if="!chat.media[part.media.url]?.url" class="muted">Loading {{ part.media.name }}…</span>
        <template v-else>
          <img v-if="part.media.type === 'image'" class="att" :src="chat.media[part.media.url]?.url" :alt="part.media.name" />
          <audio v-else-if="part.media.type === 'voice'" :src="chat.media[part.media.url]?.url" controls preload="metadata" />
          <video v-else-if="part.media.type === 'video'" :src="chat.media[part.media.url]?.url" controls preload="metadata" />
          <a v-else :href="chat.media[part.media.url]?.url" :download="part.media.name">{{ part.media.name }}</a>
        </template>
      </div>
    </template>
  </div>
</template>
