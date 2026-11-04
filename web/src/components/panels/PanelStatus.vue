<script setup lang="ts">
defineProps<{ loading?: boolean; error?: string; toasts?: string[] }>();
</script>

<template>
  <div v-if="toasts?.length" class="flex flex-col gap-1 mb-2">
    <div v-for="t in toasts" :key="t" class="muted text-xs">{{ t }}</div>
  </div>
  <p v-if="loading" class="muted" role="status">Loading…</p>
  <p v-if="error" class="msg err" role="alert">{{ error }}</p>
</template>
