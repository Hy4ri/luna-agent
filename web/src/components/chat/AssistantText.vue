<script setup lang="ts">
import { computed } from "vue";
import { segments } from "@/lib/segments";
import Markdown from "./Markdown.vue";
import Attachment from "./Attachment.vue";
import Widget from "./widgets/Widget.vue";

const props = defineProps<{ text: string; base?: string; offset?: number }>();

const parsedSegments = computed(() => {
  const mediaOpt = props.base !== undefined && props.offset !== undefined
    ? { base: props.base, offset: props.offset }
    : undefined;
  return segments(props.text, mediaOpt);
});
</script>

<template>
  <template v-for="(seg, i) in parsedSegments" :key="i">
    <Markdown v-if="seg.kind === 'md' && seg.text.trim()" :content="seg.text" />
    <Attachment v-else-if="seg.kind === 'media'" :url="seg.url" :name="seg.name" :type="seg.type as any" />
    <Widget v-else-if="seg.kind === 'ui'" :json="seg.json" :closed="seg.closed" :excess="seg.excess" />
  </template>
</template>
