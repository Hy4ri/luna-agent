<script setup lang="ts">
// One MEDIA: attachment. Images, audio, and video render inline; everything else is a file card.
import { computed, ref, watchEffect } from "vue";
import { Download, FileText, FileWarning } from "@lucide/vue";
import { chat, loadMedia } from "@/stores/chat";
import { openImage } from "@/stores/image-viewer";
import { saveFile } from "@/lib/platform";
import { useNearViewport } from "@/lib/near-viewport";
const props = defineProps<{ url: string; name: string; type: string }>();
const root = ref<HTMLElement | null>(null);
// Fetch media only when it approaches the visible part of the transcript.
const near = useNearViewport(root);
watchEffect(() => { if (near.value) loadMedia(props.url); });
const state = computed(() => chat.media[props.url]);
const saveError = ref("");
async function download() {
  const url = state.value?.url;
  if (!url) return;
  saveError.value = "";
  try {
    await saveFile(await (await fetch(url)).blob(), props.name);
  } catch (e) {
    saveError.value = (e as Error)?.message || String(e) || "Could not save the file";
  }
}
function size(n?: number) {
  if (n === undefined) return "";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
</script>

<template>
  <div ref="root" class="attachment" :data-attachment="type">
    <div v-if="state?.error" class="att-file att-missing" role="alert">
      <FileWarning :size="18" aria-hidden="true" />
      <span class="att-meta"><span class="att-name">{{ name }}</span><span class="att-sub">{{ state.error }}</span></span>
    </div>
    <span v-else-if="!state?.url" class="muted">Loading {{ name }}…</span>
    <img v-else-if="type === 'image'" class="att zoomable" :src="state.url" :alt="name" :title="name" @click="openImage(state.url, name)" />
    <audio v-else-if="type === 'voice'" :src="state.url" controls preload="metadata" :aria-label="name" />
    <video v-else-if="type === 'video'" class="att-video" :src="state.url" controls preload="metadata" :aria-label="name" />
    <div v-else class="att-file">
      <FileText :size="18" aria-hidden="true" />
      <span class="att-meta"><span class="att-name">{{ name }}</span><span class="att-sub" :role="saveError ? 'alert' : undefined">{{ saveError || size(state.size) }}</span></span>
      <button type="button" class="att-download" :aria-label="`Download ${name}`" title="Download" @click="download"><Download :size="16" aria-hidden="true" /></button>
    </div>
  </div>
</template>
