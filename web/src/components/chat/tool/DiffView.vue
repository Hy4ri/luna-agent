<script setup lang="ts">
import type { DiffRow } from '@/lib/tool-view';
defineProps<{ rows: DiffRow[]; label: string }>();
</script>
<template>
  <div class="diff" role="table" :aria-label="label">
    <div v-for="(row, i) in rows" :key="i" class="diff-row vl-row" :data-kind="row.kind" role="row">
      <span class="diff-line" role="cell">{{ row.line ?? '' }}</span><span class="diff-sign" role="cell">{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : '' }}</span><span class="diff-text" role="cell">{{ row.text }}</span>
    </div>
  </div>
</template>
