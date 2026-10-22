<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { IncrementalMarkdown } from "@/lib/markdown";

const props = defineProps<{ content: string }>();
const container = ref<HTMLElement | null>(null);

let inc: IncrementalMarkdown | null = null;
const render = () => {
  if (!container.value) return;
  inc ??= new IncrementalMarkdown(container.value);
  inc.update(props.content || "");
};

watch(() => props.content, render);
onMounted(render);
</script>

<template>
  <div ref="container" class="md"></div>
</template>
