<script setup lang="ts">
import { computed } from "vue";

/** refs from the server: head:main, local:x, remote:origin/x, tag:v1, or HEAD (detached). */
const props = defineProps<{ refs: string[]; limit?: number }>();
const KINDS: Record<string, { cls: string; title: string }> = {
  head: { cls: "bg-primary text-primary-foreground font-semibold", title: "Current branch" },
  local: { cls: "bg-emerald-500/15 text-emerald-400", title: "Local branch" },
  remote: { cls: "bg-muted text-muted-foreground", title: "Remote branch" },
  tag: { cls: "bg-amber-500/15 text-amber-400", title: "Tag" },
};
const chips = computed(() => props.refs.map(ref => {
  const at = ref.indexOf(":"), kind = KINDS[ref.slice(0, at)];
  return kind ? { text: ref.slice(at + 1), ...kind } : { text: ref, cls: KINDS.head!.cls, title: ref === "HEAD" ? "Detached HEAD" : "Ref" };
}));
const shown = computed(() => props.limit ? chips.value.slice(0, props.limit) : chips.value);
</script>

<template>
  <span v-if="chips.length" class="inline-flex items-center gap-1 shrink-0 max-w-[60%] overflow-hidden">
    <span v-for="chip in shown" :key="chip.title + chip.text" class="px-1 rounded text-[10px] leading-4 truncate max-w-[140px]" :class="chip.cls" :title="`${chip.title}: ${chip.text}`">{{ chip.text }}</span>
    <span v-if="shown.length < chips.length" class="text-[10px] text-muted-foreground" :title="chips.slice(shown.length).map(c => c.text).join(', ')">+{{ chips.length - shown.length }}</span>
  </span>
</template>
