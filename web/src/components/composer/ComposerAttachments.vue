<script setup lang="ts">
import { formatFileSize, isRasterImage } from "@/lib/files";
import { FileText, Loader2 } from "@lucide/vue";
import ReportContext from "../chat/ReportContext.vue";
import type { Attachment } from "@/stores/composer";

defineProps<{
  attachments: Attachment[];
  uploadingCount: number;
  uploadError: string | null;
}>();

const emit = defineEmits<{
  (e: "remove", index: number): void;
}>();
</script>

<template>
  <div v-for="(a, i) in attachments" :key="'report-' + i">
    <div v-if="a.report" class="cron-context">
      <ReportContext :text="a.data" />
      <button type="button" aria-label="Remove attached Cron report" @click="emit('remove', i)">×</button>
    </div>
  </div>
  <div id="atts" aria-label="Attached files">
    <template v-for="(a, i) in attachments" :key="i">
      <div v-if="!a.report" class="composer-att-item">
        <img v-if="isRasterImage(a.mimeType)" :src="a.url" :alt="a.name || 'attachment'" />
        <div v-else class="composer-file-pill">
          <FileText :size="14" aria-hidden="true" />
          <span class="composer-file-name" :title="a.name">{{ a.name || 'File' }}</span>
          <span v-if="a.size !== undefined" class="composer-file-size">{{ formatFileSize(a.size) }}</span>
        </div>
        <button
          type="button"
          :aria-label="'Remove attachment ' + (a.name || (i + 1))"
          @click="emit('remove', i)"
        >
          ×
        </button>
      </div>
    </template>
    <div v-if="uploadingCount > 0" class="composer-uploading-pill" role="status" aria-live="polite">
      <Loader2 :size="14" class="spin" aria-hidden="true" />
      <span>Uploading ({{ uploadingCount }})…</span>
    </div>
  </div>

  <div
    v-if="uploadError"
    class="msg err composer-upload-error"
    role="alert"
  >
    {{ uploadError }}
  </div>
</template>

<style scoped>
.cron-context { display: flex; align-items: start; gap: 8px; margin-bottom: 8px; }
.cron-context > :first-child { flex: 1; }
.composer-att-item { display: inline-flex; align-items: center; position: relative; }
.composer-file-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 54px;
  padding: 0 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-width: 220px;
}
.composer-file-name {
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-file-size {
  font-size: 11px;
  color: var(--faint);
  flex: none;
}
.composer-uploading-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 54px;
  padding: 0 12px;
  background: var(--secondary);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--muted-foreground);
}
.composer-upload-error {
  margin: 6px 12px 0;
  font-size: 12px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
