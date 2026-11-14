<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { segments } from "@/lib/segments";
import Markdown from "./Markdown.vue";
import Attachment from "./Attachment.vue";
import UiBlock from "./genui/UiBlock.vue";
import HtmlBlock from "./genui/HtmlBlock.vue";
// Mermaid and KaTeX are large; they load only when a message uses them.
const MermaidBlock = defineAsyncComponent(() => import("./genui/MermaidBlock.vue"));
const MathBlock = defineAsyncComponent(() => import("./genui/MathBlock.vue"));

const props = defineProps<{ text: string; base?: string; offset?: number; streaming?: boolean }>();

const parsedSegments = computed(() => {
  const mediaOpt = props.base !== undefined && props.offset !== undefined
    ? { base: props.base, offset: props.offset }
    : undefined;
  return segments(props.text, mediaOpt);
});

const lastMdIndex = computed(() => {
  for (let i = parsedSegments.value.length - 1; i >= 0; i--) {
    const seg = parsedSegments.value[i];
    if (seg.kind === "md" && seg.text.trim()) return i;
  }
  return -1;
});
</script>

<template>
  <template v-for="(seg, i) in parsedSegments" :key="i">
    <Markdown v-if="seg.kind === 'md' && seg.text.trim()" :content="seg.text" :streaming="props.streaming && i === lastMdIndex" />
    <Attachment v-else-if="seg.kind === 'media'" :url="seg.url" :name="seg.name" :type="seg.type as any" />
    <template v-else-if="seg.kind === 'block'">
      <UiBlock v-if="seg.lang === 'ui'" :source="seg.source" :closed="seg.closed" :excess="seg.excess" />
      <HtmlBlock v-else-if="seg.lang === 'html'" :source="seg.source" :closed="seg.closed" :excess="seg.excess" />
      <MermaidBlock v-else-if="seg.lang === 'mermaid'" :source="seg.source" :closed="seg.closed" />
      <MathBlock v-else :source="seg.source" :closed="seg.closed" />
    </template>
  </template>
</template>
