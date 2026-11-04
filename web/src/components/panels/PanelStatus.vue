<script setup lang="ts">
defineProps<{ loading?: boolean; error?: string }>();
</script>

<template>
  <p v-if="loading" class="muted" role="status">Loading…</p>
  <p v-if="error" class="msg err" role="alert">{{ error }}</p>
</template>
