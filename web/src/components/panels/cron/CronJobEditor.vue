<script setup lang="ts">
import type { CronEditor } from "./state";
import { schedulePresets, policies } from "./formatters";

defineProps<{
  editor: CronEditor;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: "save"): void;
  (e: "cancel"): void;
}>();
</script>

<template>
  <form class="cron-form" :aria-label="editor.jobId ? 'Edit job' : 'New job'" @submit.prevent="emit('save')">
    <div class="cron-form-head">
      <h3>{{ editor.jobId ? "Edit job" : "New job" }}</h3>
      <span class="cron-tz-tag">{{ editor.jobId ? `#${editor.jobId}` : "Draft" }}</span>
    </div>
    <label class="cron-field">
      <span>Job name</span>
      <input dir="auto" aria-label="Job name" v-model="editor.name" required />
    </label>
    <label v-if="!editor.intervalMs" class="cron-field">
      <span>Schedule</span>
      <input aria-label="Schedule" v-model="editor.expr" required />
      <span class="cron-presets">
        <button v-for="preset in schedulePresets" :key="preset.expr" type="button" class="cron-preset" @click="editor.expr = preset.expr">
          {{ preset.label }}
        </button>
      </span>
    </label>
    <p v-else class="cron-help">
      Imported interval: every {{ editor.intervalMs / 60000 }} minutes. The interval is preserved.
    </p>
    <p class="cron-help">Schedules use server local time. Use five cron fields or @daily, @hourly, @weekly.</p>
    <label class="cron-field">
      <span>Prompt</span>
      <textarea dir="auto" aria-label="Prompt" v-model="editor.prompt" rows="5" />
    </label>
    <label class="cron-field">
      <span>Reporting</span>
      <select aria-label="Reporting" v-model="editor.reportPolicy">
        <option v-for="(text, value) in policies" :key="value" :value="value">{{ text }}</option>
      </select>
    </label>
    <p class="cron-help">
      A failure always creates a report. "Output changes" compares the exact text after trimming outer spaces.
    </p>
    <div class="cron-form-actions">
      <button type="submit" class="cron-btn primary" :disabled="busy">Save job</button>
      <button type="button" class="cron-btn" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>
