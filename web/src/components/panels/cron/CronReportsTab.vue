<script setup lang="ts">
import type { CronRun } from "./state";
import CronRunRow from "./CronRunRow.vue";
import { computed } from "vue";
import { useVirtualList } from "@vueuse/core";

const props = defineProps<{
  inbox: CronRun[];
  detailId: number | undefined;
  busy: boolean;
}>();

const { list: vInbox, containerProps, wrapperProps } = useVirtualList(computed(() => props.inbox), { itemHeight: 88, overscan: 8 });
const emit = defineEmits<{
  (e: "openReport", run: CronRun): void;
}>();
</script>

<template>
  <div v-bind="containerProps" class="cron-vlist"><div v-bind="wrapperProps"><CronRunRow v-for="{ data: run } in vInbox" :key="run.id" :run="run" :active="detailId === run.id" :busy="busy" @open="emit('openReport', $event)" /></div></div>
  <div v-if="!inbox.length" class="cron-empty">
    <h3>No new reports.</h3>
    <p>Read and replaced reports are in History.</p>
  </div>
</template>
