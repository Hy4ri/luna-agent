<script setup lang="ts">
import type { CronJob, CronRun } from "./state";
import CronRunRow from "./CronRunRow.vue";
import { computed } from "vue";
import { useVirtualList } from "@vueuse/core";

const props = defineProps<{
  jobs: CronJob[];
  historyRows: CronRun[];
  historyMore: boolean;
  historyJob: string;
  detailId: number | undefined;
  busy: boolean;
}>();

const { list: vHistory, containerProps, wrapperProps } = useVirtualList(computed(() => props.historyRows), { itemHeight: 88, overscan: 8 });
const emit = defineEmits<{
  (e: "update:historyJob", val: string): void;
  (e: "filterChange"): void;
  (e: "openReport", run: CronRun): void;
  (e: "loadMore"): void;
}>();
</script>

<template>
  <div class="cron-history">
    <div class="cron-filter">
      <label class="cron-filter-field">
        <span>Job</span>
        <select
          aria-label="Filter history by job"
          :value="historyJob"
          @change="emit('update:historyJob', ($event.target as HTMLSelectElement).value); emit('filterChange')"
        >
          <option value="">All jobs</option>
          <option v-for="job in jobs" :key="job.id" :value="String(job.id)">{{ job.name }}</option>
        </select>
      </label>
    </div>
    <div v-if="historyRows.length" v-bind="containerProps" class="cron-vlist">
      <div v-bind="wrapperProps">
        <CronRunRow v-for="{ data: run } in vHistory" :key="run.id" :run="run" :active="detailId === run.id" :busy="busy" show-unread @open="emit('openReport', $event)" />
      </div>
    </div>
    <div v-else class="cron-empty">
      <h3>No reports in history.</h3>
      <p>Read and superseded reports appear here.</p>
    </div>
    <button v-if="historyMore" type="button" class="cron-btn cron-load-more" :disabled="busy" @click="emit('loadMore')">Load more</button>
  </div>
</template>

<style scoped>
.cron-history { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.cron-history > .cron-filter { flex: none; }
.cron-history > .cron-vlist { flex: 1; height: auto; }
.cron-history > .cron-empty-line { flex: 1; }
.cron-history > .cron-load-more { flex: none; align-self: flex-start; }
/* Match the row geometry to the virtual window's fixed-height calculation. */
.cron-history :deep(.cron-item) { height: 88px; min-height: 88px; box-sizing: border-box; padding-block: 10px; }
</style>
