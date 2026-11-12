<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Clock } from "@lucide/vue";
import { json, serverUrl, token } from "@/lib/api";
import { chat } from "@/stores/chat";
import { history } from "@/stores/sessions";
import { scheduleRevision, scheduleReveal, schedulesChanged } from "@/stores/scheduled-messages";
import SchedulePicker from "../composer/SchedulePicker.vue";

type Schedule = { id: string; content: string; dueAt: number; status: string; source: { kind: string }; terminalReason?: string; nextDeliveryAt?: number; lastError?: string };
const rows = ref<Schedule[]>([]), loaded = ref(false), loading = ref(false), error = ref(""), notice = ref("");
const cancelling = ref<string | null>(null), editing = ref<Schedule | null>(null);
const anchor = ref<HTMLElement | null>(null);
const now = ref(Date.now());
const pending = computed(() => rows.value.filter(s => s.status === "scheduled" || s.status === "queued" || s.status === "failed"));
const summary = computed(() => history.list.find(s => String(s.id) === String(chat.session))?.scheduled);
let ticket = 0, timer: ReturnType<typeof setInterval> | undefined;
function countdown(row: Schedule) {
  if (row.status === "queued") return "Queued";
  if (row.status === "failed") return "Delivery failed";
  const remaining = Math.ceil((Math.max(row.dueAt, row.nextDeliveryAt ?? 0) - now.value) / 1000);
  if (remaining <= 0) return "Awaiting delivery";
  const days = Math.floor(remaining / 86400), hours = Math.floor(remaining % 86400 / 3600), minutes = Math.floor(remaining % 3600 / 60), seconds = remaining % 60;
  if (days) return `In ${days}d ${hours}h`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours ? hours + ':' : ''}${pad(minutes)}:${pad(seconds)}`;
}
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
  ticket++; rows.value = []; loaded.value = false; loading.value = false; error.value = ""; notice.value = ""; editing.value = null; cancelling.value = null;
  clearInterval(timer);
  if (chat.session) {
    now.value = Date.now();
    timer = setInterval(() => { now.value = Date.now(); }, 1000);
    void refresh();
  }
}, { immediate: true });
watch(() => [chat.connected, scheduleRevision.value, summary.value?.version], () => { if (chat.session) void refresh(); });
watch(scheduleReveal, async () => {
  notice.value = "";
  await refresh(); await nextTick();
  // Only the transcript scrolls: never move the composer or its ancestors.
  const log = anchor.value?.closest<HTMLElement>("#log");
  if (log && anchor.value) log.scrollTop += anchor.value.getBoundingClientRect().top - log.getBoundingClientRect().top - 24;
  if (!pending.value.length && !error.value) notice.value = "No pending scheduled messages.";
});
async function cancel(row: Schedule) {
  const sid = chat.session, origin = serverUrl.value, auth = token.value, epoch = chat.epoch;
  if (!sid || cancelling.value) return;
  cancelling.value = row.id;
  const current = () => sid === chat.session && origin === serverUrl.value && auth === token.value && epoch === chat.epoch;
  try {
    const result = await json<{ status: string }>(`/v1/sessions/${sid}/scheduled-messages/${encodeURIComponent(row.id)}`, { method: "DELETE" });
    if (!current()) return;
    notice.value = result.status === "already_delivered" ? "Already delivered — too late to cancel." : "Scheduled message cancelled.";
    schedulesChanged(); await refresh();
  } catch (e) { if (current()) error.value = (e as Error).message; }
  finally { if (current()) cancelling.value = null; }
}
onBeforeUnmount(() => { ticket++; clearInterval(timer); });
</script>

<template>
  <div v-if="chat.session" ref="anchor" class="scheduled-messages" aria-label="Scheduled messages">
    <p v-if="!loaded && loading" class="schedule-status" role="status">Loading scheduled messages…</p>
    <p v-if="error" class="schedule-status" role="alert">Scheduled messages unavailable: {{ error }} <button type="button" :disabled="loading" @click="refresh">Retry</button></p>
    <p v-if="notice" class="schedule-status" role="status">{{ notice }}</p>
    <article v-for="row in pending" :key="row.id" class="scheduled-bubble" :data-schedule="row.id">
      <header class="scheduled-header">
        <span><Clock :size="14" aria-hidden="true" />{{ row.status === 'failed' ? 'Failed' : row.source.kind === 'limit_recovery' ? 'Automatic recovery' : 'Scheduled' }}</span>
        <span class="scheduled-countdown" :aria-label="row.status === 'scheduled' && row.dueAt > now ? 'Sends in ' + countdown(row) : countdown(row)">{{ countdown(row) }}</span>
      </header>
      <p class="scheduled-text" dir="auto">{{ row.content }}</p>
      <time :datetime="new Date(row.dueAt).toISOString()" :title="new Date(row.dueAt).toISOString()">{{ new Date(row.dueAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }}</time>
      <p v-if="row.lastError || row.terminalReason" class="schedule-status">{{ row.terminalReason || 'Delivery delayed: ' + row.lastError }}</p>
      <footer v-if="row.status !== 'failed'" class="scheduled-actions">
        <button v-if="row.source.kind === 'user'" type="button" :disabled="row.status !== 'scheduled' || !!cancelling || !chat.connected" :title="row.status !== 'scheduled' ? 'Already queued; editing is no longer available' : !chat.connected ? 'Reconnect to edit' : 'Edit message and time'" @click="editing = { ...row }">Edit</button>
        <button type="button" :disabled="!!cancelling || !chat.connected" :title="!chat.connected ? 'Reconnect to cancel' : 'Cancel this scheduled message'" @click="cancel(row)">{{ cancelling === row.id ? 'Cancelling…' : 'Cancel' }}</button>
      </footer>
    </article>
    <SchedulePicker :open="!!editing" :content="editing?.content ?? ''" :schedule-id="editing?.id" :due-at="editing?.dueAt" @close="editing = null" />
  </div>
</template>

<style scoped>
.scheduled-messages { display: flex; flex-direction: column; align-items: flex-end; gap: 16px; width: 100%; }
.scheduled-messages:not(:has(.scheduled-bubble, .schedule-status)) { display: none; }
.scheduled-bubble { width: fit-content; min-width: min(260px, 100%); max-width: 85%; border: 1px dashed var(--muted-foreground); border-radius: 2px; background: var(--secondary); padding: 12px 16px 4px; overflow-wrap: anywhere; }
.scheduled-header { display: flex; justify-content: space-between; gap: 24px; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 12px; font-size: 12px; color: var(--muted-foreground); }
.scheduled-header > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
.scheduled-countdown { font-variant-numeric: tabular-nums; white-space: nowrap; }
.scheduled-text { margin: 0 0 12px; white-space: pre-wrap; font-size: 16.5px; }
time, .schedule-status { font-size: 12px; color: var(--muted-foreground); }
.scheduled-actions { display: flex; gap: 8px; margin-top: 4px; }
button { font-size: 12px; color: var(--foreground); min-height: 44px; padding: 6px 10px; cursor: pointer; }
button:hover:not(:disabled) { text-decoration: underline; }
button:disabled { color: var(--muted-foreground); opacity: .5; cursor: default; }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (max-width: 640px) { .scheduled-bubble { max-width: 92%; padding-inline: 12px; } .scheduled-header { gap: 12px; } }
</style>
