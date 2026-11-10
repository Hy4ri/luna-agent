<script setup lang="ts">
import { computed } from 'vue';
import { chat, contextView } from '@/stores/chat';
import { compactNumber } from '@/lib/numbers';

// Context: percent leads, the token counts are secondary detail.
const ctx = computed(() => {
  const view = contextView.value, value = chat.context;
  if (!view) return null;
  if (view.unavailable || !value) return { ...view, percentLabel: '', detail: 'Unavailable' };
  return {
    ...view,
    percentLabel: view.known ? `${view.percent.toFixed(view.percent < 10 ? 1 : 0)}%` : '',
    detail: view.known ? `≈${compactNumber(value.usedTokens)} / ${compactNumber(value.contextWindow)}` : `≈${compactNumber(value.usedTokens)} · capacity unknown`,
  };
});

// Usage totals per session. Input includes cache reads and writes; the title shows the split.
const usage = computed(() => {
  const rows = Object.values(chat.usage?.models || {}) as any[];
  if (!rows.length) return null;
  let fresh = 0, cacheRead = 0, cacheWrite = 0, output = 0, cost = 0, priced = 0;
  for (const row of rows) {
    fresh += row.input || 0; cacheRead += row.cacheRead || 0; cacheWrite += row.cacheWrite || 0; output += row.output || 0;
    if (Number.isFinite(row.cost?.total)) { cost += row.cost.total; priced++; }
  }
  const input = fresh + cacheRead + cacheWrite;
  const split = [`${compactNumber(fresh)} new`, cacheRead && `${compactNumber(cacheRead)} cache read`, cacheWrite && `${compactNumber(cacheWrite)} cache write`].filter(Boolean).join(' · ');
  return {
    input: compactNumber(input), inputTitle: `${input.toLocaleString()} input tokens: ${split}`,
    output: compactNumber(output), outputTitle: `${output.toLocaleString()} output tokens`,
    cost: priced ? `$${cost < 10 ? cost.toFixed(2) : cost.toFixed(0)}` : '—',
    costTitle: priced ? `$${cost.toFixed(4)} · estimated model cost, not an invoice` : 'No pricing for this model',
  };
});
</script>
<template>
  <div v-if="ctx" id="context-bar" :data-level="ctx.level" :title="ctx.title">
    <div class="ctx-head">
      <span class="ctx-label">Context</span>
      <span id="context-text">{{ ctx.detail }}<template v-if="ctx.percentLabel"> · <b class="ctx-percent">{{ ctx.percentLabel }}</b></template></span>
    </div>
    <div id="context-meter" :hidden="!ctx.known" role="progressbar" aria-label="Estimated context usage" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="ctx.percent" :aria-valuetext="ctx.valueText"><div id="context-fill" :style="{ width: ctx.percent + '%' }"></div></div>
  </div>
  <dl v-if="usage" id="usage" aria-label="Session usage">
    <div :title="usage.inputTitle"><dt>In</dt><dd>{{ usage.input }}</dd></div>
    <div :title="usage.outputTitle"><dt>Out</dt><dd>{{ usage.output }}</dd></div>
    <div :title="usage.costTitle"><dt>Cost</dt><dd>{{ usage.cost }}</dd></div>
  </dl>
</template>
