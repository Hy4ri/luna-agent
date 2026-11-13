<script setup lang="ts">
import { ArrowLeft, Play } from "@lucide/vue";
import Markdown from "@/components/chat/Markdown.vue";
import type { CronJob, CronRun } from "./state";
import { date, durationText, reasonText, statusLabel, runMarkdown } from "./formatters";

defineProps<{
  detail: CronRun;
  tab: string;
  reportJob: CronJob | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: "back"): void;
  (e: "markUnread", run: CronRun): void;
  (e: "runNow", job: CronJob): void;
  (e: "continueRun", run: CronRun): void;
}>();
</script>

<template>
  <header class="cron-detail-head">
    <button type="button" class="cron-back" @click="emit('back')">
      <ArrowLeft :size="15" /> {{ tab === "reports" ? "Reports" : "History" }}
    </button>
    <div class="cron-detail-titles">
      <span class="cron-pill" :class="detail.status">{{ statusLabel(detail) }}</span>
      <h3 dir="auto">{{ detail.jobName }}</h3>
      <span class="cron-detail-time">{{ date(detail.endedAt || detail.startedAt) }}</span>
    </div>
    <div class="cron-detail-actions">
      <button v-if="detail.readAt !== null" type="button" class="cron-btn" :disabled="busy" :title="busy ? 'Action in progress…' : 'Move back to Reports inbox'" @click="emit('markUnread', detail)">
        Mark unread
      </button>
      <button v-if="reportJob" type="button" class="cron-btn" :disabled="busy" :title="busy ? 'Action in progress…' : 'Run this job now'" @click="emit('runNow', reportJob)">
        <Play :size="15" /> Run now
      </button>
      <button type="button" class="cron-btn primary" @click="emit('continueRun', detail)">Continue in chat</button>
    </div>
    <div class="cron-detail-meta">
      <span>Run #{{ detail.id }}</span>
      <span>{{ durationText(detail) }}</span>
      <span v-if="detail.reason">{{ reasonText(detail.reason) }}</span>
    </div>
  </header>
  <article class="cron-report-body">
    <Markdown :content="runMarkdown(detail)" />
  </article>
</template>
