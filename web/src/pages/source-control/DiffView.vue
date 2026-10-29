<script setup lang="ts">
import DiffBody from "./DiffBody.vue";
import type { DiffResult } from "./client";

defineProps<{ diff: DiffResult | null; loading: boolean; error?: string | null; empty?: string }>();
</script>

<template>
  <div class="flex flex-col h-full bg-background text-xs overflow-hidden">
    <div v-if="loading" class="flex items-center justify-center h-full text-muted-foreground">Loading diff…</div>
    <div v-else-if="error" role="alert" class="flex items-center justify-center h-full p-4 text-center text-destructive">{{ error }}</div>
    <div v-else-if="!diff" class="flex items-center justify-center h-full text-muted-foreground">{{ empty ?? 'Select a file to view its diff' }}</div>
    <div v-else-if="diff.directory" class="flex items-center justify-center h-full p-4 text-center text-muted-foreground">Untracked folder. Stage it to add all of its files.</div>
    <div v-else-if="diff.binary" class="flex items-center justify-center h-full text-muted-foreground">Binary file not shown</div>
    <div v-else-if="!diff.text.trim()" class="flex items-center justify-center h-full text-muted-foreground">No changes in file</div>
    <DiffBody v-else :id="diff.path" :text="diff.text" :truncated="diff.truncated" />
  </div>
</template>
