<script setup lang="ts">
import { Pencil, Play, Pause, Trash2 } from "@lucide/vue";
import Markdown from "@/components/chat/Markdown.vue";
import type { CronJob, CronRun } from "./state";
import { date, durationText, statusLabel, scheduleDesc, outcome, runMarkdown, policies } from "./formatters";

defineProps<{
  detailJob: CronJob;
  jobRuns: CronRun[];
  openRuns: Set<number>;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: "edit", job: CronJob): void;
  (e: "runNow", job: CronJob): void;
  (e: "toggle", job: CronJob): void;
  (e: "showHistory", job: CronJob): void;
  (e: "delete", job: CronJob): void;
  (e: "toggleRun", event: Event, id: number): void;
  (e: "continueRun", run: CronRun): void;
}>();
</script>

<template>
  <header class="cron-detail-head">
    <div class="cron-detail-titles">
      <span class="cron-pill" :class="{ ok: detailJob.enabled, running: detailJob.lastRun?.status === 'running' }">
        {{ detailJob.enabled ? "Enabled" : "Paused" }}
      </span>
      <h3 dir="auto">{{ detailJob.name }}</h3>
      <span class="cron-detail-time">{{ scheduleDesc(detailJob) }}</span>
    </div>
    <div class="cron-detail-actions">
      <button type="button" class="cron-btn" @click="emit('edit', detailJob)"><Pencil :size="15" /> Edit</button>
      <button type="button" class="cron-btn" :disabled="busy || detailJob.lastRun?.status === 'running'" @click="emit('runNow', detailJob)">
        <Play :size="15" /> Run now
      </button>
      <button type="button" class="cron-btn" :disabled="busy" @click="emit('toggle', detailJob)">
        <Pause :size="15" /> {{ detailJob.enabled ? "Pause" : "Resume" }}
      </button>
      <button type="button" class="cron-btn" @click="emit('showHistory', detailJob)">Report history</button>
      <button type="button" class="cron-btn danger" :disabled="busy || detailJob.lastRun?.status === 'running'" @click="emit('delete', detailJob)">
        <Trash2 :size="15" /> Delete
      </button>
    </div>
    <div class="cron-detail-meta">
      <span>Next run: {{ date(detailJob.nextRun) }}</span>
      <span>Last result: {{ detailJob.lastRun ? statusLabel(detailJob.lastRun) : "No runs yet" }}</span>
      <span>Reporting: {{ policies[detailJob.reportPolicy] }}</span>
    </div>
  </header>
  <div class="cron-job-body">
    <section class="cron-block">
      <h4>{{ detailJob.execution ? "Imported script" : "Prompt" }}</h4>
      <pre v-if="detailJob.execution" class="cron-pre">Command: {{ detailJob.execution.command.join(" ") }}
Directory: {{ detailJob.execution.cwd || "Server default" }}</pre>
      <pre v-else class="cron-pre" dir="auto">{{ detailJob.prompt }}</pre>
    </section>
    <section class="cron-block">
      <h4>Recent runs</h4>
      <details v-for="run in jobRuns" :key="run.id" class="cron-run" @toggle="emit('toggleRun', $event, run.id)">
        <summary>
          <span class="cron-pill" :class="run.status">{{ statusLabel(run) }}</span>
          <span class="cron-run-snippet" dir="auto">{{ outcome(run) }}</span>
          <span class="cron-run-time">{{ date(run.endedAt || run.startedAt) }}</span>
        </summary>
        <div v-if="openRuns.has(run.id)" class="cron-run-body">
          <div class="cron-run-actions">
            <span class="cron-muted">Run #{{ run.id }} · {{ durationText(run) }}</span>
            <button type="button" class="cron-btn sm" @click="emit('continueRun', run)">Continue in chat</button>
          </div>
          <Markdown :content="runMarkdown(run)" />
        </div>
      </details>
      <p v-if="!jobRuns.length" class="cron-muted">No runs yet.</p>
    </section>
  </div>
</template>
