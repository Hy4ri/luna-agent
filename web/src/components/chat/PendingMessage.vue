<script setup lang="ts">
import { chat } from "@/stores/chat";
import { composer, canRecoverPending, steerPending, retryPending, dismissPending } from "@/stores/composer";
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
      <span role="status">{{ message.status }}</span>
      <button v-if="message.status === 'Queued' && message.submissionId" type="button" class="steer-now" title="Add this message to the current turn at its next boundary" :disabled="!chat.connected || !!message.session && composer.submitting.has(message.session)" @click="steerPending(message.requestId)">Steer</button>
      <template v-if="canRecoverPending(message)">
        <button type="button" :disabled="!chat.connected || !!message.session && composer.submitting.has(message.session)" @click="retryPending(message.requestId)">Retry send</button>
        <button type="button" :disabled="!!message.session && composer.submitting.has(message.session)" title="Remove local message; this does not cancel delivery" @click="dismissPending(message.requestId)">Dismiss</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.steer-now { border: 1px solid var(--border); padding: 3px 8px; border-radius: 1px; cursor: pointer; }
.steer-now:disabled { opacity: 0.5; cursor: default; }
</style>
