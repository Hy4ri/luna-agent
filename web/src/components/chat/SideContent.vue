<script setup lang="ts">
import { computed } from 'vue';
import { type SideJob, type SideMedia } from '@/stores/chat';
import Attachment from './Attachment.vue';
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
      <Attachment v-else-if="part.media" :url="part.media.url" :name="part.media.name" :type="part.media.type" class="side-media" />
    </template>
  </div>
</template>
