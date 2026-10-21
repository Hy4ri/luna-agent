<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { Monitor } from '@lucide/vue';
import { chat } from '@/stores/chat';
import { openPanel } from '@/stores/app';
import { json } from '@/lib/api';
import { loadWorkers, workers } from '@/stores/workers';

const machine = computed(() => chat.session ? chat.machine : workers.list.find(w => w.id === chat.draftWorker) ?? null);
const visible = computed(() => !!machine.value || !!chat.draftWorker || workers.list.length > 0);
const name = computed(() => machine.value?.name || (chat.draftWorker ? `Machine ${chat.draftWorker}` : 'This host'));
const title = computed(() => `${name.value}${machine.value ? machine.value.online ? ' · Online' : ' · Offline' : ''}${chat.cwd ? ' · ' + chat.cwd : ''}`);
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
async function refresh() {
  if (polling) return;
  polling = true;
  const sid = chat.session, epoch = chat.epoch;
  try {
    await loadWorkers();
    if (sid) {
      const r = await json(`/v1/sessions/${sid}/machine`);
      if (epoch === chat.epoch && sid === chat.session) { chat.machine = r.machine; chat.cwd = r.cwd; }
    }
  } catch { /* Keep last state; the main connection indicator reports a failed main connection. */ }
  finally { polling = false; }
}
watch(() => chat.session, refresh);
onMounted(() => { refresh(); timer = setInterval(refresh, 5000); });
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <button v-if="visible" id="machine-status" type="button" class="flex min-w-0 max-w-40 items-center gap-1 text-xs text-muted-foreground" :title="title" aria-label="Execution machine" @click="openPanel('session')">
    <Monitor :size="13" class="shrink-0" /><span class="truncate">{{ name }}</span><span v-if="machine && !machine.online" class="text-destructive">Offline</span>
  </button>
</template>
