<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { Clock } from "@lucide/vue";
import { post, serverUrl, token } from "@/lib/api";
import { chat } from "@/stores/chat";
import { schedulesChanged, revealSchedules } from "@/stores/scheduled-messages";

const props = defineProps<{ open: boolean; content: string; scheduleId?: string; dueAt?: number }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const id = useId();
const text = ref(""), date = ref(""), time = ref("");
const now = ref(Date.now()), submitting = ref(false), error = ref("");
const attempt = ref<{ session: string; origin: string; token: string; content: string; dueAt: number; requestId: string; scheduleId?: string } | null>(null);
let clock: ReturnType<typeof setInterval> | undefined;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const pad = (n: number) => String(n).padStart(2, "0");
const localTime = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function setTime(ms: number) {
  const parts = localTime(new Date(ms)).split("T");
  date.value = parts[0]!; time.value = parts[1]!;
}
function quickDelay(minutes: number) {
  // Round up to a full minute so '+5 min' never silently means four minutes.
  setTime(Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000);
  error.value = "";
}
const selected = computed(() => {
  const value = `${date.value}T${time.value}`, d = new Date(value);
  return Number.isFinite(d.getTime()) && localTime(d) === value ? d : null;
});
const validation = computed(() => {
  if (!text.value.trim()) return "Enter a message.";
  if (text.value.trim().startsWith("/")) return "Scheduled messages cannot run slash commands.";
  if (!selected.value) return "Choose a valid date and time. Skipped daylight-saving times are not available.";
  if (selected.value.getTime() <= now.value) return "Choose a future time.";
  return "";
});
const currentTime = computed(() => new Date(now.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
const today = computed(() => localTime(new Date(now.value)).split("T")[0]!);
const summary = computed(() => {
  const d = selected.value;
  if (!d) return "";
  const day = date.value === today.value ? "today" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const minutes = Math.ceil((d.getTime() - now.value) / 60_000);
  const wait = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `Sends ${day} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${minutes > 0 ? ` · in ${wait}` : ""}`;
});
const resolved = computed(() => {
  const d = selected.value;
  if (!d) return "";
  const offset = -d.getTimezoneOffset();
  return `${d.toISOString()} · UTC${offset < 0 ? "−" : "+"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
});
function stopClock() { clearInterval(clock); clock = undefined; }
watch(() => props.open, async open => {
  stopClock();
  if (!open) { dialog.value?.close(); return; }
  now.value = Date.now();
  // Keep an uncertain request frozen across close/reopen, until definitively resolved.
  if (!attempt.value || attempt.value.session !== chat.session || attempt.value.origin !== serverUrl.value ||
    attempt.value.token !== token.value || attempt.value.scheduleId !== props.scheduleId || (!props.scheduleId && attempt.value.content !== props.content.trim())) {
    attempt.value = null; error.value = ""; text.value = props.content;
    setTime(props.dueAt ?? Math.ceil((now.value + 15 * 60_000) / 60_000) * 60_000);
  }
  clock = setInterval(() => { now.value = Date.now(); }, 1000);
  await nextTick();
  if (props.open) dialog.value?.showModal();
});
watch(() => [chat.session, serverUrl.value, token.value], () => { attempt.value = null; error.value = ""; emit("close"); });
onBeforeUnmount(stopClock);
function close() { if (!submitting.value) emit("close"); }
async function save() {
  if (!chat.session || submitting.value || (!attempt.value && validation.value)) return;
  attempt.value ??= { session: chat.session, origin: serverUrl.value, token: token.value,
    content: text.value.trim(), dueAt: selected.value!.getTime(), scheduleId: props.scheduleId,
    requestId: `schedule-${Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-")}` };
  const request = attempt.value;
  submitting.value = true; error.value = "";
  try {
    const path = `/v1/sessions/${request.session}/scheduled-messages`;
    await post(request.scheduleId ? `${path}/${encodeURIComponent(request.scheduleId)}` : path,
      { content: request.content, dueAt: request.dueAt, ...(!request.scheduleId ? { requestId: request.requestId } : {}) },
      request.scheduleId ? "PATCH" : "POST");
    if (attempt.value !== request || chat.session !== request.session || serverUrl.value !== request.origin || token.value !== request.token) return;
    attempt.value = null;
    schedulesChanged(); revealSchedules();
    emit("saved"); emit("close");
  } catch (e) {
    if (attempt.value !== request) return;
    const status = (e as Error & { status?: number }).status;
    if (status === 400 || status === 404 || status === 409) { attempt.value = null; error.value = (e as Error).message; schedulesChanged(); }
    else error.value = `Not confirmed: ${(e as Error).message}. Retry uses the same request and time.`;
  } finally { submitting.value = false; }
}
</script>

<template>
  <dialog ref="dialog" class="schedule-picker" :aria-labelledby="`${id}-title`" @cancel.prevent="close" @close="emit('close')">
    <h2 :id="`${id}-title`">{{ scheduleId ? 'Edit scheduled message' : 'Schedule message' }}</h2>
    <div class="schedule-now"><Clock :size="16" aria-hidden="true" /><span>Current time <strong>{{ currentTime }}</strong><small>{{ timezone }}</small></span></div>
    <label v-if="scheduleId" class="schedule-field">Message<textarea v-model="text" :disabled="submitting || !!attempt" rows="3" /></label>
    <p v-else class="schedule-preview" dir="auto">{{ text }}</p>
    <fieldset :disabled="submitting || !!attempt">
      <legend>Send later</legend>
      <div class="schedule-shortcuts"><button v-for="minutes in [5, 15, 30, 60]" :key="minutes" type="button" @click="quickDelay(minutes)">{{ minutes === 60 ? '+1 hour' : '+' + minutes + ' min' }}</button></div>
      <div class="schedule-fields">
        <label class="schedule-field">Date<input v-model="date" type="date" :min="today" :aria-invalid="!!validation" :aria-describedby="`${id}-validation`" autofocus /></label>
        <label class="schedule-field">Time<input v-model="time" type="time" :aria-invalid="!!validation" :aria-describedby="`${id}-validation`" /></label>
      </div>
    </fieldset>
    <div class="schedule-summary" aria-live="polite">
      <p v-if="!validation">{{ summary }}</p>
      <p :id="`${id}-validation`" :class="{ 'schedule-invalid': validation }">{{ validation }}</p>
      <small v-if="selected" :title="resolved">{{ timezone }}</small>
    </div>
    <details v-if="selected" class="schedule-details"><summary>Exact timestamp</summary><small>{{ resolved }}</small></details>
    <p v-if="error" class="schedule-invalid" role="alert">{{ error }}</p>
    <p v-if="attempt && !submitting" class="schedule-help">This request is awaiting confirmation. Retry checks the same message and time; fields stay locked to prevent duplicates.</p>
    <div class="schedule-actions">
      <button type="button" :disabled="submitting" @click="close">Cancel</button>
      <button type="button" class="schedule-primary" :disabled="submitting || (!attempt && !!validation)" @click="save">{{ submitting ? 'Saving…' : attempt ? 'Retry' : scheduleId ? 'Save changes' : 'Schedule message' }}</button>
    </div>
  </dialog>
</template>

<style scoped>
.schedule-picker { width: min(440px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; margin: auto; padding: 20px; border: 1px solid var(--border); border-radius: 2px; color: var(--foreground); background: var(--card); font-size: 14px; }
.schedule-picker::backdrop { background: #0009; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 16px; }
.schedule-now { display: flex; gap: 10px; align-items: center; padding: 12px; background: var(--secondary); border: 1px solid var(--border); border-radius: 2px; }
.schedule-now strong { font-variant-numeric: tabular-nums; margin-inline-start: 8px; }
small { display: block; font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere; }
.schedule-preview { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 100px; overflow: auto; margin: 16px 0; }
fieldset { border: 0; padding: 0; min-width: 0; margin-top: 16px; }
legend, .schedule-field { font-size: 12px; font-weight: 500; }
.schedule-shortcuts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 8px 0 16px; }
button { min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 2px; cursor: pointer; }
.schedule-shortcuts button { padding: 6px 2px; font-size: 12px; }
.schedule-fields { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 12px; }
.schedule-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.schedule-field:has(textarea) { margin-top: 16px; }
input, textarea { box-sizing: border-box; min-width: 0; width: 100%; min-height: 44px; padding: 8px; border: 1px solid var(--border); border-radius: 2px; background: var(--secondary); color: var(--foreground); font: inherit; }
textarea { resize: vertical; font-size: 14px; }
.schedule-summary { margin-top: 16px; }
.schedule-summary p:empty { display: none; }
.schedule-summary p { margin: 0 0 6px; }
.schedule-invalid { color: var(--destructive); font-size: 13px; }
.schedule-help { color: var(--muted-foreground); font-size: 12px; margin-top: 12px; }
.schedule-details { font-size: 12px; color: var(--muted-foreground); margin-top: 8px; }
.schedule-details summary { cursor: pointer; padding-block: 6px; }
.schedule-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.schedule-primary { background: var(--primary); color: var(--primary-foreground); }
button:disabled, fieldset:disabled button, input:disabled, textarea:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (max-width: 380px) { .schedule-fields { grid-template-columns: 1fr; } .schedule-picker { padding: 16px; } }
</style>
