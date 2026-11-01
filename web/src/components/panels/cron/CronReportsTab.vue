<script setup lang="ts">
import type { CronRun } from "./state";
import { date, timeAgo, statusLabel, outcome } from "./formatters";

defineProps<{
  inbox: CronRun[];
  detailId: number | undefined;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: "openReport", run: CronRun): void;
}>();
</script>

<template>
  <button
    v-for="run in inbox"
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
      <span class="cron-item-job" dir="auto">{{ run.jobName }}</span>
      <span class="cron-item-time" :title="date(run.endedAt || run.startedAt)">{{ timeAgo(run.endedAt || run.startedAt) }}</span>
    </span>
  </button>
  <div v-if="!inbox.length" class="cron-empty">
    <h3>No new reports.</h3>
    <p>Read and replaced reports are in History.</p>
  </div>
</template>
