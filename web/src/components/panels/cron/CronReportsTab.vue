<script setup lang="ts">
import type { CronRun } from "./state";
import CronRunRow from "./CronRunRow.vue";

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
  <CronRunRow v-for="run in inbox" :key="run.id" :run="run" :active="detailId === run.id" :busy="busy" @open="emit('openReport', $event)" />
  <div v-if="!inbox.length" class="cron-empty">
    <h3>No new reports.</h3>
    <p>Read and replaced reports are in History.</p>
  </div>
</template>
