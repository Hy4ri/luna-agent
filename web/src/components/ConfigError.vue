<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { json, serverUrl, token } from '@/lib/api';
import { ui } from '@/stores/app';

const status = ref<{ error: string | null; path: string | null; recovery: boolean } | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let generation = 0;
async function check(own: number) {
  controller = new AbortController();
  try {
    const result = await json<NonNullable<typeof status.value>>('/v1/config/status', { signal: controller.signal });
    if (own === generation) status.value = result;
  } catch { /* Transport and authentication failures belong to the connection UI. */ }
  finally {
    if (own === generation) timer = setTimeout(() => { void check(own); }, 5000);
  }
}
watch([serverUrl, token, () => ui.login], () => {
  generation++;
  clearTimeout(timer); controller?.abort(); status.value = null;
  if (!ui.login) void check(generation);
}, { immediate: true });
onUnmounted(() => { generation++; clearTimeout(timer); controller?.abort(); });
</script>

<template>
  <section v-if="status?.error && !ui.login" class="config-error" role="alert" aria-label="Configuration error">
    <strong>Luna configuration error</strong>
    <p>{{ status.recovery ? 'The server is running, but the agent has not started.' : 'Luna is using the last valid settings.' }} Fix the file below; this message clears automatically.</p>
    <details><summary>Error details</summary><p>{{ status.path }}</p><pre>{{ status.error }}</pre></details>
  </section>
</template>

<style scoped>
.config-error { flex-shrink: 0; max-height: 35dvh; overflow: auto; border-bottom: 1px solid var(--destructive); background: var(--card); padding: 12px 16px; font-size: .875rem; }
p { margin-top: 4px; }
summary { cursor: pointer; padding: 8px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
summary:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }
</style>
