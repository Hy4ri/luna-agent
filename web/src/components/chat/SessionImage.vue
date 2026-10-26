<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ImageOff } from "@lucide/vue";
import { api, serverUrl, token } from "@/lib/api";

const props = defineProps<{ image: { url?: string; data?: string; mimeType: string }; alt: string }>();
const source = ref("");
const failed = ref(false);
let request: AbortController | undefined;
function cleanup() {
  request?.abort();
  request = undefined;
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = "";
}
const inline = computed(() => !props.image.url && props.image.data && /^image\/(png|jpeg|gif|webp)$/.test(props.image.mimeType)
  ? `data:${props.image.mimeType};base64,${props.image.data}` : "");
watch([() => props.image.url, () => props.image.data, () => props.image.mimeType, serverUrl, token], async ([path]) => {
  cleanup();
  failed.value = false;
  if (!path) return;
  // Only daemon-generated session paths may receive the authorization header.
  if (!/^\/v1\/sessions\/[^/]+\/entries\/\d+\/images\/\d+$/.test(path)) {
    failed.value = true;
    return;
  }
  const current = new AbortController();
  request = current;
  try {
    const response = await api(path, { signal: current.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) throw new Error("Invalid image type");
    if (!current.signal.aborted) source.value = URL.createObjectURL(blob);
  } catch {
    if (!current.signal.aborted) failed.value = true;
  } finally {
    if (request === current) request = undefined;
  }
}, { immediate: true });
onBeforeUnmount(cleanup);
</script>

<template>
  <img v-if="!failed && (source || inline)" :src="source || inline" :alt="alt" @error="failed = true" />
  <span v-else-if="failed" role="img" :aria-label="`${alt}: image unavailable`" title="Image unavailable"><ImageOff :size="20" /></span>
  <span v-else role="status" :aria-label="`Loading ${alt}`">Loading image…</span>
</template>
