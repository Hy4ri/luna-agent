<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { ChevronDown } from '@lucide/vue';
import { chat, usageText, contextView } from '@/stores/chat';
import ContextUsage from './ContextUsage.vue';
// Docked in the session rail: a plain open section instead of a header popover.
const props = defineProps<{ docked?: boolean }>();
const disclosure = ref<HTMLDetailsElement | null>(null);
const percent = computed(() => contextView.value?.known ? `${contextView.value.percent.toFixed(0)}%` : '—');
const cost = computed(() => {
  const rows = Object.values(chat.usage?.models || {}) as any[];
  const known = rows.filter(row => Number.isFinite(row.cost?.total));
  return known.length ? `$${known.reduce((sum, row) => sum + row.cost.total, 0).toFixed(4)}` : '';
});
function dismiss(event: PointerEvent | KeyboardEvent) {
  if (event instanceof KeyboardEvent ? event.key === 'Escape' : !disclosure.value?.contains(event.target as Node)) {
    if (disclosure.value) disclosure.value.open = false;
  }
}
watch(() => chat.session, () => { if (disclosure.value) disclosure.value.open = false; });
onMounted(() => { document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', dismiss); });
onUnmounted(() => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); });
</script>
<template>
  <section v-if="props.docked && (contextView || usageText)" id="statusbar" class="card rail-session" aria-label="Context and usage">
    <h4>Session</h4>
    <ContextUsage />
  </section>
  <details v-else-if="contextView || usageText" id="statusbar" ref="disclosure" class="usage-disclosure">
    <summary class="usage-summary" aria-label="Context and usage">
      <span class="usage-summary-label">Context</span><span class="usage-percent">{{ percent }}</span>
      <span v-if="cost" class="usage-cost" title="Estimated model cost">{{ cost }}</span><ChevronDown :size="12" aria-hidden="true" />
    </summary>
    <div class="usage-details">
      <ContextUsage />
    </div>
  </details>
</template>
