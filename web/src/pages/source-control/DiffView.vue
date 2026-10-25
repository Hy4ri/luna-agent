<script setup lang="ts">
import { computed } from "vue";
import type { DiffResult } from "./client";

const props = defineProps<{
  diff: DiffResult | null;
  loading: boolean;
}>();

const lines = computed(() => {
  if (!props.diff || !props.diff.text) return [];
  return props.diff.text.split("\n");
});
</script>

<template>
  <div class="flex flex-col h-full bg-background font-mono text-xs overflow-hidden">
    <div v-if="loading" class="flex items-center justify-center h-full text-muted-foreground">
      Loading diff…
    </div>
    <div v-else-if="!diff" class="flex items-center justify-center h-full text-muted-foreground italic">
      Select a file to view diff
    </div>
    <div v-else-if="diff.binary" class="flex items-center justify-center h-full text-muted-foreground italic">
      Binary file not shown
    </div>
    <div v-else-if="lines.length === 0" class="flex items-center justify-center h-full text-muted-foreground italic">
      No changes in file
    </div>
    <div v-else class="flex-1 overflow-auto p-2 space-y-0.5">
      <div v-if="diff.truncated" class="text-amber-500 pb-2 text-[11px]">
        Diff output truncated due to size limit.
      </div>
      <div
        v-for="(line, idx) in lines"
        :key="idx"
        class="whitespace-pre px-1 py-0.5 rounded leading-tight"
        :class="{
          'bg-emerald-500/10 text-emerald-400': line.startsWith('+') && !line.startsWith('+++'),
          'bg-rose-500/10 text-rose-400': line.startsWith('-') && !line.startsWith('---'),
          'text-primary font-semibold': line.startsWith('@@') || line.startsWith('diff --git'),
          'text-muted-foreground': !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@') && !line.startsWith('diff --git')
        }"
      >
        {{ line }}
      </div>
    </div>
  </div>
</template>
