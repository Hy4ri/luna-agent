<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Clock } from "@lucide/vue";
import { json, serverUrl, token } from "@/lib/api";
import { chat } from "@/stores/chat";
import { history } from "@/stores/sessions";

const props = defineProps<{ revision: number }>();
type Schedule = { id: string; content: string; dueAt: number; status: string; source: { kind: string }; terminalReason?: string };
const rows = ref<Schedule[]>([]);
const loaded = ref(false), loading = ref(false), error = ref(""), notice = ref("");
const cancelling = ref<string | null>(null);
const open = ref(false);
const pending = computed(() => rows.value.filter(s => s.status === "scheduled" || s.status === "queued"));
const summary = computed(() => history.list.find(s => String(s.id) === String(chat.session))?.scheduled);
const count = computed(() => summary.value?.count ?? pending.value.length);
let ticket = 0;
onBeforeUnmount(() => { ticket++; });
async function refresh() {
  const sid = chat.session, n = ++ticket;
  if (!sid) return;
  loading.value = true;
  try {
    const result = await json<{ schedules: Schedule[] }>(`/v1/sessions/${sid}/scheduled-messages`);
    if (n !== ticket || sid !== chat.session) return;
    rows.value = result.schedules; error.value = ""; loaded.value = true;
  } catch (e) { if (n === ticket && sid === chat.session) error.value = (e as Error).message; }
  finally { if (n === ticket) loading.value = false; }
}
watch(() => [chat.session, serverUrl.value, token.value], () => {
  ticket++; rows.value = []; loaded.value = false; error.value = ""; notice.value = ""; open.value = false;
  void refresh();
}, { immediate: true });
watch(() => [chat.connected, props.revision], ([connected]) => { if (chat.session && connected) void refresh(); });
// Streaming replaces history rows often. Only a real scheduling change refreshes an open list.
// Collapsed counts come from the session row; opening always fetches the current records.
watch(() => summary.value?.version, () => { if (open.value && chat.session && chat.connected) void refresh(); });
watch(open, value => { if (value) { notice.value = ""; void refresh(); } });
async function cancel(row: Schedule) {
  const sid = chat.session, origin = serverUrl.value;
  if (!sid || cancelling.value) return;
  cancelling.value = row.id;
  try {
    const result = await json<{ status: string }>(`/v1/sessions/${sid}/scheduled-messages/${row.id}`, { method: "DELETE" });
    if (sid !== chat.session || origin !== serverUrl.value) return;
    notice.value = result.status === "already_delivered" ? "Already delivered — too late to cancel." : "Cancelled.";
    await refresh();
  } catch (e) { if (sid === chat.session && origin === serverUrl.value) error.value = (e as Error).message; }
  finally { cancelling.value = null; }
}
defineExpose({ show: () => { open.value = true; } });
</script>

<template>
  <details v-if="chat.session && (open || !!error || !loaded || count > 0)" class="scheduled-list" :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary><Clock :size="13" aria-hidden="true" />
      <span v-if="error">Scheduled · unavailable</span>
      <span v-else-if="loaded">Scheduled · {{ count }}</span>
      <span v-else>Scheduled · loading</span>
    </summary>
    <div class="scheduled-list__body" aria-label="Scheduled messages">
      <div class="scheduled-list__actions"><span v-if="loading" role="status">Refreshing…</span><button type="button" :disabled="loading" @click="refresh">Refresh</button></div>
      <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="loading" @click="refresh">Retry</button></p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="loaded && !loading && !pending.length">No pending messages.</p>
      <div v-for="row in pending" :key="row.id" class="scheduled-list__row">
        <div><p class="scheduled-list__text">{{ row.content }}</p>
          <p class="scheduled-list__meta">{{ row.source.kind === 'limit_recovery' ? 'Automatic' : 'Manual' }} · {{ row.status === 'queued' ? 'Queued' : new Date(row.dueAt).toLocaleString() }}</p>
          <time :datetime="new Date(row.dueAt).toISOString()">{{ new Date(row.dueAt).toISOString() }}</time>
        </div>
        <button type="button" :disabled="!!cancelling" :aria-label="`Cancel ${row.source.kind === 'limit_recovery' ? 'automatic' : 'scheduled'} message: ${row.content.slice(0, 80)}`" @click="cancel(row)">{{ cancelling === row.id ? 'Cancelling…' : 'Cancel' }}</button>
      </div>
      <p v-for="row in rows.filter(s => s.status === 'failed').slice(-3)" :key="row.id" role="status">Delivery failed: {{ row.content }} — {{ row.terminalReason }}</p>
    </div>
  </details>
</template>

<style scoped>
.scheduled-list { font-size: 12px; margin: 4px 0; }
summary { display: flex; align-items: center; gap: 6px; cursor: pointer; min-height: 28px; width: fit-content; color: var(--muted-foreground); }
.scheduled-list__body { max-height: 220px; overflow-y: auto; padding: 8px; border: 1px solid var(--border); border-radius: 2px; background: var(--card); }
.scheduled-list__actions, .scheduled-list__row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.scheduled-list__row { border-top: 1px solid var(--border); padding: 8px 0; }
.scheduled-list__row > div { min-width: 0; }
.scheduled-list__text { white-space: pre-wrap; overflow-wrap: anywhere; }
.scheduled-list__meta, time { color: var(--muted-foreground); }
button { text-decoration: underline; min-height: 32px; padding: 2px 6px; flex-shrink: 0; }
button:disabled { opacity: .5; }
button:focus-visible, summary:focus-visible { outline: 1px solid var(--ring); outline-offset: 2px; }
</style>
