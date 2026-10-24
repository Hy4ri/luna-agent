<script setup lang="ts">
import { X, GitPullRequest } from '@lucide/vue';
import { navigate, ui } from '@/stores/app';

defineProps<{ inert?: boolean }>();
</script>

<template>
  <div class="flex h-full flex-col bg-card text-card-foreground" tabindex="-1">
    <header class="flex items-center justify-between border-b border-border px-6 py-4">
      <div class="flex items-center gap-3">
        <GitPullRequest :size="20" class="text-primary" />
        <h1 id="githubTitle" class="text-lg font-semibold">GitHub</h1>
      </div>
      <button
        id="github-menu"
        class="icon-button"
        aria-label="Close GitHub"
        title="Close GitHub"
        @click="navigate('chat')"
      >
        <X :size="18" />
      </button>
    </header>
    <div class="flex flex-1 items-center justify-center p-6 text-muted-foreground">
      <p class="text-sm">GitHub view shell pending full implementation.</p>
    </div>
  </div>
</template>
