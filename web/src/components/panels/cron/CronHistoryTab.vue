<script setup lang="ts">
import type { CronJob, CronRun } from "./state";
import CronRunRow from "./CronRunRow.vue";

defineProps<{
  jobs: CronJob[];
  historyRows: CronRun[];
  historyMore: boolean;
  historyJob: string;
  detailId: number | undefined;
  busy: boolean;
}>();

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
  <CronRunRow v-for="run in historyRows" :key="run.id" :run="run" :active="detailId === run.id" :busy="busy" show-unread @open="emit('openReport', $event)" />
  <p v-if="!historyRows.length" class="cron-empty-line">No reports in history.</p>
  <button v-if="historyMore" type="button" class="cron-btn cron-load-more" :disabled="busy" @click="emit('loadMore')">Load more</button>
</template>
