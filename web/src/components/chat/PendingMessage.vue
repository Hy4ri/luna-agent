<script setup lang="ts">
import { chat } from "@/stores/chat";
import { composer, canRecoverPending, steerPending, cancelPending, retryPending, dismissPending } from "@/stores/composer";
import ReportContext from "./ReportContext.vue";
import UploadAttachment from "./UploadAttachment.vue";
import SessionImage from "./SessionImage.vue";

defineProps<{ message: any }>();
function blocks(content: unknown): any[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
}
</script>

<template>
  <div class="msg user" :data-pending="message.requestId">
    <div dir="auto" class="user-content rtl-plaintext">
      <template v-for="(block, bi) in blocks(message.content)" :key="bi">
        <UploadAttachment
          v-if="block.type === 'file' || block.attachment"
          :upload-id="block.uploadId || block.attachment?.id"
          :name="block.attachment?.name || 'upload'"
          :mime-type="block.attachment?.mimeType"
          :size="block.attachment?.size"
        />
        <ReportContext v-else-if="block.type === 'text'" :text="block.text" />
        <SessionImage
          v-else-if="block.type === 'image' && !block.data?.startsWith('luna-upload:')"
          class="att"
          :image="block"
          alt="attachment"
        />
      </template>
    </div>
    <div class="message-footer pending-message-footer">
      <span role="status">{{ message.cancelling ? "Cancelling…" : message.status }}</span>
      <button v-if="message.status === 'Queued' && message.submissionId" type="button" class="steer-now" title="Add this message to the current turn at its next boundary" :disabled="!chat.connected || !!message.session && composer.submitting.has(message.session)" @click="steerPending(message.requestId)">Steer</button>
      <button v-if="['Queued', 'Steering'].includes(message.status) && message.submissionId" type="button" :title="message.promoting ? 'Steer not confirmed; retry Steer before cancelling' : 'Withdraw this message before delivery; keep the current response running'" :disabled="message.promoting || !chat.connected || !!message.session && composer.submitting.has(message.session)" @click="cancelPending(message.requestId)">Cancel</button>
      <template v-if="canRecoverPending(message)">
        <button type="button" :disabled="!chat.connected || !!message.session && composer.submitting.has(message.session)" @click="retryPending(message.requestId)">Retry send</button>
        <button type="button" :disabled="!!message.session && composer.submitting.has(message.session)" title="Remove local message; this does not cancel delivery" @click="dismissPending(message.requestId)">Dismiss</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pending-message-footer { flex-wrap: wrap; color: var(--muted-foreground); }
.pending-message-footer button {
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}
.pending-message-footer button:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--primary-text);
}
.pending-message-footer button:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.pending-message-footer button:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 760px), (pointer: coarse) {
  .pending-message-footer button {
    min-height: 44px;
    padding: 8px 12px;
  }
}
</style>
