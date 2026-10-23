<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { ImageOff } from '@lucide/vue';
import { api } from '@/lib/api';

const props = defineProps<{ path: string; name: string }>();
const source = ref(''), failed = ref(false);
let request: AbortController | undefined;
function release() {
  request?.abort();
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = '';
}
watch(() => props.path, async path => {
  release(); failed.value = false;
  const current = new AbortController(); request = current;
  try {
    const response = await api(path, { signal: current.signal });
    if (!response.ok) throw new Error(response.statusText);
    const blob = await response.blob();
    if (!current.signal.aborted) source.value = URL.createObjectURL(blob);
  } catch {
    if (!current.signal.aborted) failed.value = true;
  }
}, { immediate: true });
onUnmounted(release);
</script>

<template>
  <span class="board-image">
    <img v-if="source && !failed" :src="source" :alt="name" @error="failed = true" />
    <ImageOff v-else-if="failed" :size="16" role="img" :aria-label="`Preview unavailable for ${name}`" />
    <span v-else role="status" :aria-label="`Loading preview for ${name}`">…</span>
  </span>
</template>

<style scoped>
.board-image { width:64px; height:48px; flex:none; display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid var(--border); border-radius:var(--radius); background:var(--background); color:var(--muted-foreground); }
.board-image img { width:100%; height:100%; object-fit:contain; }
</style>
