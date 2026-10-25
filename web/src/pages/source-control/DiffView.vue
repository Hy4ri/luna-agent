<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DiffResult } from "./client";

const props = defineProps<{ diff: DiffResult | null; loading: boolean }>();
/** Lines drawn before "Show more": a 20,000-line diff would freeze the page. */
const PAGE = 2000;
const limit = ref(PAGE);
// Keep an expanded diff expanded across refreshes of the same file.
watch(() => props.diff?.path, () => { limit.value = PAGE; });
const lines = computed(() => props.diff?.text ? props.diff.text.replace(/\n$/, "").split("\n") : []);
function kind(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-400";
  if (line.startsWith("-")) return "bg-rose-500/10 text-rose-400";
  if (line.startsWith("@@") || line.startsWith("diff --git")) return "text-primary font-semibold";
  return "text-muted-foreground";
}
</script>

<template>
  <div class="flex flex-col h-full bg-background font-mono text-xs overflow-hidden">
    <div v-if="loading" class="flex items-center justify-center h-full text-muted-foreground">Loading diff…</div>
    <div v-else-if="!diff" class="flex items-center justify-center h-full text-muted-foreground">Select a file to view its diff</div>
    <div v-else-if="diff.directory" class="flex items-center justify-center h-full p-4 text-center text-muted-foreground">Untracked folder. Stage it to add all of its files.</div>
    <div v-else-if="diff.binary" class="flex items-center justify-center h-full text-muted-foreground">Binary file not shown</div>
    <div v-else-if="lines.length === 0" class="flex items-center justify-center h-full text-muted-foreground">No changes in file</div>
    <div v-else class="flex-1 overflow-auto p-2">
      <div v-if="diff.truncated" class="text-amber-500 pb-2 text-[11px]">Diff truncated at the size limit.</div>
      <pre class="leading-5"><span v-for="(line, idx) in lines.slice(0, limit)" :key="idx" class="block px-1 min-h-5" :class="kind(line)">{{ line }}</span></pre>
      <button v-if="lines.length > limit" type="button" class="mt-2 px-2 py-1 underline text-muted-foreground font-sans" @click="limit += PAGE * 5">Show more ({{ lines.length - limit }} lines left)</button>
    </div>
  </div>
</template>
