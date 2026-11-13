<script setup lang="ts">
import { ref, computed } from "vue";
import { ArrowUp, Square, Camera, ChevronDown } from "@lucide/vue";
import { json, post } from "@/lib/api";
import { composer, removeAttachment, saveDraft, submitDraft, retrySend } from "@/stores/composer";
import { chat, busy, sendDisabled, stopDisabled, stopRun, addErr } from "@/stores/chat";
import { history } from "@/stores/sessions";
import { modelLabel, modelTitle } from "@/stores/models";
import { captureBackgroundSend } from "@/stores/background-send";
import BackgroundSendStatus from "./BackgroundSendStatus.vue";
import SchedulePicker from "./SchedulePicker.vue";
import { revealSchedules } from "@/stores/scheduled-messages";
import ModelPicker from "./ModelPicker.vue";
import ReasoningControl from "./ReasoningControl.vue";
import ComposerUsage from "./ComposerUsage.vue";
import ComposerAttachments from "./ComposerAttachments.vue";
import ComposerMentionMenu from "./ComposerMentionMenu.vue";
import ComposerCommandMenu from "./ComposerCommandMenu.vue";
import ComposerAtMenu from "./ComposerAtMenu.vue";
import type { MentionCard } from "./types";
import { useComposerAutocomplete } from "./useComposerAutocomplete";
import { useComposerLifecycle } from "./useComposerLifecycle";

const inputRef = ref<HTMLTextAreaElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);
const cameraRef = ref<HTMLInputElement | null>(null);
const mentionMenuComp = ref<InstanceType<typeof ComposerMentionMenu> | null>(null);
const commandMenuComp = ref<InstanceType<typeof ComposerCommandMenu> | null>(null);
const atMenuComp = ref<InstanceType<typeof ComposerAtMenu> | null>(null);
const pickerOpen = ref(false);

const boardCards = ref<MentionCard[]>([]);
const loadedPid = ref<number | null>(null);
const mentionCardError = ref("");
let loadTicket = 0;

const activeProjectId = computed<number | null>(() => {
  if (chat.session) {
    const p = chat.project ?? history.list.find(s => String(s.id) === String(chat.session))?.project ?? null;
    return p !== null ? Number(p) : null;
  }
  if (chat.project !== null) return Number(chat.project);
  let saved = 0;
  try { saved = Number(localStorage.getItem("luna.project") || 0); } catch {}
  if (history.projects.some(p => p.id === saved)) return saved;
  return history.projects[0]?.id ?? null;
});

function grow() {
  if (!inputRef.value) return;
  inputRef.value.style.height = "auto";
  inputRef.value.style.height = Math.max(inputRef.value.scrollHeight + 2, 38) + "px";
}

async function fetchMentionCards(pid: number | null, force = false) {
  if (!force && pid !== null && loadedPid.value === pid && boardCards.value.length > 0) return;
  const ticket = ++loadTicket;
  if (pid === null) {
    boardCards.value = [];
    loadedPid.value = null;
    mentionCardError.value = "";
    return;
  }
  try {
    const data = await json<{ cards: MentionCard[] }>(`/v1/projects/${pid}/board`);
    if (ticket !== loadTicket) return;
    boardCards.value = data.cards || [];
    loadedPid.value = pid;
    mentionCardError.value = "";
  } catch {
    if (ticket !== loadTicket) return;
    mentionCardError.value = "could not load cards";
  }
}

const {
  mentionMatch,
  activeMentionIndex,
  commandMatch,
  activeCommandIndex,
  sortedMentionItems,
  mentionGroups,
  mentionOpen,
  sortedCommandItems,
  commandGroups,
  commandOpen,
  atGroups,
  atItems,
  atOpen,
  activeAtIndex,
  updateAtState,
  selectAt,
  updateCommandState,
  selectCommand,
  updateMentionState,
  selectMention,
  clearMatches,
} = useComposerAutocomplete({
  inputRef,
  boardCards,
  loadedPid,
  activeProjectId,
  mentionCardError,
  fetchMentionCards,
  grow,
  chat,
});

const { handleFileChange, handleDrop } = useComposerLifecycle({
  inputRef,
  activeProjectId,
  mentionOpen,
  fetchMentionCards,
  grow,
  clearMatches,
  getMenuEls: () => [
    mentionMenuComp.value?.menuRef ?? null,
    commandMenuComp.value?.menuRef ?? null,
    atMenuComp.value?.menuRef ?? null,
  ],
  fileRef,
  cameraRef,
});

const hasDraft = computed(() => composer.text.trim().length > 0 || composer.attachments.length > 0 || composer.uploadingCount > 0);
const isSendDisabled = computed(() => sendDisabled.value || composer.capturingBackground || composer.uploadingCount > 0 || !hasDraft.value);
const showStop = busy;
const sendHidden = computed(() => showStop.value && !hasDraft.value);

function handleInput() {
  composer.text = inputRef.value?.value || "";
  grow();
  saveDraft();
  updateMentionState();
  updateCommandState();
  updateAtState();
}

const schedulePickerOpen = ref(false);
const scheduleMessageText = ref("");
let scheduleDraft = "";
function scheduleSaved() {
  // Clear only the draft explicitly scheduled, never a newer draft or an edited bubble.
  if (composer.text === scheduleDraft) { composer.text = ""; saveDraft(); grow(); }
}

/** Run client-side commands (/compact, /models, /schedule <message>); returns true when handled. */
function runLocalCommand(): boolean {
  const trimmed = composer.text.trim();
  const schedMatch = /^\/schedule\s+([\s\S]+)$/.exec(trimmed);
  if (trimmed === "/schedule list") { revealSchedules(); return true; }
  if (trimmed === "/schedule") { addErr("Usage: /schedule <message>, /schedule list, or /schedule cancel <id>."); return true; }
  if (schedMatch && schedMatch[1] !== "list" && !/^cancel\s+\S+$/.test(schedMatch[1])) {
    if (!chat.session) {
      addErr("/schedule needs an open session.");
      return true;
    }
    if (composer.attachments.length) { addErr("Scheduled messages are text only. Remove attachments first."); return true; }
    scheduleMessageText.value = schedMatch[1].trim();
    scheduleDraft = composer.text;
    schedulePickerOpen.value = true;
    return true;
  }
  const cmd = /^\/(compact|compress|models?)$/.exec(trimmed)?.[1];
  if (!cmd) return false;
  composer.text = ""; saveDraft();
  if (cmd.startsWith("model")) {
    document.getElementById("model-picker")?.showPopover?.();
  } else if (!chat.session) {
    addErr("/compact needs an open session.");
  } else if (busy.value) {
    addErr("/compact is not available while busy.");
  } else {
    post(`/v1/sessions/${chat.session}/compact`).catch(error => addErr((error as Error).message));
  }
  return true;
}

function submit() {
  if (composer.capturingBackground || schedulePickerOpen.value) return;
  if (!runLocalCommand()) submitDraft();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;

  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.repeat || e.shiftKey || e.altKey) return;
    void captureBackgroundSend(activeProjectId.value).then(captured => {
      if (captured && !composer.text) { clearMatches(); grow(); }
    }).catch(error => addErr((error as Error).message));
    return;
  }

  if (mentionOpen.value) {
    const total = sortedMentionItems.value.length;
    if (e.key === "ArrowDown" && total > 0) {
      e.preventDefault();
      activeMentionIndex.value = (activeMentionIndex.value + 1) % total;
      mentionMenuComp.value?.scrollActiveIntoView();
      return;
    }
    if (e.key === "ArrowUp" && total > 0) {
      e.preventDefault();
      activeMentionIndex.value = (activeMentionIndex.value - 1 + total) % total;
      mentionMenuComp.value?.scrollActiveIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      const chosen = sortedMentionItems.value[activeMentionIndex.value];
      if (chosen) {
        e.preventDefault();
        selectMention(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      mentionMatch.value = null;
      return;
    }
  }
  if (commandOpen.value) {
    const total = sortedCommandItems.value.length;
    if (e.key === "ArrowDown" && total > 0) {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value + 1) % total;
      commandMenuComp.value?.scrollActiveIntoView();
      return;
    }
    if (e.key === "ArrowUp" && total > 0) {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value - 1 + total) % total;
      commandMenuComp.value?.scrollActiveIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      const chosen = sortedCommandItems.value[activeCommandIndex.value];
      if (chosen) {
        e.preventDefault();
        selectCommand(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      commandMatch.value = null;
      return;
    }
  }
  if (atOpen.value) {
    const total = atItems.value.length;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && total > 0) {
      e.preventDefault();
      activeAtIndex.value = (activeAtIndex.value + (e.key === "ArrowDown" ? 1 : total - 1)) % total;
      atMenuComp.value?.scrollActiveIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      const chosen = atItems.value[activeAtIndex.value];
      if (chosen) { e.preventDefault(); selectAt(chosen); return; }
      if (e.key === "Enter") { e.preventDefault(); return; }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      clearMatches();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !matchMedia("(max-width: 760px)").matches) {
    e.preventDefault();
    if (!sendDisabled.value) submit();
  }
}

async function handleSubmit(e?: Event) {
  e?.preventDefault();
  clearMatches();
  if (!sendDisabled.value) submit();
}
</script>

<template>
  <div id="composer">
    <ComposerMentionMenu
      v-if="mentionOpen"
      ref="mentionMenuComp"
      :mention-groups="mentionGroups"
      :active-mention-index="activeMentionIndex"
      :error-message="mentionCardError"
      @select="selectMention"
      @update:active-mention-index="activeMentionIndex = $event"
    />

    <ComposerCommandMenu
      v-if="commandOpen"
      ref="commandMenuComp"
      :command-groups="commandGroups"
      :active-command-index="activeCommandIndex"
      @select="selectCommand"
      @update:active-command-index="activeCommandIndex = $event"
    />

    <ComposerAtMenu
      v-if="atOpen"
      ref="atMenuComp"
      :at-groups="atGroups"
      :active-at-index="activeAtIndex"
      @select="selectAt"
      @update:active-at-index="activeAtIndex = $event"
    />

    <ComposerAttachments
      :attachments="composer.attachments"
      :uploading-count="composer.uploadingCount"
      :upload-error="composer.uploadError"
      @remove="removeAttachment"
    />

    <!-- Send error banner / Retry send -->
    <div v-if="chat.session && composer.sendErrors.has(chat.session)" class="msg err send-error">
      <p>Send not confirmed: {{ composer.sendErrors.get(chat.session)?.message }}</p>
      <button type="button" :disabled="composer.submitting.has(chat.session)" @click="retrySend">Retry send</button>
    </div>

    <BackgroundSendStatus />

    <form id="form" @submit="handleSubmit" @drop="handleDrop" @dragover.prevent>
      <textarea
        id="input"
        dir="auto"
        ref="inputRef"
        rows="1"
        placeholder="Message Luna…"
        aria-label="Message Luna"
        aria-description="Ctrl+Enter or Command+Enter sends to a new session without opening it."
        title="Ctrl/Cmd+Enter: send to a new session without opening it"
        @input="handleInput"
        @keydown="handleKeydown"
        @click="() => { updateMentionState(); updateCommandState(); updateAtState(); }"
        @keyup="e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { updateMentionState(); updateCommandState(); updateAtState(); } }"
      ></textarea>

      <div class="compose-bar">
        <button
          type="button"
          id="attach"
          class="icon-button"
          title="Attach files"
          aria-label="Attach files"
          @click="fileRef?.click()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3"/></svg>
        </button>
        <button
          type="button"
          id="camera"
          class="icon-button"
          title="Take photo"
          aria-label="Take photo"
          @click="cameraRef?.click()"
        >
          <Camera :size="18" aria-hidden="true" />
        </button>
        <input
          type="file"
          id="camera-file"
          ref="cameraRef"
          accept="image/*"
          capture="environment"
          hidden
          @change="handleFileChange"
        />
        <input
          type="file"
          id="file"
          ref="fileRef"
          multiple
          hidden
          @change="handleFileChange"
        />

        <div id="controls">
          <button
            id="model"
            type="button"
            popovertarget="model-picker"
            aria-controls="model-picker"
            aria-haspopup="dialog"
            :aria-expanded="pickerOpen ? 'true' : 'false'"
            :aria-label="`Model: ${modelLabel}`"
            :title="modelTitle"
          >
            <span class="model-label-text">{{ modelLabel }}</span>
            <ChevronDown :size="14" aria-hidden="true" class="model-chevron" />
          </button>
          <ReasoningControl />
        </div>

        <ComposerUsage />

        <div class="compose-actions">
          <button
            v-if="showStop"
            id="stop"
            type="button"
            class="icon-button"
            aria-label="Stop"
            title="Stop"
            :disabled="stopDisabled"
            @click="stopRun"
          >
            <Square :size="16" aria-hidden="true" />
          </button>

          <button
            id="send"
            type="submit"
            class="icon-button primary"
            aria-label="Send"
            title="Send"
            :disabled="isSendDisabled"
            v-show="!sendHidden"
          >
            <ArrowUp :size="18" aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>

    <ModelPicker @open="pickerOpen = true" @close="pickerOpen = false" />
    <SchedulePicker :open="schedulePickerOpen" :content="scheduleMessageText" @close="schedulePickerOpen = false" @saved="scheduleSaved" />
  </div>
</template>

<style scoped>
#composer:focus-within {
  border-color: color-mix(in srgb, var(--primary) 65%, var(--border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 24%, transparent);
}

#model {
  min-height: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
}

#model:hover,
#model[aria-expanded="true"] {
  background: var(--secondary);
  border-color: var(--border);
  color: var(--foreground);
}

#model:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

@media (max-width: 760px), (pointer: coarse) {
  .compose-bar {
    flex-wrap: wrap;
    row-gap: 6px;
    column-gap: 6px;
  }

  #attach,
  #camera,
  #send,
  #stop {
    min-width: 44px;
    min-height: 44px;
    width: 44px;
    height: 44px;
  }

  #controls {
    flex: 1 1 180px;
    min-width: 0;
    flex-wrap: nowrap;
    gap: 4px;
  }

  #model {
    min-height: 44px;
    height: 44px;
    flex: 0 1 auto;
    min-width: 0;
    max-width: min(190px, 100%);
    padding: 0 8px;
  }

  #composer :deep(#atts button) {
    min-width: 28px;
    min-height: 28px;
    width: 28px;
    height: 28px;
  }

  #composer :deep(#atts button)::after {
    content: "";
    position: absolute;
    inset: -8px;
  }
}
</style>
