<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { url } from "@/lib/api";
import { copyToClipboard } from "@/lib/message";
import { MAX_WIDGETS } from "@/lib/segments";

const props = defineProps<{ html: string; closed: boolean; excess?: boolean }>();
const showSource = ref(false);
const copyStatus = ref("copy");
const generation = ref(0);
const frame = ref<HTMLIFrameElement>();
const previewUrl = computed(() => url("/html-preview"));
const loadState = ref<"loading" | "ready" | "failed">("loading");
let sent = false;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function reload() {
  clearTimeout(loadTimer);
  sent = false;
  loadState.value = "loading";
  generation.value++;
  if (props.closed && !props.excess) {
    loadTimer = setTimeout(() => { loadState.value = "failed"; }, 10_000);
  }
}
watch([() => props.html, () => props.closed, () => props.excess, previewUrl], reload, { immediate: true });

function deliver(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.origin !== "null" || event.data?.type !== "luna:html-preview-ready") return;
  if (sent || !props.closed || props.excess) return;
  sent = true;
  clearTimeout(loadTimer);
  loadState.value = "ready";
  // The sandbox has an opaque origin, so a target origin cannot be specified.
  // Send once per fresh shell, never again after generated content navigates.
  frame.value?.contentWindow?.postMessage({ type: "luna:html-preview", html: props.html }, "*");
}
async function copy() {
  clearTimeout(timer);
  copyStatus.value = await copyToClipboard(props.html) ? "copied" : "copy failed";
  timer = setTimeout(() => { copyStatus.value = "copy"; }, 2000);
}
onMounted(() => window.addEventListener("message", deliver));
onUnmounted(() => {
  clearTimeout(timer);
  clearTimeout(loadTimer);
  window.removeEventListener("message", deliver);
});
</script>

<template>
  <section class="html-preview">
    <div class="preview-header">
      <span>HTML preview</span>
      <div class="preview-actions">
        <button v-if="closed && !excess" type="button" :aria-pressed="showSource" @click="showSource = !showSource">{{ showSource ? 'Preview' : 'Source' }}</button>
        <button v-if="closed && !excess" type="button" @click="reload">Reload</button>
        <button type="button" aria-label="Copy HTML" @click="copy">{{ copyStatus }}</button>
      </div>
    </div>
    <p v-if="!closed" class="preview-status" role="status">Building HTML preview…</p>
    <template v-else>
      <p v-if="excess" class="preview-status">Preview unavailable: more than {{ MAX_WIDGETS }} previews in one message.</p>
      <pre v-if="showSource || excess" class="code"><code>{{ html }}</code></pre>
      <p v-if="!excess && loadState !== 'ready'" class="preview-status" role="status">
        {{ loadState === 'failed' ? 'Preview did not respond. Check the daemon connection and reload.' : 'Loading HTML preview…' }}
      </p>
      <div v-if="!excess" v-show="!showSource" class="preview-viewport">
        <iframe
          :key="generation"
          ref="frame"
          :src="previewUrl"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          title="Sandboxed HTML preview"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.html-preview {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  min-width: 0;
}
.preview-header, .preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview-header {
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--muted-foreground);
}
button {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--secondary);
  color: var(--foreground);
  cursor: pointer;
}
button:hover { background: var(--accent); }
.preview-status { padding: 8px 12px; color: var(--muted-foreground); font-size: 13px; }
.preview-viewport {
  height: 360px;
  min-height: 180px;
  resize: vertical;
  overflow: hidden;
  background: white;
}
iframe { display: block; width: 100%; height: 100%; border: 0; }
pre { margin: 0; padding: 12px; max-height: 480px; overflow: auto; }
</style>
