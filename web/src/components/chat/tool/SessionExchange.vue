<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { json, post } from '@/lib/api';
import { Button } from '@/components/ui/button';

type Exchange = { to: number; anchor?: string | null; maxHops: number };
type Status = Exchange & { hop: number; enabled: boolean; increment: number };
const props = defineProps<{ session: string; exchange: Exchange }>();
const status = ref<Status>();
const busy = ref(false);
const error = ref('');
let generation = 0;
const path = () => `/v1/sessions/${encodeURIComponent(props.session)}/exchanges/${props.exchange.to}`;
const sameExchange = computed(() => !!status.value?.anchor && (!props.exchange.anchor || props.exchange.anchor === status.value.anchor));
const granted = computed(() => sameExchange.value && status.value!.maxHops > props.exchange.maxHops);
const canExtend = computed(() => sameExchange.value && status.value!.enabled && status.value!.maxHops === props.exchange.maxHops && status.value!.hop > status.value!.maxHops);
const note = computed(() => !status.value ? '' : granted.value ? `Allowed up to ${status.value.maxHops} messages.`
  : !status.value.enabled ? 'Session messages are disabled in settings.'
  : !canExtend.value ? 'This exchange is no longer at this limit.' : 'Only this exchange. The sender will be asked to retry.');

async function refresh() {
  const current = ++generation;
  status.value = undefined;
  error.value = '';
  busy.value = true;
  try {
    const value = await json<Status>(path());
    if (current === generation) status.value = value;
  } catch (e) {
    if (current === generation) error.value = (e as Error).message;
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function extend() {
  if (busy.value || !canExtend.value) return;
  const current = generation;
  const url = path();
  const body = { anchor: status.value!.anchor, maxHops: props.exchange.maxHops };
  busy.value = true;
  error.value = '';
  try {
    const value = await post<Status>(url + '/extend', body);
    if (current === generation) status.value = value;
  } catch (e) {
    if (current === generation) error.value = (e as Error).message;
  } finally {
    if (current === generation) busy.value = false;
  }
}
watch(() => [props.session, props.exchange.to, props.exchange.anchor, props.exchange.maxHops], refresh, { immediate: true });
onUnmounted(() => { generation++; });
</script>

<template>
  <div class="exchange-action" :aria-busy="busy">
    <Button type="button" variant="outline" :disabled="busy || !canExtend" @click="extend">
      {{ busy ? (status ? 'Allowing more messages…' : 'Checking exchange…') : granted ? 'Extra messages allowed' : `Allow ${status?.increment ?? 'more'}${status ? ' more' : ''} messages` }}
    </Button>
    <span v-if="note" role="status">{{ note }}</span>
    <span v-if="error" role="alert">{{ error }}</span>
    <Button v-if="error" type="button" variant="ghost" :disabled="busy" @click="refresh">Refresh status</Button>
  </div>
</template>

<style scoped>
.exchange-action { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 12px 12px; }
.exchange-action :deep(button) { min-height: 44px; }
.exchange-action :deep(button:focus-visible) { outline: 2px solid var(--primary-text); outline-offset: 2px; }
.exchange-action > span { font-size: 12px; }
.exchange-action > [role='alert'] { color: var(--destructive); }
</style>
