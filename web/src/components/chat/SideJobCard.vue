<script setup lang="ts">
import { ref } from 'vue';
import { Send, Check, LoaderCircle } from '@lucide/vue';
import { chat, sendDisabled, type SideJob } from '@/stores/chat';
import { submitMessage } from '@/stores/composer';
import SideContent from './SideContent.vue';
import MessageFooter from './MessageFooter.vue';
const props = defineProps<{ job: SideJob }>();
const sending = ref(false);
const sent = ref(false);
async function sendReview() {
  const sid = chat.session;
  if (!sid || sendDisabled.value || sending.value || sent.value || props.job.status !== 'complete' || !props.job.text) return;
  sending.value = true;
  try {
    sent.value = await submitMessage(sid, {
      content: `Please assess this review of our session and respond to its findings.\n\nReview focus: ${props.job.prompt}\n\n${props.job.text}`,
      requestId: `review-report:${props.job.id}`,
      whenBusy: 'followUp',
    });
  } finally { sending.value = false; }
}
</script>
<template>
  <div role="group" :aria-label="`${job.kind} report`" class="msg assistant side-job" :data-side-job="job.id">
    <p class="muted">/{{ job.kind }} · {{ job.status === 'running' ? 'Started' : job.status === 'complete' ? 'Complete' : 'Failed' }} · {{ job.id }} · Not in main history</p>
    <p dir="auto">{{ job.prompt }}</p><SideContent :job="job" />
    <button
      v-if="job.kind === 'review' && job.status === 'complete' && job.text"
      type="button"
      class="side-job-btn"
      :class="{ sent, sending }"
      :disabled="sendDisabled || sending || sent"
      @click="sendReview"
    >
      <LoaderCircle v-if="sending" :size="14" class="animate-spin" aria-hidden="true" />
      <Check v-else-if="sent" :size="14" aria-hidden="true" />
      <Send v-else :size="14" aria-hidden="true" />
      <span>{{ sent ? 'Sent to agent' : sending ? 'Sending…' : 'Send to agent' }}</span>
    </button>
    <MessageFooter :text="job.text || ''" :timestamp="job.createdAt" />
  </div>
</template>
