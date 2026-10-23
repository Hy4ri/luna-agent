<script setup lang="ts">
defineProps<{ title: string; description?: string; status?: string; timing?: string }>()
</script>
<template>
  <section class="settings-card">
    <header><div class="heading"><h3 tabindex="-1">{{ title }}</h3><span v-if="timing" class="timing">{{ timing }}</span></div><p v-if="description">{{ description }}</p><p v-if="status" class="status">{{ status }}</p></header>
    <div class="detail-fields"><slot /></div>
  </section>
</template>
<style scoped>
.settings-card { min-width: 0; padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); scroll-margin-top: 16px; }
header { margin-bottom: 20px; }
.heading { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
h3 { font-size: 17px; font-weight: 600; }
p { color: var(--muted-foreground); font-size: 14px; line-height: 1.6; margin-top: 6px; }
.timing { font-size: 12px; color: var(--muted-foreground); }
.status { font-size: 13px; overflow-wrap: anywhere; }
.detail-fields { display: grid; gap: 18px; min-width: 0; }
@media (max-width: 760px) { .settings-card { padding: 16px; } }
</style>
