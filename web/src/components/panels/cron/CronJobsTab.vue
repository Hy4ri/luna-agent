<script setup lang="ts">
import type { CronJob } from "./state";
import { date, whenText, scheduleDesc } from "./formatters";
import { computed } from "vue";
import { useVirtualList } from "@vueuse/core";

const props = defineProps<{
  jobs: CronJob[];
  selectedJobId: number | null;
}>();

const { list: vJobs, containerProps, wrapperProps } = useVirtualList(computed(() => props.jobs), { itemHeight: 64, overscan: 8 });
const emit = defineEmits<{
  (e: "selectJob", job: CronJob): void;
}>();
</script>

<template>
  <div class="cron-jobs">
    <div v-if="jobs.length" v-bind="containerProps" class="cron-vlist">
      <div v-bind="wrapperProps">
        <button
          v-for="{ data: job } in vJobs"
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
      </div>
    </div>
    <div v-else class="cron-empty">
      <h3>No jobs yet.</h3>
      <p>Create a scheduled prompt with New job.</p>
    </div>
  </div>
</template>

<style scoped>
.cron-jobs { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.cron-jobs > .cron-vlist { flex: 1; height: auto; }
.cron-jobs > .cron-empty { flex: 1; }
/* Match the row geometry to the virtual window's fixed-height calculation. */
.cron-jobs :deep(.cron-item) { height: 64px; min-height: 64px; box-sizing: border-box; padding-block: 8px; }
</style>
