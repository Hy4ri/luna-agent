<script setup lang="ts">
import { computed, ref } from "vue";
import { RefreshCw } from "@lucide/vue";
import { useIntervalFn } from "@vueuse/core";
import { models } from "@/stores/models";

const props = defineProps<{ loading?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();

const now = ref(Date.now());
useIntervalFn(() => { now.value = Date.now(); }, 30_000);
const busy = computed(() => props.loading || !!models.refresh?.refreshing);
const stamp = computed(() => {
  if (busy.value) return "Refreshing…";
  const at = models.refresh?.checkedAt;
  if (!at) return "";
  const min = Math.max(0, Math.floor((now.value - at) / 60_000));
  if (min < 1) return "Checked just now";
  if (min < 60) return `Checked ${min} min ago`;
  const h = Math.floor(min / 60);
  return `Checked ${h} h ago`;
});
</script>

<template>
  <div class="mr-wrap">
    <span v-if="stamp" class="mr-stamp" aria-live="polite">{{ stamp }}</span>
    <button
      type="button"
      class="mr-btn"
      :disabled="busy"
      :aria-busy="busy"
      title="Refresh models"
      aria-label="Refresh models"
      @click="emit('refresh')"
    >
      <RefreshCw :size="14" :class="{ 'mr-spin': busy }" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.mr-wrap { flex: none; display: flex; align-items: center; gap: 8px; }
.mr-stamp { font-size: 11px; color: var(--muted-foreground); white-space: nowrap; }
.mr-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 1px; background: transparent; color: var(--muted-foreground); cursor: pointer; }
.mr-btn:hover:not(:disabled) { color: var(--foreground); background: var(--accent); }
.mr-btn:disabled { cursor: default; color: var(--foreground); border-color: var(--primary); }
.mr-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.mr-spin { animation: mr-spin 1s linear infinite; }
@keyframes mr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mr-spin { animation: none; } }
@media (pointer: coarse) { .mr-btn { width: 36px; height: 36px; } }
</style>
