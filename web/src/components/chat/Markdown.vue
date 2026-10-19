<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { markdown } from "@/lib/markdown";

const props = defineProps<{ content: string }>();
const container = ref<HTMLElement | null>(null);

const render = () => {
  if (!container.value) return;
  container.value.replaceChildren(markdown(props.content || ""));
};

watch(() => props.content, render);
onMounted(render);
</script>

<template>
  <div ref="container" class="md"></div>
</template>
