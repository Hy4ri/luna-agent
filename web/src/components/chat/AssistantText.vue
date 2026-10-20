<script setup lang="ts">
// Assistant text with MEDIA: directives replaced, in place, by their attachments.
import { computed } from "vue";
import { mediaDirectives } from "@/lib/media";
import Markdown from "./Markdown.vue";
import Attachment from "./Attachment.vue";
const props = defineProps<{ text: string; base: string; offset: number }>();
const parts = computed(() => {
  const out: { text?: string; media?: { url: string; name: string; type: string } }[] = [];
  let at = 0;
  mediaDirectives(props.text).forEach((d, i) => {
    if (d.index > at) out.push({ text: props.text.slice(at, d.index) });
    out.push({ media: { url: `${props.base}/${props.offset + i}`, name: d.name, type: d.type } });
    at = d.index + d.directive.length;
  });
  if (at < props.text.length) out.push({ text: props.text.slice(at) });
  return out;
});
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <Markdown v-if="part.text?.trim()" :content="part.text" />
    <Attachment v-else-if="part.media" v-bind="part.media" />
  </template>
</template>
