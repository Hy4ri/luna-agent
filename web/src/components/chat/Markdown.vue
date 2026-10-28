<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { IncrementalMarkdown } from "@/lib/markdown";
import { openImage } from "@/stores/image-viewer";

const props = defineProps<{ content: string }>();
const container = ref<HTMLElement | null>(null);

let inc: IncrementalMarkdown | null = null;
const render = () => {
  if (!container.value) return;
  inc ??= new IncrementalMarkdown(container.value);
  inc.update(props.content || "");
};

function zoom(e: MouseEvent) {
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  if (!img?.src) return;
  e.preventDefault();
  openImage(img.currentSrc || img.src, img.alt);
}

watch(() => props.content, render);
onMounted(render);
</script>

<template>
  <div ref="container" class="md" @click="zoom"></div>
</template>
