<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Check, Monitor } from '@lucide/vue';
import { chat } from '@/stores/chat';
import { openPanel } from '@/stores/app';
import { json, post } from '@/lib/api';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { loadWorkers, workers } from '@/stores/workers';

const machine = computed(() => chat.session ? chat.machine : workers.list.find(w => w.id === chat.draftWorker) ?? null);
const visible = computed(() => !!machine.value || !!chat.draftWorker || workers.list.length > 0);
const name = computed(() => machine.value?.name || (chat.draftWorker ? `Machine ${chat.draftWorker}` : 'This host'));
const title = computed(() => `${name.value}${machine.value ? machine.value.online ? ' · Online' : ' · Offline' : ''}${chat.cwd ? ' · ' + chat.cwd : ''}`);
/** The machine that runs file and command tools: the session's own, or the draft's before the first message. */
const currentId = computed<number | null>(() => chat.session ? chat.machine?.id ?? null : chat.draftWorker);
const locked = computed(() => !!chat.session && chat.runActive);
const failure = ref('');
/** Target only: a draft remembers the choice; an idle session moves its future tools. History is not filtered. */
async function choose(worker: number | null) {
  failure.value = '';
  if (worker === currentId.value) return;
  if (!chat.session) { chat.draftWorker = worker; chat.draftCwd = ''; return; }
  const sid = chat.session, epoch = chat.epoch;
  try {
    const r = await post(`/v1/sessions/${sid}/machine`, { worker, cwd: null }, 'PUT');
    if (epoch === chat.epoch && sid === chat.session) { chat.machine = r.machine; chat.cwd = r.cwd; }
  } catch (e) { failure.value = (e as Error).message; }
}
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
  <DropdownMenu v-if="visible">
    <DropdownMenuTrigger as-child>
      <button id="machine-status" type="button" class="flex min-w-0 max-w-40 items-center gap-1 text-xs text-muted-foreground" :title="title" aria-label="Execution machine">
        <Monitor :size="13" class="shrink-0" /><span class="truncate">{{ name }}</span><span v-if="machine && !machine.online" class="text-destructive">Offline</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="min-w-52">
      <DropdownMenuItem data-machine="main" :disabled="locked" @select="choose(null)">
        <span class="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" /><span class="flex-1">This host</span><Check v-if="currentId === null" :size="14" />
      </DropdownMenuItem>
      <DropdownMenuItem v-for="w in workers.list" :key="w.id" :data-machine="w.id" :disabled="locked || (!w.online && currentId !== w.id)" @select="choose(w.id)">
        <span class="size-2 shrink-0 rounded-full" :class="w.online ? 'bg-primary' : 'bg-muted-foreground/40'" aria-hidden="true" />
        <span class="flex-1 truncate" :class="{ 'text-muted-foreground': !w.online }">{{ w.name }}</span>
        <span v-if="!w.online" class="text-xs text-muted-foreground">Offline</span>
        <Check v-if="currentId === w.id" :size="14" />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <p v-if="locked" class="px-2 py-1 text-xs text-muted-foreground">Wait for the current turn to finish before moving.</p>
      <p v-if="failure" class="px-2 py-1 text-xs text-destructive" role="alert">{{ failure }}</p>
      <DropdownMenuItem data-machine-settings @select="openPanel('session')">Working directory…</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
