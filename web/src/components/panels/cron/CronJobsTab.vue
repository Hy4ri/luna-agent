<script setup lang="ts">
import type { CronJob } from "./state";
import { date, whenText, scheduleDesc } from "./formatters";

defineProps<{
  jobs: CronJob[];
  selectedJobId: number | null;
}>();

const emit = defineEmits<{
  (e: "selectJob", job: CronJob): void;
}>();
</script>

<template>
  <button
    v-for="job in jobs"
    :key="job.id"
    type="button"
    class="cron-item"
    :class="{ active: selectedJobId === job.id }"
    :data-job="job.id"
    @click="emit('selectJob', job)"
  >
    <span class="cron-item-title" dir="auto">{{ job.name }}</span>
    <span class="cron-item-meta">
      <span class="cron-pill" :class="{ ok: job.enabled && job.lastRun?.status !== 'running', running: job.lastRun?.status === 'running' }">
        {{ job.lastRun?.status === "running" ? "Running" : job.enabled ? "Enabled" : "Paused" }}
      </span>
      <span class="cron-item-job">{{ scheduleDesc(job) }}</span>
      <span class="cron-item-time" :title="date(job.nextRun)">{{ job.nextRun ? whenText(job.nextRun) : "not scheduled" }}</span>
    </span>
  </button>
  <div v-if="!jobs.length" class="cron-empty">
    <h3>No jobs yet.</h3>
    <p>Create a scheduled prompt with New job.</p>
  </div>
</template>
