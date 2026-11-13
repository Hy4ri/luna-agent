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

<style scoped>
.code-line { color: var(--muted-foreground); }
.code-more {
  min-height: 28px;
  padding: 4px 10px;
  margin: 8px 12px 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--secondary);
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.code-more:hover { border-color: var(--primary-text); }
.code-more:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (max-width: 760px), (pointer: coarse) {
  .code-more { min-height: 44px; padding: 8px 14px; }
}
</style>
