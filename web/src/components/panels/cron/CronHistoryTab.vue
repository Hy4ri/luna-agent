<script setup lang="ts">
import type { CronJob, CronRun } from "./state";
import { date, timeAgo, statusLabel, outcome } from "./formatters";

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
  <button
    v-for="run in historyRows"
    :key="run.id"
    :disabled="busy"
    type="button"
    class="cron-item"
    :class="{ active: detailId === run.id }"
    :data-run="run.id"
    @click="emit('openReport', run)"
  >
    <span class="cron-item-outcome" :class="run.status" dir="auto">{{ outcome(run) }}</span>
    <span class="cron-item-meta">
      <span class="cron-pill" :class="run.status">{{ statusLabel(run) }}</span>
      <span v-if="run.readAt === null" class="cron-pill unread">Unread</span>
      <span class="cron-item-job" dir="auto">{{ run.jobName }}</span>
      <span class="cron-item-time" :title="date(run.endedAt || run.startedAt)">{{ timeAgo(run.endedAt || run.startedAt) }}</span>
    </span>
  </button>
  <p v-if="!historyRows.length" class="cron-empty-line">No reports in history.</p>
  <button v-if="historyMore" type="button" class="cron-btn cron-load-more" :disabled="busy" @click="emit('loadMore')">Load more</button>
</template>
