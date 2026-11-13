<script setup lang="ts">
import { computed } from "vue";
import katex from "katex";
import "katex/dist/katex.min.css";
import Block from "./Block.vue";

const props = defineProps<{ source: string; closed: boolean }>();

// trust:false blocks \href, \url, \includegraphics, and raw HTML commands, so the output is inert markup.
const result = computed(() => {
  if (!props.closed) return { html: "", error: "" };
  try {
    return {
      html: katex.renderToString(props.source, { displayMode: true, throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000, output: "htmlAndMathml" }),
      error: "",
    };
  } catch (e) {
    return { html: "", error: `Math error: ${e instanceof Error ? e.message : String(e)}` };
  }
});
</script>

<template>
  <Block :source="source" label="Math" :building="closed ? undefined : 'Building formula…'" :error="result.error">
    <div class="math" v-html="result.html" />
  </Block>
</template>

<style scoped>
.math { padding: 8px 4px; overflow-x: auto; overflow-y: hidden; color: var(--foreground); font-size: 1.1em; direction: ltr; max-width: 100%; }
.math :deep(.katex-display) { margin: 0.35em 0; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
</style>
