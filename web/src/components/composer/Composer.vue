<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { ArrowUp, Square } from "@lucide/vue";
import { json } from "@/lib/api";
import { composer, addAttachment, removeAttachment, saveDraft, restoreDraft, submitDraft, retrySend } from "@/stores/composer";
import { chat, busy, sendDisabled, stopDisabled, stopRun } from "@/stores/chat";
import { history, loadProjects } from "@/stores/sessions";
import { modelLabel } from "@/stores/models";
import { boardChanged, focusInput } from "@/stores/app";
import ModelPicker from "./ModelPicker.vue";
import ReasoningControl from "./ReasoningControl.vue";

type Status = "todo" | "backlog" | "review" | "in_progress" | "done";
type Priority = "urgent" | "high" | "medium" | "low";
type MentionCard = {
  id: number;
  project: number;
  subject: string;
  description: string;
  status: Status;
  priority: Priority;
  owner: string | null;
  labels: string[];
  blockedBy: number[];
  archived: boolean;
};

const CATEGORY_ORDER: Status[] = ["todo", "backlog", "review", "in_progress", "done"];
const CATEGORY_LABEL: Record<Status, string> = {
  todo: "To do",
  backlog: "Backlog",
  review: "Review",
  in_progress: "In progress",
  done: "Done",
};
const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, medium: 1, low: 0 };

const inputRef = ref<HTMLTextAreaElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);
const mentionMenuRef = ref<HTMLElement | null>(null);
const pickerOpen = ref(false);

const boardCards = ref<MentionCard[]>([]);
const loadedPid = ref<number | null>(null);
const mentionMatch = ref<{ start: number; end: number; query: string } | null>(null);
const activeMentionIndex = ref(0);
let loadTicket = 0;

const activeProjectId = computed<number | null>(() => {
  if (chat.session) {
    const p = chat.project ?? history.list.find(s => String(s.id) === String(chat.session))?.project ?? null;
    return p ? Number(p) : null;
  }
  let saved = 0;
  try { saved = Number(localStorage.getItem("luna.project") || 0); } catch {}
  if (saved && history.projects.some(p => p.id === saved)) return saved;
  return history.projects[0]?.id ?? null;
});

async function fetchMentionCards(pid: number | null, force = false) {
  if (!pid) {
    boardCards.value = [];
    loadedPid.value = null;
    return;
  }
  if (!force && loadedPid.value === pid && boardCards.value.length > 0) return;
  const ticket = ++loadTicket;
  try {
    const data = await json<{ cards: MentionCard[] }>(`/v1/projects/${pid}/board`);
    if (ticket !== loadTicket) return;
    boardCards.value = data.cards || [];
    loadedPid.value = pid;
  } catch {
    if (ticket !== loadTicket) return;
  }
}

const sortedMentionItems = computed<MentionCard[]>(() => {
  const m = mentionMatch.value;
  if (!m) return [];
  const q = m.query.trim().toLowerCase();
  const isDigits = /^\d+$/.test(q);
  const filtered = boardCards.value.filter(c => {
    if (!q) return true;
    const idStr = String(c.id);
    if (isDigits) {
      return idStr.startsWith(q);
    }
    return idStr.startsWith(q) || c.subject.toLowerCase().includes(q) || c.labels.some(l => l.toLowerCase().includes(q));
  });
  return [...filtered].sort((a, b) => {
    const catDiff = CATEGORY_ORDER.indexOf(a.status) - CATEGORY_ORDER.indexOf(b.status);
    if (catDiff !== 0) return catDiff;
    const priDiff = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (priDiff !== 0) return priDiff;
    return a.id - b.id;
  });
});

const mentionGroups = computed(() => {
  const items = sortedMentionItems.value;
  const groups: { status: Status; label: string; items: { card: MentionCard; flatIndex: number }[] }[] = [];
  let flatIndex = 0;
  for (const status of CATEGORY_ORDER) {
    const inStatus = items.filter(c => c.status === status);
    if (!inStatus.length) continue;
    groups.push({
      status,
      label: CATEGORY_LABEL[status],
      items: inStatus.map(card => ({ card, flatIndex: flatIndex++ })),
    });
  }
  return groups;
});

const mentionOpen = computed(() => !!mentionMatch.value && !!activeProjectId.value && sortedMentionItems.value.length > 0);

function updateMentionState() {
  const el = inputRef.value;
  if (!el) {
    mentionMatch.value = null;
    return;
  }
  const text = el.value;
  const caret = el.selectionStart ?? text.length;
  const before = text.slice(0, caret);
  const m = /(?:^|[\s([{"'])#([^\s#]*)$/.exec(before);
  if (!m || !activeProjectId.value) {
    mentionMatch.value = null;
    return;
  }
  const query = m[1] || "";
  const hashStart = caret - query.length - 1;
  const prev = mentionMatch.value;
  mentionMatch.value = { start: hashStart, end: caret, query };
  if (!prev || prev.start !== hashStart) {
    void fetchMentionCards(activeProjectId.value, true);
  } else if (loadedPid.value !== activeProjectId.value || boardCards.value.length === 0) {
    void fetchMentionCards(activeProjectId.value, true);
  }
  if (!prev || prev.query !== query) {
    activeMentionIndex.value = 0;
  } else if (activeMentionIndex.value >= sortedMentionItems.value.length) {
    activeMentionIndex.value = Math.max(0, sortedMentionItems.value.length - 1);
  }
}

function selectMention(card: MentionCard) {
  const el = inputRef.value;
  const m = mentionMatch.value;
  if (!el || !m) return;
  const before = el.value.slice(0, m.start);
  const after = el.value.slice(m.end);
  const needsSpace = !after.startsWith(" ") && !after.startsWith("\n");
  const inserted = `#${card.id}${needsSpace ? " " : ""}`;
  const nextText = before + inserted + after;
  const nextCaret = before.length + inserted.length;
  el.value = nextText;
  composer.text = nextText;
  mentionMatch.value = null;
  grow();
  saveDraft();
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(nextCaret, nextCaret);
  });
}

function scrollActiveMentionIntoView() {
  void nextTick(() => {
    const activeEl = mentionMenuRef.value?.querySelector<HTMLElement>('[data-mention-active="true"]');
    activeEl?.scrollIntoView({ block: "nearest" });
  });
}

const hasDraft = computed(() => composer.text.trim().length > 0 || composer.attachments.length > 0);
const showStop = busy;
const sendHidden = computed(() => showStop.value && !hasDraft.value);

function grow() {
  if (!inputRef.value) return;
  inputRef.value.style.height = "auto";
  inputRef.value.style.height = Math.max(inputRef.value.scrollHeight + 2, 38) + "px";
}

function handleInput() {
  composer.text = inputRef.value?.value || "";
  grow();
  saveDraft();
  updateMentionState();
}

function handleKeydown(e: KeyboardEvent) {
  if (mentionOpen.value) {
    const total = sortedMentionItems.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeMentionIndex.value = (activeMentionIndex.value + 1) % total;
      scrollActiveMentionIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeMentionIndex.value = (activeMentionIndex.value - 1 + total) % total;
      scrollActiveMentionIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing) {
      const chosen = sortedMentionItems.value[activeMentionIndex.value];
      if (chosen) {
        e.preventDefault();
        selectMention(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mentionMatch.value = null;
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(max-width: 760px)").matches) {
    e.preventDefault();
    if (!sendDisabled.value) submitDraft();
  }
}

async function handleSubmit(e?: Event) {
  e?.preventDefault();
  mentionMatch.value = null;
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

watch(activeProjectId, (pid) => {
  void fetchMentionCards(pid, true);
}, { immediate: true });

watch(boardChanged, () => {
  if (activeProjectId.value) void fetchMentionCards(activeProjectId.value, true);
});

watch(() => chat.session, () => {
  mentionMatch.value = null;
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
  if (!newVal) mentionMatch.value = null;
});

watch(() => focusInput.value, () => {
  nextTick(() => {
    inputRef.value?.focus();
  });
});

function handleOutsideClick(e: MouseEvent) {
  if (!mentionMatch.value) return;
  const t = e.target as Node | null;
  if (t && (inputRef.value?.contains(t) || mentionMenuRef.value?.contains(t))) return;
  mentionMatch.value = null;
}

onMounted(() => {
  document.addEventListener("paste", handlePaste);
  document.addEventListener("pointerdown", handleOutsideClick);
  if (!history.projects.length) void loadProjects();
  if (activeProjectId.value) void fetchMentionCards(activeProjectId.value, true);
  restoreDraft();
  if (inputRef.value) {
    inputRef.value.value = composer.text;
  }
  nextTick(() => grow());
});

onUnmounted(() => {
  document.removeEventListener("paste", handlePaste);
  document.removeEventListener("pointerdown", handleOutsideClick);
});
</script>

<template>
  <div id="composer">
    <div
      v-if="mentionOpen"
      id="mention-menu"
      ref="mentionMenuRef"
      role="listbox"
      aria-label="Board items"
    >
      <div
        v-for="group in mentionGroups"
        :key="group.status"
        class="mention-group"
        :data-status="group.status"
      >
        <div class="mention-group-header">
          <span class="mention-status-dot" :data-status="group.status" aria-hidden="true"></span>
          <span>{{ group.label }}</span>
        </div>
        <button
          v-for="entry in group.items"
          :key="entry.card.id"
          type="button"
          role="option"
          class="mention-item"
          :class="{ active: entry.flatIndex === activeMentionIndex }"
          :aria-selected="entry.flatIndex === activeMentionIndex ? 'true' : 'false'"
          :data-mention-active="entry.flatIndex === activeMentionIndex ? 'true' : undefined"
          :data-card-id="entry.card.id"
          :data-status="entry.card.status"
          :data-priority="entry.card.priority"
          @mousedown.prevent="selectMention(entry.card)"
          @mouseenter="activeMentionIndex = entry.flatIndex"
        >
          <span
            class="mention-priority-dot"
            :data-priority="entry.card.priority"
            :title="'Priority: ' + entry.card.priority"
            aria-hidden="true"
          ></span>
          <span class="mention-id">#{{ entry.card.id }}</span>
          <span class="mention-subject">{{ entry.card.subject }}</span>
          <span class="mention-priority-label" :data-priority="entry.card.priority">{{ entry.card.priority }}</span>
        </button>
      </div>
    </div>

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
        @click="updateMentionState"
        @keyup="e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionState(); }"
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
          <ReasoningControl />
        </div>

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
            :disabled="sendDisabled || !hasDraft"
            v-show="!sendHidden"
          >
            <ArrowUp :size="18" aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>

    <ModelPicker @close="pickerOpen = false" />
  </div>
</template>
