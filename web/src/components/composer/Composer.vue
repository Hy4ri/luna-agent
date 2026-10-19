<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { composer, addAttachment, removeAttachment, saveDraft, restoreDraft, submitDraft, retrySend } from "@/stores/composer";
import { chat, sendDisabled, openSession, newSession } from "@/stores/chat";
import { models, modelLabel, selectedKey, chooseModel, setThinking, modelKey, togglePin, setSelectedModel } from "@/stores/models";
import { focusInput } from "@/stores/app";
import ModelPicker from "./ModelPicker.vue";

const inputRef = ref<HTMLTextAreaElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);
const pickerOpen = ref(false);

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function grow() {
  if (!inputRef.value) return;
  inputRef.value.style.height = "auto";
  inputRef.value.style.height = Math.max(inputRef.value.scrollHeight + 2, 38) + "px";
}

function handleInput() {
  composer.text = inputRef.value?.value || "";
  grow();
  saveDraft();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(max-width: 760px)").matches) {
    e.preventDefault();
    if (!sendDisabled.value) submitDraft();
  }
}

async function handleSubmit(e?: Event) {
  e?.preventDefault();
  if (!sendDisabled.value) submitDraft();
}

async function handleFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const f of files) {
    await addAttachment(f);
  }
  if (fileRef.value) fileRef.value.value = "";
}

function handlePaste(e: ClipboardEvent) {
  for (const it of e.clipboardData?.items || []) {
    if (it.type.startsWith("image/")) {
      e.preventDefault();
      const file = it.getAsFile();
      if (file) addAttachment(file);
    }
  }
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const f of files) {
    if (f.type.startsWith("image/") || f.type.startsWith("audio/")) {
      addAttachment(f);
    }
  }
}

async function handleThinkChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  await setThinking(val);
}

watch(() => chat.session, () => {
  restoreDraft();
  if (inputRef.value) {
    inputRef.value.value = composer.text;
  }
  nextTick(() => grow());
});

watch(() => composer.text, (newVal) => {
  if (inputRef.value && inputRef.value.value !== newVal) {
    inputRef.value.value = newVal;
    grow();
  }
});

watch(() => focusInput.value, () => {
  nextTick(() => {
    inputRef.value?.focus();
  });
});

onMounted(() => {
  document.addEventListener("paste", handlePaste);
  restoreDraft();
  if (inputRef.value) {
    inputRef.value.value = composer.text;
  }
  nextTick(() => grow());
});

onUnmounted(() => {
  document.removeEventListener("paste", handlePaste);
});
</script>

<template>
  <div id="composer">
    <div id="atts" aria-label="Attached images">
      <div v-for="(a, i) in composer.attachments" :key="i">
        <span v-if="a.mimeType.startsWith('audio/')">Audio attachment</span>
        <img v-else :src="a.url" alt="attachment" />
        <button
          type="button"
          :aria-label="'Remove attached image ' + (i + 1)"
          @click="removeAttachment(i)"
        >
          ×
        </button>
      </div>
    </div>

    <div
      id="busyFeedback"
      class="muted"
      role="status"
      aria-live="polite"
      v-show="chat.busyFeedback"
    >
      {{ chat.busyFeedback }}
    </div>

    <!-- Send error banner / Retry send -->
    <div v-if="chat.session && composer.sendErrors.has(chat.session)" class="msg err send-error">
      <p>Send not confirmed: {{ composer.sendErrors.get(chat.session)?.message }}</p>
      <button type="button" :disabled="composer.submitting.has(chat.session)" @click="retrySend">Retry send</button>
    </div>

    <form id="form" @submit="handleSubmit" @drop="handleDrop" @dragover.prevent>
      <textarea
        id="input"
        ref="inputRef"
        rows="1"
        placeholder="Message Luna…"
        aria-label="Message Luna"
        @input="handleInput"
        @keydown="handleKeydown"
      ></textarea>

      <div class="compose-bar">
        <button
          type="button"
          id="attach"
          class="icon-button"
          title="Attach images or audio"
          aria-label="Attach images or audio"
          @click="fileRef?.click()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3"/></svg>
        </button>
        <input
          type="file"
          id="file"
          ref="fileRef"
          accept="image/png,image/jpeg,image/gif,image/webp,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/flac"
          multiple
          hidden
          @change="handleFileChange"
        />

        <div id="controls">
          <button
            id="model"
            type="button"
            popovertarget="model-picker"
            :aria-expanded="pickerOpen ? 'true' : 'false'"
            aria-label="Model"
            @click="pickerOpen = !pickerOpen"
          >
            {{ modelLabel }}
          </button>
          <select
            id="think"
            aria-label="Thinking level"
            title="Thinking level"
            :value="models.thinking"
            @change="handleThinkChange"
          >
            <option v-for="l in LEVELS" :key="l" :value="l">
              {{ l === "off" ? "Off" : l.charAt(0).toUpperCase() + l.slice(1) }}
            </option>
          </select>
        </div>

        <span class="compose-hint">Enter to send · Shift+Enter for a new line</span>

        <button
          id="send"
          type="submit"
          class="primary"
          aria-label="Send"
          :disabled="sendDisabled"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
          <span>Send</span>
        </button>
      </div>
    </form>

    <ModelPicker @close="pickerOpen = false" />
  </div>
</template>
