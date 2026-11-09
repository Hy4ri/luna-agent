<script setup lang="ts">
import { ref } from 'vue';
import { Archive } from '@lucide/vue';
import type { StashEntry } from './client';
defineProps<{ stashes: StashEntry[]; disabled: boolean }>();
const emit = defineEmits<{ pop: [index: number]; drop: [index: number] }>();
const open = ref(false);
</script>
<template>
  <div v-if="stashes.length" class="text-[11px]">
    <button type="button" class="flex items-center gap-1 text-muted-foreground hover:text-foreground" :aria-expanded="open" @click="open = !open">
      <Archive :size="12" aria-hidden="true" /> {{ stashes.length }} stash{{ stashes.length === 1 ? '' : 'es' }}
    </button>
    <ul v-if="open" class="mt-1 space-y-1">
      <li v-for="s in stashes" :key="s.index" class="flex items-center gap-2 rounded border border-border px-2 py-1">
        <span class="flex-1 min-w-0 truncate" :title="s.subject">{{ s.subject.replace(/^On [^:]+: /, '') }}</span>
        <button type="button" class="underline disabled:opacity-50" :disabled="disabled" @click="emit('pop', s.index)">Apply</button>
        <button type="button" class="underline text-destructive disabled:opacity-50" :disabled="disabled" @click="emit('drop', s.index)">Drop</button>
      </li>
    </ul>
  </div>
</template>
