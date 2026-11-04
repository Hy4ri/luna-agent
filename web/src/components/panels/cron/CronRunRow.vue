<script setup lang="ts">
import type { CronRun } from "./state";
import { date, timeAgo, statusLabel, outcome } from "./formatters";

defineProps<{ run: CronRun; active: boolean; busy: boolean; showUnread?: boolean }>();
defineEmits<{ (e: "open", run: CronRun): void }>();
</script>

<template>
  <button :disabled="busy" type="button" class="cron-item" :class="{ active }" :data-run="run.id" @click="$emit('open', run)">
    <span class="cron-item-outcome" :class="run.status" dir="auto">{{ outcome(run) }}</span>
    <span class="cron-item-meta">
      <span class="cron-pill" :class="run.status">{{ statusLabel(run) }}</span>
      <span v-if="showUnread && run.readAt === null" class="cron-pill unread">Unread</span>
      <span class="cron-item-job" dir="auto">{{ run.jobName }}</span>
      <span class="cron-item-time" :title="date(run.endedAt || run.startedAt)">{{ timeAgo(run.endedAt || run.startedAt) }}</span>
    </span>
  </button>
</template>
