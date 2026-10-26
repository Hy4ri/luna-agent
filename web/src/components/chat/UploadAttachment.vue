<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { Download, FileText, FileWarning, Loader2 } from "@lucide/vue";
import { api, serverUrl, token } from "@/lib/api";

const props = defineProps<{
  uploadId?: string;
  name: string;
  mimeType?: string;
  size?: number;
}>();

const objectUrl = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const isRasterImage = computed(() => {
  const mime = (props.mimeType || "").toLowerCase();
  return props.size !== 0 && /^(image\/(png|jpeg|gif|webp))$/i.test(mime);
});

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let activeAbort: AbortController | null = null;

function cleanup() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value);
    objectUrl.value = null;
  }
}

async function fetchBlob(id: string): Promise<string | null> {
  cleanup();
  loading.value = true;
  error.value = null;
  const controller = new AbortController();
  activeAbort = controller;

  try {
    const res = await api(`/v1/uploads/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (controller.signal.aborted) return null;
    const url = URL.createObjectURL(blob);
    objectUrl.value = url;
    return url;
  } catch (err) {
    if (controller.signal.aborted) return null;
    error.value = (err as Error).message || "Failed to load upload";
    return null;
  } finally {
    if (activeAbort === controller) {
      activeAbort = null;
      loading.value = false;
    }
  }
}

// Watch uploadId, serverUrl, and token. When any changes, abort/revoke stale blob loads.
// Raster images eager-load preview when rendered; generic files wait for on-demand download.
watch(
  [() => props.uploadId, serverUrl, token],
  ([id]) => {
    cleanup();
    error.value = null;
    loading.value = false;
    if (id && isRasterImage.value) {
      void fetchBlob(id);
    }
  },
  { immediate: true }
);

async function downloadFile() {
  if (!props.uploadId) return;
  if (objectUrl.value) {
    triggerBrowserDownload(objectUrl.value, props.name);
    return;
  }
  const url = await fetchBlob(props.uploadId);
  if (url) {
    triggerBrowserDownload(url, props.name);
  }
}

function triggerBrowserDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "download";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

onBeforeUnmount(() => {
  cleanup();
});
</script>

<template>
  <div class="attachment upload-attachment" data-attachment="file">
    <div v-if="error" class="att-file att-missing" role="alert">
      <FileWarning :size="18" aria-hidden="true" />
      <span class="att-meta">
        <span class="att-name">{{ name }}</span>
        <span class="att-sub">{{ error }}</span>
      </span>
    </div>
    <span v-else-if="loading && isRasterImage && !objectUrl" class="muted">Loading {{ name }}…</span>
    <template v-else-if="isRasterImage && objectUrl">
      <a
        :href="objectUrl"
        target="_blank"
        rel="noopener"
        :title="name"
      >
        <img class="att" :src="objectUrl" :alt="name" loading="lazy" />
      </a>
      <button type="button" class="att-download" :aria-label="`Download ${name}`" :title="`Download ${name}`" @click="downloadFile">
        <Download :size="16" aria-hidden="true" />
      </button>
    </template>
    <div v-else class="att-file">
      <FileText :size="18" aria-hidden="true" />
      <span class="att-meta">
        <span class="att-name">{{ name }}</span>
        <span class="att-sub">{{ formatSize(size) }}</span>
      </span>
      <button
        type="button"
        class="att-download"
        :aria-label="loading ? `Downloading ${name}…` : `Download ${name}`"
        :title="loading ? 'Downloading…' : 'Download'"
        :disabled="loading || !uploadId"
        @click="downloadFile"
      >
        <Loader2 v-if="loading" :size="16" class="spin" aria-hidden="true" />
        <Download v-else :size="16" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
