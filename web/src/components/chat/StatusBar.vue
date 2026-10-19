<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { ChevronDown } from '@lucide/vue';
import { chat, usageText, contextView } from '@/stores/chat';
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
  <details v-if="contextView || usageText" id="statusbar" ref="disclosure" class="usage-disclosure">
    <summary class="usage-summary" aria-label="Context and usage">
      <span class="usage-summary-label">Context</span><span class="usage-percent">{{ percent }}</span>
      <span v-if="cost" class="usage-cost" title="Estimated model cost">{{ cost }}</span><ChevronDown :size="12" aria-hidden="true" />
    </summary>
    <div class="usage-details">
      <div id="context-bar" :hidden="!contextView" :data-level="contextView?.level" :title="contextView?.title">
        <div id="context-meter" :hidden="!contextView?.known" role="progressbar" aria-label="Estimated context usage" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="contextView?.percent" :aria-valuetext="contextView?.valueText"><div id="context-fill" :style="{ width: contextView?.percent + '%' }"></div></div>
        <span id="context-text">{{ contextView?.text }}</span>
      </div>
      <div v-if="usageText" id="usage">{{ usageText }}</div>
    </div>
  </details>
</template>
