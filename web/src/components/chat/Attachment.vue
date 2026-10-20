<script setup lang="ts">
// One MEDIA: attachment. Images, audio, and video render inline; everything else is a file card.
import { computed, watchEffect } from "vue";
import { Download, FileText, FileWarning } from "@lucide/vue";
import { chat, loadMedia } from "@/stores/chat";
const props = defineProps<{ url: string; name: string; type: string }>();
watchEffect(() => loadMedia(props.url));
const state = computed(() => chat.media[props.url]);
function size(n?: number) {
  if (n === undefined) return "";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
</script>

<template>
  <div class="attachment" :data-attachment="type">
    <div v-if="state?.error" class="att-file att-missing" role="alert">
      <FileWarning :size="18" aria-hidden="true" />
      <span class="att-meta"><span class="att-name">{{ name }}</span><span class="att-sub">{{ state.error }}</span></span>
    </div>
    <span v-else-if="!state?.url" class="muted">Loading {{ name }}…</span>
    <a v-else-if="type === 'image'" :href="state.url" target="_blank" rel="noopener" :title="name"><img class="att" :src="state.url" :alt="name" /></a>
    <audio v-else-if="type === 'voice'" :src="state.url" controls preload="metadata" :aria-label="name" />
    <video v-else-if="type === 'video'" class="att-video" :src="state.url" controls preload="metadata" :aria-label="name" />
    <div v-else class="att-file">
      <FileText :size="18" aria-hidden="true" />
      <span class="att-meta"><span class="att-name">{{ name }}</span><span class="att-sub">{{ size(state.size) }}</span></span>
      <a class="att-download" :href="state.url" :download="name" :aria-label="`Download ${name}`" title="Download"><Download :size="16" aria-hidden="true" /></a>
    </div>
  </div>
</template>
