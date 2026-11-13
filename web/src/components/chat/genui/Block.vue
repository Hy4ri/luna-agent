<script setup lang="ts">
// Shared frame for every rich block: no header chrome, a small toolbar on hover/focus (always on touch).
import { onUnmounted, ref } from "vue";
import { Code, Copy, Check, Eye } from "@lucide/vue";
import { copyToClipboard } from "@/lib/message";

const props = defineProps<{
  source: string;
  label: string;
  /** Present while the fence is still streaming. */
  building?: string;
  /** Validation or render error: the source shows with this message. */
  error?: string;
}>();

const showSource = ref(false);
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  clearTimeout(timer);
  copied.value = await copyToClipboard(props.source);
  timer = setTimeout(() => { copied.value = false; }, 2000);
}
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <figure class="gen-block" :aria-label="label">
    <p v-if="building" class="gen-status" role="status">{{ building }}</p>
    <template v-else>
      <div class="gen-tools">
        <slot name="tools" />
        <button v-if="!error" type="button" :aria-pressed="showSource" :title="showSource ? 'Show result' : 'Show source'" :aria-label="showSource ? 'Show result' : 'Show source'" @click="showSource = !showSource">
          <Eye v-if="showSource" :size="14" /><Code v-else :size="14" />
        </button>
        <button type="button" :title="copied ? 'Copied' : 'Copy source'" :aria-label="copied ? 'Copied' : 'Copy source'" @click="copy">
          <Check v-if="copied" :size="14" /><Copy v-else :size="14" />
        </button>
      </div>
      <template v-if="error || showSource">
        <pre class="gen-source"><code>{{ source }}</code></pre>
        <p v-if="error" class="gen-error" role="alert">{{ error }}</p>
      </template>
      <div v-show="!error && !showSource" class="gen-body"><slot /></div>
    </template>
  </figure>
</template>

<style scoped>
.gen-block { position: relative; margin: 10px 0; min-width: 0; max-width: 100%; }
.gen-status { margin: 0; padding: 10px 0; font-size: 13px; color: var(--muted-foreground); }
.gen-tools {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  display: flex; gap: 4px;
  opacity: 0; transition: opacity .15s;
}
.gen-block:hover .gen-tools, .gen-block:focus-within .gen-tools { opacity: 1; }
@media (hover: none) { .gen-tools { opacity: 1; } }
.gen-tools :deep(button) {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  color: var(--muted-foreground); background: color-mix(in srgb, var(--card) 90%, transparent);
  border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer;
}
.gen-tools :deep(button:hover), .gen-tools :deep(button[aria-pressed="true"]) { color: var(--foreground); border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); }
.gen-tools :deep(button:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (hover: none), (max-width: 760px), (pointer: coarse) {
  .gen-tools { opacity: 1; gap: 6px; }
  .gen-tools :deep(button) { min-width: 44px; min-height: 44px; width: 44px; height: 44px; }
  .gen-source { padding-top: 56px; }
}
.gen-source {
  margin: 0; padding: 12px; padding-top: 40px; overflow: auto; max-height: 480px;
  font: 13px/1.5 var(--mono); background: var(--sidebar); border: 1px solid var(--border); border-radius: var(--radius);
  direction: ltr; text-align: left;
}
.gen-error { margin: 6px 0 0; font-size: 13px; color: var(--destructive); }
.gen-body { min-width: 0; }
</style>
