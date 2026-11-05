<script setup lang="ts">
import type { CronRun } from "./state";
import CronRunRow from "./CronRunRow.vue";
import { computed } from "vue";
import { useVirtualList } from "@vueuse/core";

const props = defineProps<{
  inbox: CronRun[];
  detailId: number | undefined;
  busy: boolean;
  hasMore: boolean;
  loading: boolean;
}>();

const { list: vInbox, containerProps, wrapperProps } = useVirtualList(computed(() => props.inbox), { itemHeight: 88, overscan: 8 });
const emit = defineEmits<{
  (e: "openReport", run: CronRun): void;
  (e: "loadMore"): void;
}>();
</script>

<template>
  <div class="cron-reports">
  <div v-if="loading && !inbox.length" class="cron-vlist" role="status" aria-label="Loading reports" aria-busy="true">
    <div v-for="i in 3" :key="i" class="cron-item" style="opacity: 0.5; pointer-events: none;">
      <span class="cron-item-outcome">Loading report…</span>
      <span class="cron-item-meta">
        <span class="cron-pill">…</span>
        <span class="cron-item-job">…</span>
      </span>
    </div>
  </div>
  <div v-else-if="inbox.length" v-bind="containerProps" class="cron-vlist" :aria-busy="loading"><div v-bind="wrapperProps"><CronRunRow v-for="{ data: run } in vInbox" :key="run.id" :run="run" :active="detailId === run.id" :busy="busy" @open="emit('openReport', $event)" /></div></div>
  <div v-else class="cron-empty">
    <h3>No new reports.</h3>
    <p>Read and replaced reports are in History.</p>
  </div>
  <button v-if="hasMore" type="button" class="cron-btn cron-load-more" :disabled="busy || loading" @click="emit('loadMore')">{{ loading ? "Loading…" : "Load more" }}</button>
  </div>
</template>

<style scoped>
.cron-reports { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.cron-reports > .cron-vlist { flex: 1; height: auto; }
.cron-reports > .cron-load-more { flex: none; align-self: flex-start; }
/* Match the row geometry to the virtual window's fixed-height calculation. */
.cron-reports :deep(.cron-item) { height: 88px; min-height: 88px; box-sizing: border-box; padding-block: 10px; }
</style>
