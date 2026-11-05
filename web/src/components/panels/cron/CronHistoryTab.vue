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
  <div v-bind="containerProps" class="cron-vlist"><div v-bind="wrapperProps"><CronRunRow v-for="{ data: run } in vHistory" :key="run.id" :run="run" :active="detailId === run.id" :busy="busy" show-unread @open="emit('openReport', $event)" /></div></div>
  <p v-if="!historyRows.length" class="cron-empty-line">No reports in history.</p>
  <button v-if="historyMore" type="button" class="cron-btn cron-load-more" :disabled="busy" @click="emit('loadMore')">Load more</button>
</template>
