<script setup lang="ts">
import { computed, ref } from 'vue';
import { codeLines } from '@/lib/tool-view';
const props = defineProps<{ text: string; start?: number }>();
const LIMIT = 40;
const all = ref(false);
const lines = computed(() => codeLines(props.text, props.start ?? 1));
const shown = computed(() => all.value ? lines.value : lines.value.slice(0, LIMIT));
</script>
<template>
  <div class="code-view">
    <div v-for="row in shown" :key="row.line" class="code-row vl-row"><span class="code-line">{{ row.line }}</span><span class="code-text">{{ row.text }}</span></div>
    <button v-if="lines.length > LIMIT" type="button" class="code-more" @click="all = !all">{{ all ? 'Show less' : `Show all ${lines.length} lines` }}</button>
  </div>
</template>
