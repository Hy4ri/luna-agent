<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
defineProps<{ title: string; description?: string; status?: string; timing?: string }>()
</script>
<template>
  <details class="settings-card">
    <summary><ChevronRight :size="16" class="group-chevron" /><span class="group-heading"><span class="group-title">{{ title }}</span><span v-if="status" class="group-status">{{ status }}</span></span><span v-if="timing" class="group-timing">{{ timing }}</span></summary>
    <div class="group-content"><p v-if="description" class="group-description">{{ description }}</p><slot /></div>
  </details>
</template>
<style scoped>
.settings-card { min-width: 0; align-self: start; border: 1px solid var(--border); border-radius: 8px; background: var(--card); overflow: clip; }
summary { display: flex; align-items: center; gap: 12px; min-height: 76px; padding: 16px 20px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--accent); }
.group-chevron { flex-shrink: 0; color: var(--muted-foreground); }
details[open] > summary .group-chevron { transform: rotate(90deg); }
.group-heading { display: grid; gap: 4px; flex: 1; min-width: 0; }
.group-title { font-size: 15px; font-weight: 600; }
.group-status { font-size: 13px; color: var(--muted-foreground); overflow-wrap: anywhere; }
.group-timing { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.group-content { display: grid; gap: 20px; padding: 20px; border-top: 1px solid var(--border); min-width: 0; }
.group-description { font-size: 14px; line-height: 1.6; color: var(--muted-foreground); }
@media (max-width: 760px) { summary { padding: 14px; gap: 8px; flex-wrap: wrap; } .group-timing { margin-left: 24px; } .group-content { padding: 16px; } }
</style>
