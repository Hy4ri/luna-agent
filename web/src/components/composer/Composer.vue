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

type CommandCategory = "side" | "busy" | "session";
type SlashCommandItem = {
  id: string;
  insert: string;
  label: string;
  args?: string;
  description: string;
  category: CommandCategory;
};

const COMMAND_CATEGORY_ORDER: CommandCategory[] = ["side", "busy", "session"];
const COMMAND_CATEGORY_LABEL: Record<CommandCategory, string> = {
  side: "Side & Skills",
  busy: "Busy & Queue",
  session: "Turn Control",
};

const SLASH_COMMANDS: SlashCommandItem[] = [
  { id: "btw", insert: "/btw ", label: "/btw", args: "<question>", description: "Ask a side question without tools or main history", category: "side" },
  { id: "bg", insert: "/bg ", label: "/bg", args: "<prompt>", description: "Run a background task with tools in a side conversation", category: "side" },
  { id: "learn", insert: "/learn ", label: "/learn", args: "<source> [objective]", description: "Study a URL, repo, or file and record a skill", category: "side" },
  { id: "queue", insert: "/queue ", label: "/queue", args: "<message>", description: "Queue a follow-up message for the next turn", category: "busy" },
  { id: "steer", insert: "/steer ", label: "/steer", args: "<message>", description: "Steer the active turn after the current tool batch", category: "busy" },
  { id: "redirect", insert: "/redirect ", label: "/redirect", args: "<message>", description: "Interrupt and redirect the current model generation", category: "busy" },
  { id: "queue list", insert: "/queue list", label: "/queue list", description: "List queued follow-up messages", category: "busy" },
  { id: "queue edit", insert: "/queue edit ", label: "/queue edit", args: "<N> <text>", description: "Edit queued message N", category: "busy" },
  { id: "queue remove", insert: "/queue remove ", label: "/queue remove", args: "<N>", description: "Remove queued message N", category: "busy" },
  { id: "queue move", insert: "/queue move ", label: "/queue move", args: "<A> <B>", description: "Move queued message A to position B", category: "busy" },
  { id: "queue clear", insert: "/queue clear", label: "/queue clear", description: "Clear all queued messages", category: "busy" },
  { id: "stop", insert: "/stop", label: "/stop", description: "Stop the active turn immediately", category: "session" },
];

const inputRef = ref<HTMLTextAreaElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);
const mentionMenuRef = ref<HTMLElement | null>(null);
const commandMenuRef = ref<HTMLElement | null>(null);
const pickerOpen = ref(false);

const boardCards = ref<MentionCard[]>([]);
const loadedPid = ref<number | null>(null);
const mentionMatch = ref<{ start: number; end: number; query: string } | null>(null);
const activeMentionIndex = ref(0);
const commandMatch = ref<{ start: number; end: number; query: string } | null>(null);
const activeCommandIndex = ref(0);
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

const sortedCommandItems = computed<SlashCommandItem[]>(() => {
  const m = commandMatch.value;
  if (!m) return [];
  const q = m.query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(cmd => {
    if (cmd.id.startsWith(q) || cmd.label.slice(1).startsWith(q)) return true;
    const words = cmd.id.split(" ");
    if (!q.includes(" ") && words.some(w => w.startsWith(q))) return true;
    return false;
  });
});

const commandGroups = computed(() => {
  const items = sortedCommandItems.value;
  const groups: { category: CommandCategory; label: string; items: { cmd: SlashCommandItem; flatIndex: number }[] }[] = [];
  let flatIndex = 0;
  for (const category of COMMAND_CATEGORY_ORDER) {
    const inCat = items.filter(c => c.category === category);
    if (!inCat.length) continue;
    groups.push({
      category,
      label: COMMAND_CATEGORY_LABEL[category],
      items: inCat.map(cmd => ({ cmd, flatIndex: flatIndex++ })),
    });
  }
  return groups;
});

const commandOpen = computed(() => !mentionOpen.value && !!commandMatch.value && sortedCommandItems.value.length > 0);

function updateCommandState() {
  const el = inputRef.value;
  if (!el) {
    commandMatch.value = null;
    return;
  }
  const text = el.value;
  const caret = el.selectionStart ?? text.length;
  const before = text.slice(0, caret);
  const lead = /^(\s*)\/([^\n]*)$/.exec(before);
  if (!lead) {
    commandMatch.value = null;
    return;
  }
  const rawAfterSlash = lead[2] || "";
  const slashStart = (lead[1] || "").length;
  const tokens = rawAfterSlash.trimStart().split(/\s+/).filter(Boolean);
  const firstToken = (tokens[0] || "").toLowerCase();
  const hasTrailingSpace = /\s$/.test(rawAfterSlash);

  if (firstToken === "queue") {
    const subToken = (tokens[1] || "").toLowerCase();
    if (tokens.length > 2 || (tokens.length === 2 && hasTrailingSpace)) {
      commandMatch.value = null;
      return;
    }
    if (tokens.length === 2 && !["list", "edit", "remove", "move", "clear"].some(s => s.startsWith(subToken))) {
      commandMatch.value = null;
      return;
    }
  } else if (tokens.length > 1 || (tokens.length === 1 && hasTrailingSpace)) {
    commandMatch.value = null;
    return;
  }

  const query = rawAfterSlash.replace(/\s+/g, " ");
  const prev = commandMatch.value;
  commandMatch.value = { start: slashStart, end: caret, query };
  if (!prev || prev.query !== query) {
    activeCommandIndex.value = 0;
  } else if (activeCommandIndex.value >= sortedCommandItems.value.length) {
    activeCommandIndex.value = Math.max(0, sortedCommandItems.value.length - 1);
  }
}

function selectCommand(cmd: SlashCommandItem) {
  const el = inputRef.value;
  const m = commandMatch.value;
  if (!el || !m) return;
  const before = el.value.slice(0, m.start);
  const after = el.value.slice(m.end).replace(/^\s+/, "");
  const inserted = cmd.insert;
  const nextText = before + inserted + (after ? (inserted.endsWith(" ") ? after : " " + after) : "");
  const nextCaret = before.length + inserted.length;
  el.value = nextText;
  composer.text = nextText;
  commandMatch.value = null;
  grow();
  saveDraft();
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(nextCaret, nextCaret);
  });
}

function scrollActiveCommandIntoView() {
  void nextTick(() => {
    const activeEl = commandMenuRef.value?.querySelector<HTMLElement>('[data-command-active="true"]');
    activeEl?.scrollIntoView({ block: "nearest" });
  });
}

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
  updateCommandState();
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
  if (commandOpen.value) {
    const total = sortedCommandItems.value.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value + 1) % total;
      scrollActiveCommandIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value - 1 + total) % total;
      scrollActiveCommandIntoView();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing) {
      const chosen = sortedCommandItems.value[activeCommandIndex.value];
      if (chosen) {
        e.preventDefault();
        selectCommand(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      commandMatch.value = null;
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
  commandMatch.value = null;
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
  commandMatch.value = null;
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
  if (!newVal) {
    mentionMatch.value = null;
    commandMatch.value = null;
  }
});

watch(() => focusInput.value, () => {
  nextTick(() => {
    inputRef.value?.focus();
  });
});

function handleOutsideClick(e: MouseEvent) {
  if (!mentionMatch.value && !commandMatch.value) return;
  const t = e.target as Node | null;
  if (t && (inputRef.value?.contains(t) || mentionMenuRef.value?.contains(t) || commandMenuRef.value?.contains(t))) return;
  mentionMatch.value = null;
  commandMatch.value = null;
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

    <div
      v-if="commandOpen"
      id="command-menu"
      ref="commandMenuRef"
      role="listbox"
      aria-label="Slash commands"
    >
      <div
        v-for="group in commandGroups"
        :key="group.category"
        class="mention-group command-group"
        :data-category="group.category"
      >
        <div class="mention-group-header">
          <span class="command-category-dot" :data-category="group.category" aria-hidden="true"></span>
          <span>{{ group.label }}</span>
        </div>
        <button
          v-for="entry in group.items"
          :key="entry.cmd.id"
          type="button"
          role="option"
          class="mention-item command-item"
          :class="{ active: entry.flatIndex === activeCommandIndex }"
          :aria-selected="entry.flatIndex === activeCommandIndex ? 'true' : 'false'"
          :data-command-active="entry.flatIndex === activeCommandIndex ? 'true' : undefined"
          :data-command="entry.cmd.id"
          :data-category="entry.cmd.category"
          @mousedown.prevent="selectCommand(entry.cmd)"
          @mouseenter="activeCommandIndex = entry.flatIndex"
        >
          <span class="command-name">{{ entry.cmd.label }}</span>
          <span v-if="entry.cmd.args" class="command-args">{{ entry.cmd.args }}</span>
          <span class="command-desc">{{ entry.cmd.description }}</span>
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
        @click="() => { updateMentionState(); updateCommandState(); }"
        @keyup="e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { updateMentionState(); updateCommandState(); } }"
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
