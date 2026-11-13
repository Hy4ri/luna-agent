<script setup lang="ts">
import { computed } from 'vue';
import Markdown from './Markdown.vue';
const props = defineProps<{ text: string }>();
const report = computed(() => {
  if (!props.text.startsWith('[Attached Cron report]\n')) return null;
  try {
    const value = JSON.parse(props.text.slice('[Attached Cron report]\n'.length));
    return typeof value.jobName === 'string' && typeof value.id === 'number' && typeof value.status === 'string' && typeof value.output === 'string' && typeof value.error === 'string' ? value : null;
  } catch { return null; }
});
</script>

<template>
  <details v-if="report" class="report-context">
    <summary>Cron report · {{ report.jobName }} · #{{ report.id }} · {{ report.status }}</summary>
    <div class="muted">{{ report.finished }}</div>
    <Markdown :content="report.output || '(No output)'" />
    <pre v-if="report.error">{{ report.error }}</pre>
  </details>
  <span v-else>{{ text }}</span>
</template>

<style scoped>
.report-context { border: 1px solid var(--border); padding: 8px 10px; white-space: normal; min-width: 0; }
summary { cursor: pointer; overflow-wrap: anywhere; }
summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
